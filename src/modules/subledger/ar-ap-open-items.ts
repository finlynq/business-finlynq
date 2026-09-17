import "server-only";

import { withTenantTransaction } from "@/db/transaction";
import { assertPermission, permissionForOwner } from "./ar-ap-access";
import type {
  ListPayableOpenItemsCommand,
  PayableOpenItemRecord,
  PayableOpenItemStatus,
  SourceDocumentStatus,
} from "./ar-ap-types";

const payableOpenItemStatuses = new Set<PayableOpenItemStatus>([
  "OPEN",
  "PARTIALLY_SETTLED",
  "SETTLED",
  "REVERSED",
]);

function normalizedDate(value: string | undefined): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("As-of date must use YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("As-of date must be a valid calendar date");
  }
  return value;
}

export async function listPayableOpenItems(
  command: ListPayableOpenItemsCommand,
): Promise<readonly PayableOpenItemRecord[]> {
  const sourceNumber = command.sourceNumber?.trim().toUpperCase() || null;
  const currency = command.currency?.trim().toUpperCase() || null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must use a three-letter code");
  const asOfDate = normalizedDate(command.asOfDate);
  const statuses = command.statuses ?? ["OPEN", "PARTIALLY_SETTLED"];
  if (statuses.length === 0 || statuses.some((status) => !payableOpenItemStatuses.has(status))) {
    throw new Error("At least one valid payable open-item status is required");
  }
  const limit = Math.min(Math.max(command.limit ?? 100, 1), 500);

  return withTenantTransaction(command.context, async (client) => {
    await assertPermission(client, command.context, permissionForOwner("payables", "read"));
    const result = await client.query<{
      open_item_id: string;
      source_number: string;
      source_document_id: string;
      source_document_version: number;
      document_status: SourceDocumentStatus;
      legal_entity_id: string;
      ledger_id: string;
      party_account_id: string;
      control_account_combination_id: string;
      currency: string;
      original_amount: string;
      allocated_amount: string;
      remaining_amount: string;
      document_date: string;
      due_date: string | null;
      settlement_status: PayableOpenItemStatus;
    }>(
      `WITH payable_items AS (
         SELECT item.id AS open_item_id,
           issued_source.source_number,
           current_source.id AS source_document_id,
           current_source.version AS source_document_version,
           current_source.status AS document_status,
           issued_source.legal_entity_id,
           item.ledger_id,
           item.party_account_id,
           issued_source.snapshot->>'controlAccountCombinationId' AS control_account_combination_id,
           item.transaction_currency AS currency,
           item.original_transaction_amount::text AS original_amount,
           allocation.allocated_amount::text,
           CASE WHEN void_event.id IS NOT NULL THEN '0'
             ELSE greatest(item.original_transaction_amount - allocation.allocated_amount, 0)::text
           END AS remaining_amount,
           issued_source.snapshot->>'documentDate' AS document_date,
           item.due_on::text AS due_date,
           CASE
             WHEN void_event.id IS NOT NULL THEN 'REVERSED'
             WHEN allocation.allocated_amount = 0 THEN 'OPEN'
             WHEN allocation.allocated_amount >= item.original_transaction_amount THEN 'SETTLED'
             ELSE 'PARTIALLY_SETTLED'
           END AS settlement_status
         FROM open_items item
         JOIN subledger_events event
           ON event.organization_id = item.organization_id
          AND event.id = item.source_event_id
         JOIN source_documents issued_source
           ON issued_source.organization_id = event.organization_id
          AND issued_source.id = event.source_document_id
          AND issued_source.owner_module = 'payables'
          AND issued_source.source_type = 'payables.supplier-bill'
          AND issued_source.status = 'POSTED'
         JOIN party_accounts party_account
           ON party_account.organization_id = item.organization_id
          AND party_account.id = item.party_account_id
          AND party_account.ledger_id = item.ledger_id
          AND party_account.legal_entity_id = issued_source.legal_entity_id
          AND party_account.role = 'SUPPLIER'
         JOIN ledgers ledger
           ON ledger.organization_id = item.organization_id
          AND ledger.id = item.ledger_id
          AND ledger.legal_entity_id = issued_source.legal_entity_id
         JOIN LATERAL (
           SELECT current.id, current.version, current.status
           FROM source_documents current
           WHERE current.organization_id = issued_source.organization_id
             AND current.owner_module = issued_source.owner_module
             AND current.source_type = issued_source.source_type
             AND current.source_number = issued_source.source_number
             AND current.legal_entity_id = issued_source.legal_entity_id
           ORDER BY current.version DESC, current.created_at DESC, current.id DESC
           LIMIT 1
         ) current_source ON true
         LEFT JOIN LATERAL (
           SELECT coalesce(sum(CASE selected.allocation_type
             WHEN 'APPLY' THEN selected.transaction_amount
             ELSE -selected.transaction_amount END), 0)::numeric(38,9) AS allocated_amount
           FROM document_settlement_allocations selected
           WHERE selected.organization_id = item.organization_id
             AND selected.open_item_id = item.id
             AND ($8::date IS NULL OR selected.created_at::date <= $8::date)
         ) allocation ON true
         LEFT JOIN open_item_void_events void_event
           ON void_event.organization_id = item.organization_id
          AND void_event.open_item_id = item.id
          AND ($8::date IS NULL OR void_event.created_at::date <= $8::date)
         WHERE item.organization_id = $1
           AND ($2::uuid IS NULL OR issued_source.legal_entity_id = $2::uuid)
           AND ($3::uuid IS NULL OR item.ledger_id = $3::uuid)
           AND ($4::uuid IS NULL OR item.party_account_id = $4::uuid)
           AND ($5::uuid IS NULL OR current_source.id = $5::uuid OR issued_source.id = $5::uuid)
           AND ($6::text IS NULL OR issued_source.source_number = $6::text)
           AND ($7::text IS NULL OR item.transaction_currency = $7::text)
           AND ($8::date IS NULL OR item.created_at::date <= $8::date)
       )
       SELECT * FROM payable_items
       WHERE settlement_status = ANY($9::text[])
       ORDER BY due_date NULLS LAST, source_number, open_item_id
       LIMIT $10`,
      [
        command.context.organizationId,
        command.legalEntityId ?? null,
        command.ledgerId ?? null,
        command.partyAccountId ?? null,
        command.sourceDocumentId ?? null,
        sourceNumber,
        currency,
        asOfDate,
        statuses,
        limit,
      ],
    );
    return result.rows.map((row) => ({
      openItemId: row.open_item_id,
      sourceNumber: row.source_number,
      sourceDocumentId: row.source_document_id,
      sourceDocumentVersion: row.source_document_version,
      documentStatus: row.document_status,
      legalEntityId: row.legal_entity_id,
      ledgerId: row.ledger_id,
      partyAccountId: row.party_account_id,
      controlAccountCombinationId: row.control_account_combination_id,
      currency: row.currency,
      originalAmount: row.original_amount,
      allocatedAmount: row.allocated_amount,
      remainingAmount: row.remaining_amount,
      documentDate: row.document_date,
      dueDate: row.due_date,
      settlementStatus: row.settlement_status,
    }));
  });
}
