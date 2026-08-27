import "server-only";
import { demoAccountingDate } from "@/modules/demo/accounting-clock";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import {
  actorHasActivePermission,
  assertActorHasActivePermission,
} from "@/modules/identity/authorization";
import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import { transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";

function readContext(principal: SessionPrincipal): TenantTransactionContext {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    requestId: `report:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI",
    sessionMode: principal.sessionMode,
  };
}

async function assertReportPermission(
  client: PoolClient,
  principal: SessionPrincipal,
  permission: Permission,
): Promise<void> {
  await assertActorHasActivePermission(client, {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    permission,
  });
}

export type EntitySummary = Readonly<{
  id: string;
  code: string;
  displayName: string;
  countryCode: string;
  regionCode: string;
  accountingProfile: string;
  ledgerId: string;
  ledgerCode: string;
  functionalCurrency: string;
  periodLabel: string | null;
  periodState: string | null;
}>;

export async function loadEntitySummaries(principal: SessionPrincipal): Promise<readonly EntitySummary[]> {
  return withWorkspaceTenantRead(readContext(principal), "/app/entities", async (client) => {
    await assertReportPermission(client, principal, PERMISSIONS.readMcpLedger);
    const asOfDate = principal.sessionMode === "demo"
      ? demoAccountingDate()
      : new Date().toISOString().slice(0, 10);
    const result = await client.query<{
      id: string; code: string; display_name: string; country_code: string; region_code: string;
      accounting_profile: string; ledger_id: string; ledger_code: string; functional_currency: string;
      period_label: string | null; period_state: string | null;
    }>(
      `SELECT entity.id, entity.code, entity.display_name, entity.country_code,
         entity.region_code, ledger.accounting_profile, ledger.id AS ledger_id,
         ledger.code AS ledger_code, ledger.functional_currency,
         current_period.label AS period_label, current_period.state::text AS period_state
       FROM legal_entities entity
       JOIN ledgers ledger ON ledger.organization_id = entity.organization_id
         AND ledger.legal_entity_id = entity.id AND ledger.kind = 'PRIMARY' AND ledger.active
       LEFT JOIN LATERAL (
         SELECT period.label, period.state
         FROM fiscal_periods period
         WHERE period.organization_id = entity.organization_id AND period.ledger_id = ledger.id
         ORDER BY ($2::date BETWEEN period.starts_on AND period.ends_on) DESC,
           period.starts_on DESC LIMIT 1
       ) current_period ON true
       WHERE entity.organization_id = $1 AND entity.active
       ORDER BY entity.code`,
      [principal.organizationId, asOfDate],
    );
    return result.rows.map((row) => ({
      id: row.id, code: row.code, displayName: row.display_name,
      countryCode: row.country_code, regionCode: row.region_code,
      accountingProfile: row.accounting_profile, ledgerId: row.ledger_id,
      ledgerCode: row.ledger_code, functionalCurrency: row.functional_currency,
      periodLabel: row.period_label, periodState: row.period_state,
    }));
  });
}

export type TrialBalanceRow = Readonly<{
  entityCode: string;
  ledgerCode: string;
  currency: string;
  accountCode: string;
  accountName: string;
  accountClass: string;
  canonicalKey: string;
  debit: string;
  credit: string;
}>;

export async function loadTrialBalance(principal: SessionPrincipal): Promise<readonly TrialBalanceRow[]> {
  return withWorkspaceTenantRead(readContext(principal), "/app/reports/trial-balance", async (client) => {
    await assertReportPermission(client, principal, PERMISSIONS.readMcpLedger);
    const result = await client.query<{
      entity_code: string; ledger_code: string; functional_currency: string;
      account_code: string; account_name: string; account_class: string;
      canonical_key: string; debit: string; credit: string;
    }>(
      `SELECT entity.code AS entity_code, ledger.code AS ledger_code,
         ledger.functional_currency, account.code AS account_code,
         account.display_name AS account_name, account.class::text AS account_class,
         concat_ws('.', entity.code, account.code,
           coalesce(subaccount.code, '0000'), coalesce(department.code, '0000'),
           coalesce(intercompany.code, '0000'),
           coalesce(custom1.code, '0000'), coalesce(custom2.code, '0000'),
           coalesce(custom3.code, '0000'), coalesce(custom4.code, '0000'),
           coalesce(custom5.code, '0000'), coalesce(custom6.code, '0000'),
           coalesce(custom7.code, '0000'), coalesce(custom8.code, '0000')) AS canonical_key,
         coalesce(sum(line.debit_functional) FILTER (WHERE entry.id IS NOT NULL), 0)::text AS debit,
         coalesce(sum(line.credit_functional) FILTER (WHERE entry.id IS NOT NULL), 0)::text AS credit
       FROM account_combinations combination
       JOIN legal_entities entity ON entity.organization_id = combination.organization_id
         AND entity.id = combination.entity_id
       JOIN ledgers ledger ON ledger.organization_id = combination.organization_id
         AND ledger.id = combination.ledger_id
       JOIN gl_accounts account ON account.organization_id = combination.organization_id
         AND account.id = combination.account_id
       LEFT JOIN segment_values subaccount ON subaccount.organization_id = combination.organization_id
         AND subaccount.id = combination.subaccount_id
       LEFT JOIN segment_values department ON department.organization_id = combination.organization_id
         AND department.id = combination.department_id
       LEFT JOIN legal_entities intercompany ON intercompany.organization_id = combination.organization_id
         AND intercompany.id = combination.intercompany_entity_id
       LEFT JOIN segment_values custom1 ON custom1.organization_id = combination.organization_id AND custom1.id = combination.custom_1_id
       LEFT JOIN segment_values custom2 ON custom2.organization_id = combination.organization_id AND custom2.id = combination.custom_2_id
       LEFT JOIN segment_values custom3 ON custom3.organization_id = combination.organization_id AND custom3.id = combination.custom_3_id
       LEFT JOIN segment_values custom4 ON custom4.organization_id = combination.organization_id AND custom4.id = combination.custom_4_id
       LEFT JOIN segment_values custom5 ON custom5.organization_id = combination.organization_id AND custom5.id = combination.custom_5_id
       LEFT JOIN segment_values custom6 ON custom6.organization_id = combination.organization_id AND custom6.id = combination.custom_6_id
       LEFT JOIN segment_values custom7 ON custom7.organization_id = combination.organization_id AND custom7.id = combination.custom_7_id
       LEFT JOIN segment_values custom8 ON custom8.organization_id = combination.organization_id AND custom8.id = combination.custom_8_id
       LEFT JOIN journal_lines line ON line.organization_id = combination.organization_id
         AND line.account_combination_id = combination.id
       LEFT JOIN journal_entries entry ON entry.organization_id = line.organization_id
         AND entry.id = line.journal_entry_id AND entry.status = 'POSTED'
       WHERE combination.organization_id = $1
         AND (entry.id IS NOT NULL OR combination.active)
       GROUP BY entity.code, ledger.code, ledger.functional_currency,
         account.code, account.display_name, account.class, combination.id,
         subaccount.code, department.code, intercompany.code,
         custom1.code, custom2.code, custom3.code, custom4.code,
         custom5.code, custom6.code, custom7.code, custom8.code
       HAVING coalesce(sum(line.debit_functional) FILTER (WHERE entry.id IS NOT NULL), 0) <> 0
           OR coalesce(sum(line.credit_functional) FILTER (WHERE entry.id IS NOT NULL), 0) <> 0
       ORDER BY entity.code, account.code, canonical_key`,
      [principal.organizationId],
    );
    return result.rows.map((row) => ({
      entityCode: row.entity_code, ledgerCode: row.ledger_code,
      currency: row.functional_currency, accountCode: row.account_code,
      accountName: row.account_name, accountClass: row.account_class,
      canonicalKey: row.canonical_key, debit: row.debit, credit: row.credit,
    }));
  });
}

export type AccountingOverview = Readonly<{
  access: Readonly<{
    ledger: boolean;
    receivables: boolean;
    payables: boolean;
    tax: boolean;
  }>;
  postedJournalCount: number;
  unpostedJournalCount: number;
  taxDecisionCount: number;
  manualReviewTaxCount: number;
  openReceivables: readonly Readonly<{ currency: string; amount: string }>[];
  openPayables: readonly Readonly<{ currency: string; amount: string }>[];
}>;

export async function loadAccountingOverview(principal: SessionPrincipal): Promise<AccountingOverview> {
  return withWorkspaceTenantRead(readContext(principal), "/app", async (client) => {
    const canReadLedger = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readMcpLedger,
    });
    const canReadReceivables = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readReceivables,
    });
    const canReadPayables = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readPayables,
    });
    const canReadTax = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readTax,
    });
    const journalCounts = canReadLedger ? await client.query<{ posted: number; unposted: number }>(
        `SELECT count(*) FILTER (WHERE status = 'POSTED')::int AS posted,
           count(*) FILTER (WHERE status IN ('DRAFT','SUBMITTED','APPROVED'))::int AS unposted
         FROM journal_entries WHERE organization_id = $1`, [principal.organizationId],
      ) : { rows: [{ posted: 0, unposted: 0 }] };
    const taxCounts = canReadTax ? await client.query<{ total: number; manual_review: number }>(
        `WITH current_draft_decisions AS (
           SELECT line.value -> 'taxDecision' ->> 'status' AS status
           FROM source_documents source
           CROSS JOIN LATERAL jsonb_array_elements(source.snapshot -> 'lines') AS line(value)
           WHERE source.organization_id = $1
             AND source.status = 'DRAFT'
             AND source.source_type IN ('receivables.sales-invoice', 'payables.supplier-bill')
             AND NOT EXISTS (
               SELECT 1 FROM source_documents newer
               WHERE newer.organization_id = source.organization_id
                 AND newer.source_type = source.source_type
                 AND newer.source_number = source.source_number
                 AND newer.version > source.version
             )
         )
         SELECT ((SELECT count(*) FROM tax_determination_snapshots snapshot
                    WHERE snapshot.organization_id = $1)
                 + (SELECT count(*) FROM current_draft_decisions))::int AS total,
           ((SELECT count(*) FROM tax_determination_snapshots snapshot
               WHERE snapshot.organization_id = $1
                 AND snapshot.status IN ('MANUAL_REVIEW', 'MANUAL_REVIEW_REQUIRED'))
             + (SELECT count(*) FROM current_draft_decisions
                  WHERE status = 'MANUAL_REVIEW_REQUIRED'))::int AS manual_review`,
        [principal.organizationId],
      ) : { rows: [{ total: 0, manual_review: 0 }] };
    const openBalances = canReadReceivables || canReadPayables
        ? await client.query<{ role: "CUSTOMER" | "SUPPLIER"; currency: string; amount: string }>(
        `SELECT account.role, balance.transaction_currency AS currency,
           coalesce(sum(balance.open_transaction_amount), 0)::text AS amount
         FROM open_item_balances balance
         JOIN party_accounts account ON account.organization_id = balance.organization_id
           AND account.id = balance.party_account_id
         WHERE balance.organization_id = $1 AND balance.open_transaction_amount > 0
           AND ((account.role = 'CUSTOMER' AND $2::boolean)
             OR (account.role = 'SUPPLIER' AND $3::boolean))
         GROUP BY account.role, balance.transaction_currency
         ORDER BY account.role, balance.transaction_currency`,
        [principal.organizationId, canReadReceivables, canReadPayables],
      ) : { rows: [] as { role: "CUSTOMER" | "SUPPLIER"; currency: string; amount: string }[] };
    return {
      access: {
        ledger: canReadLedger,
        receivables: canReadReceivables,
        payables: canReadPayables,
        tax: canReadTax,
      },
      postedJournalCount: journalCounts.rows[0]?.posted ?? 0,
      unpostedJournalCount: journalCounts.rows[0]?.unposted ?? 0,
      taxDecisionCount: taxCounts.rows[0]?.total ?? 0,
      manualReviewTaxCount: taxCounts.rows[0]?.manual_review ?? 0,
      openReceivables: openBalances.rows.filter((row) => row.role === "CUSTOMER")
        .map((row) => ({ currency: row.currency, amount: row.amount })),
      openPayables: openBalances.rows.filter((row) => row.role === "SUPPLIER")
        .map((row) => ({ currency: row.currency, amount: row.amount })),
    };
  });
}

function csvValue(value: string): string {
  const spreadsheetSafeValue = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${spreadsheetSafeValue.replaceAll('"', '""')}"`;
}

export function trialBalanceCsv(rows: readonly TrialBalanceRow[]): string {
  return [
    ["Entity", "Ledger", "Currency", "Account", "Canonical key", "Name", "Class", "Debit", "Credit"],
    ...rows.map((row) => [row.entityCode, row.ledgerCode, row.currency, row.accountCode,
      row.canonicalKey, row.accountName, row.accountClass, row.debit, row.credit]),
  ].map((row) => row.map(csvValue).join(",")).join("\r\n");
}

export type TaxDeterminationSummary = Readonly<{
  id: string;
  entityCode: string;
  ledgerCode: string;
  sourceDocumentId: string;
  sourceType: string;
  sourceNumber: string;
  sourceStatus: string;
  status: string;
  ruleKey: string;
  jurisdiction: string;
  currency: string;
  taxableBasis: string;
  totalTax: string;
  packKey: string;
  packVersion: string;
  createdAt: string;
  reviewReason: string | null;
}>;

type TaxDeterminationRow = Readonly<{
  id: string;
  entity_code: string;
  ledger_code: string;
  source_document_id: string;
  source_type: string;
  source_number: string;
  source_status: string;
  status: string;
  rule_key: string;
  jurisdiction: string;
  currency: string;
  taxable_basis: string;
  total_tax: string;
  pack_key: string;
  pack_version: string;
  created_at: string;
  review_reason: string | null;
}>;

export async function loadTaxDeterminations(
  principal: SessionPrincipal,
  options: Readonly<{ reviewOnly?: boolean }> = {},
): Promise<readonly TaxDeterminationSummary[]> {
  return withWorkspaceTenantRead(readContext(principal), "/app/tax", async (client) => {
    await assertReportPermission(client, principal, PERMISSIONS.readTax);
    const result = await client.query<TaxDeterminationRow>(
      `WITH determinations AS (
         SELECT snapshot.id::text AS id, entity.code AS entity_code,
           ledger.code AS ledger_code, snapshot.source_document_id,
           source.source_type, source.source_number, source.status::text AS source_status,
           snapshot.status, snapshot.rule_key, snapshot.jurisdiction,
           snapshot.currency, snapshot.taxable_basis::text AS taxable_basis,
           snapshot.total_tax::text AS total_tax, pack.pack_key,
           pack.version AS pack_version, snapshot.created_at,
           NULL::text AS review_reason
         FROM tax_determination_snapshots snapshot
         JOIN legal_entities entity
           ON entity.organization_id = snapshot.organization_id
          AND entity.id = snapshot.legal_entity_id
         JOIN ledgers ledger
           ON ledger.organization_id = snapshot.organization_id
          AND ledger.id = snapshot.ledger_id
         JOIN source_documents source
           ON source.organization_id = snapshot.organization_id
          AND source.id = snapshot.source_document_id
         JOIN tax_pack_versions pack ON pack.id = snapshot.tax_pack_version_id
         WHERE snapshot.organization_id = $1
           AND (NOT $2::boolean OR snapshot.status IN ('MANUAL_REVIEW', 'MANUAL_REVIEW_REQUIRED'))

         UNION ALL

         SELECT source.id::text || ':draft-tax:' || line.ordinality::text AS id,
           entity.code AS entity_code, ledger.code AS ledger_code,
           source.id AS source_document_id, source.source_type,
           source.source_number, source.status::text AS source_status,
           line.value -> 'taxDecision' ->> 'status' AS status,
           line.value -> 'taxDecision' ->> 'ruleKey' AS rule_key,
           line.value -> 'taxDecision' ->> 'jurisdiction' AS jurisdiction,
           source.snapshot ->> 'currency' AS currency,
           line.value ->> 'netAmount' AS taxable_basis,
           line.value -> 'taxDecision' ->> 'totalTax' AS total_tax,
           line.value -> 'taxDecision' ->> 'packKey' AS pack_key,
           line.value -> 'taxDecision' ->> 'packVersion' AS pack_version,
           source.created_at,
           line.value -> 'taxDecision' ->> 'reviewReason' AS review_reason
         FROM source_documents source
         JOIN legal_entities entity
           ON entity.organization_id = source.organization_id
          AND entity.id = source.legal_entity_id
         JOIN ledgers ledger
           ON ledger.organization_id = source.organization_id
          AND ledger.legal_entity_id = source.legal_entity_id
          AND ledger.id::text = source.snapshot ->> 'ledgerId'
         CROSS JOIN LATERAL jsonb_array_elements(source.snapshot -> 'lines')
           WITH ORDINALITY AS line(value, ordinality)
         WHERE source.organization_id = $1
           AND source.status = 'DRAFT'
           AND source.source_type IN ('receivables.sales-invoice', 'payables.supplier-bill')
           AND line.value -> 'taxDecision' ->> 'status' = 'MANUAL_REVIEW_REQUIRED'
           AND NOT EXISTS (
             SELECT 1 FROM source_documents newer
             WHERE newer.organization_id = source.organization_id
               AND newer.source_type = source.source_type
               AND newer.source_number = source.source_number
               AND newer.version > source.version
           )
       )
       SELECT id, entity_code, ledger_code, source_document_id, source_type,
         source_number, source_status, status, rule_key, jurisdiction, currency,
         taxable_basis, total_tax, pack_key, pack_version, created_at::text,
         review_reason
       FROM determinations
       ORDER BY created_at DESC, id DESC
       LIMIT 250`,
      [principal.organizationId, options.reviewOnly === true],
    );
    return result.rows.map((row) => ({
      id: row.id,
      entityCode: row.entity_code,
      ledgerCode: row.ledger_code,
      sourceDocumentId: row.source_document_id,
      sourceType: row.source_type,
      sourceNumber: row.source_number,
      sourceStatus: row.source_status,
      status: row.status,
      ruleKey: row.rule_key,
      jurisdiction: row.jurisdiction,
      currency: row.currency,
      taxableBasis: row.taxable_basis,
      totalTax: row.total_tax,
      packKey: row.pack_key,
      packVersion: row.pack_version,
      createdAt: row.created_at,
      reviewReason: row.review_reason,
    }));
  });
}
