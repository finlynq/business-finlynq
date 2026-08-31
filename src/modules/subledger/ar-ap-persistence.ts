import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import { exact } from "@/kernel/money";
import { postJournalInTransaction } from "@/modules/ledger/posting-service";
import {
  sourceContentHash,
  subledgerSourceSnapshotSchema,
  type BusinessDocumentSnapshot,
  type SettlementDocumentSnapshot,
  type SubledgerOwnerModule,
  type SubledgerSourceSnapshot,
} from "./document-model";
import type { JournalLineInput } from "./journal-line-builders";
import { acquireOpenItemLocks } from "./ar-ap-idempotency";
import type {
  CalculatedSettlementAllocation,
  IssuedDocumentResult,
  LockedOpenItemRow,
  OriginalJournalLineRow,
  OriginalJournalRow,
  SettlementAllocationRow,
  SettlementResult,
  SourceDocumentRow,
  SourceDocumentStatus,
  SubledgerDocumentRecord,
  TaxPackVersionRow,
  VoidedDocumentResult,
  VoidedSettlementResult,
} from "./ar-ap-types";

export function recordFromRow(row: SourceDocumentRow): SubledgerDocumentRecord {
  const createdAt = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : new Date(row.created_at).toISOString();
  return {
    id: row.id,
    organizationId: row.organization_id,
    legalEntityId: row.legal_entity_id,
    ownerModule: row.owner_module,
    sourceType: row.source_type,
    sourceNumber: row.source_number,
    version: Number(row.version),
    status: row.status,
    snapshot: subledgerSourceSnapshotSchema.parse(row.snapshot),
    contentHash: row.content_hash,
    supersedesSourceDocumentId: row.supersedes_source_document_id,
    voidReason: row.void_reason,
    createdBy: row.created_by,
    createdAt,
  };
}

export async function appendSourceDocument(
  client: PoolClient,
  input: Readonly<{
    context: TenantTransactionContext;
    ownerModule: SubledgerOwnerModule;
    sourceType: string;
    sourceNumber: string;
    legalEntityId: string;
    version: number;
    status: SourceDocumentStatus;
    snapshot: SubledgerSourceSnapshot;
    idempotencyKey: string;
    commandHash: string;
    supersedesSourceDocumentId?: string;
    voidReason?: string;
  }>,
): Promise<SourceDocumentRow> {
  const id = randomUUID();
  const result = await client.query<SourceDocumentRow>(
    `INSERT INTO source_documents (
       id, organization_id, legal_entity_id, owner_module, source_type,
       source_number, version, status, snapshot, content_hash,
       idempotency_key, command_hash, supersedes_source_document_id,
       created_by, void_reason
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10,
       $11, $12, $13, $14, $15
     )
     RETURNING id, organization_id, legal_entity_id, owner_module, source_type,
       source_number, version, status, snapshot, content_hash, command_hash,
       supersedes_source_document_id, void_reason, created_by, created_at`,
    [
      id,
      input.context.organizationId,
      input.legalEntityId,
      input.ownerModule,
      input.sourceType,
      input.sourceNumber,
      input.version,
      input.status,
      JSON.stringify(input.snapshot),
      sourceContentHash(input.snapshot),
      input.idempotencyKey,
      input.commandHash,
      input.supersedesSourceDocumentId ?? null,
      input.context.actorId,
      input.voidReason ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Source-document version was not persisted");
  return row;
}

export async function insertTaxDeterminationSnapshots(
  client: PoolClient,
  input: Readonly<{
    context: TenantTransactionContext;
    sourceDocumentId: string;
    snapshot: BusinessDocumentSnapshot;
    packVersions: ReadonlyMap<string, TaxPackVersionRow>;
  }>,
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  const rows = input.snapshot.lines.map((line) => {
    const decision = line.taxDecision;
    const version = input.packVersions.get(`${decision.packKey}:${decision.packVersion}`);
    if (!version) throw new Error("Approved tax-pack version disappeared during issue");
    const id = randomUUID();
    ids.set(line.lineNumber, id);
    return {
      id,
      taxPackVersionId: version.id,
      status: decision.status,
      ruleKey: decision.ruleKey,
      jurisdiction: decision.jurisdiction,
      taxableBasis: line.netAmount,
      totalTax: decision.totalTax,
      facts: JSON.stringify(decision.facts),
      evidence: JSON.stringify({
          registrationReference: line.tax.registrationId ?? null,
          evidenceReference: line.tax.evidenceReference ?? null,
          locationCode: line.tax.locationCode ?? null,
      }),
      components: JSON.stringify(decision.components),
      rounding: JSON.stringify({ method: decision.rounding, lineNumber: line.lineNumber }),
      glMapping: JSON.stringify({
          sourceAccountCombinationId: line.accountCombinationId,
          taxAccountCombinationId: input.snapshot.taxAccountCombinationId,
      }),
      decisionHash: line.taxDecisionHash,
    };
  });
  const result = await client.query<{ id: string }>(
    `INSERT INTO tax_determination_snapshots (
       id, organization_id, ledger_id, legal_entity_id, tax_pack_version_id,
       source_document_id, status, rule_key, jurisdiction, currency,
       taxable_basis, total_tax, fact_snapshot, evidence_snapshot,
       component_snapshot, rounding_snapshot, gl_mapping_snapshot, decision_hash
     )
     SELECT input.id, $1, $2, $3, input.tax_pack_version_id,
       $4, input.status, input.rule_key, input.jurisdiction, $5,
       input.taxable_basis, input.total_tax, input.fact_snapshot, input.evidence_snapshot,
       input.component_snapshot, input.rounding_snapshot, input.gl_mapping_snapshot,
       input.decision_hash
     FROM unnest(
       $6::uuid[], $7::uuid[], $8::text[], $9::text[], $10::text[],
       $11::numeric[], $12::numeric[], $13::jsonb[], $14::jsonb[],
       $15::jsonb[], $16::jsonb[], $17::jsonb[], $18::text[]
     ) AS input(
       id, tax_pack_version_id, status, rule_key, jurisdiction,
       taxable_basis, total_tax, fact_snapshot, evidence_snapshot,
       component_snapshot, rounding_snapshot, gl_mapping_snapshot, decision_hash
     )
     RETURNING id`,
    [
      input.context.organizationId,
      input.snapshot.ledgerId,
      input.snapshot.legalEntityId,
      input.sourceDocumentId,
      input.snapshot.currency,
      rows.map((row) => row.id),
      rows.map((row) => row.taxPackVersionId),
      rows.map((row) => row.status),
      rows.map((row) => row.ruleKey),
      rows.map((row) => row.jurisdiction),
      rows.map((row) => row.taxableBasis),
      rows.map((row) => row.totalTax),
      rows.map((row) => row.facts),
      rows.map((row) => row.evidence),
      rows.map((row) => row.components),
      rows.map((row) => row.rounding),
      rows.map((row) => row.glMapping),
      rows.map((row) => row.decisionHash),
    ],
  );
  const persistedIds = new Set(result.rows.map((row) => row.id));
  if (persistedIds.size !== rows.length || rows.some((row) => !persistedIds.has(row.id))) {
    throw new Error("Tax determination snapshot was not persisted");
  }
  return ids;
}

export async function insertSubledgerEvent(
  client: PoolClient,
  input: Readonly<{
    context: TenantTransactionContext;
    ledgerId: string;
    partyAccountId: string;
    sourceDocumentId: string;
    eventType: string;
    eventVersion: string;
  }>,
): Promise<string> {
  const id = randomUUID();
  const result = await client.query<{ id: string }>(
    `INSERT INTO subledger_events (
       id, organization_id, ledger_id, party_account_id,
       source_document_id, event_type, event_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      id,
      input.context.organizationId,
      input.ledgerId,
      input.partyAccountId,
      input.sourceDocumentId,
      input.eventType,
      input.eventVersion,
    ],
  );
  if (!result.rows[0]) throw new Error("Subledger event was not persisted");
  return id;
}

export async function insertOpenItem(
  client: PoolClient,
  input: Readonly<{
    context: TenantTransactionContext;
    snapshot: BusinessDocumentSnapshot;
    sourceEventId: string;
  }>,
): Promise<string> {
  const id = randomUUID();
  const result = await client.query<{ id: string }>(
    `INSERT INTO open_items (
       id, organization_id, ledger_id, party_account_id, source_event_id,
       status, transaction_currency, original_transaction_amount,
       open_transaction_amount, original_functional_amount,
       carrying_functional_amount, due_on
     ) VALUES (
       $1, $2, $3, $4, $5, 'OPEN', $6, $7, $7, $8, $8, $9
     ) RETURNING id`,
    [
      id,
      input.context.organizationId,
      input.snapshot.ledgerId,
      input.snapshot.partyAccountId,
      input.sourceEventId,
      input.snapshot.currency,
      input.snapshot.grossTotal,
      input.snapshot.grossFunctional,
      input.snapshot.dueOn,
    ],
  );
  if (!result.rows[0]) throw new Error("Open item was not persisted");
  return id;
}

export async function insertAndPostJournal(
  client: PoolClient,
  input: Readonly<{
    context: TenantTransactionContext;
    ledgerId: string;
    legalEntityId: string;
    periodId: string;
    journalTypeKey: string;
    ownerModule: SubledgerOwnerModule;
    sourceDocumentId: string;
    sourceEventKey: string;
    idempotencyKey: string;
    commandHash: string;
    purpose: "ROUTINE" | "REVERSAL";
    accountingDate: string;
    functionalCurrency: string;
    description: string;
    lines: readonly JournalLineInput[];
  }>,
): Promise<Readonly<{ journalId: string; journalNumber: number }>> {
  const typeResult = await client.query<{ id: string; version: number }>(
    `SELECT id, version
     FROM journal_type_definitions
     WHERE key = $1 AND owner_module = $2
     ORDER BY version DESC LIMIT 1`,
    [input.journalTypeKey, input.ownerModule],
  );
  const journalType = typeResult.rows[0];
  if (!journalType) throw new Error("Required source-owned journal type is not registered");
  const journalId = randomUUID();
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO journal_entries (
       id, organization_id, ledger_id, legal_entity_id, period_id,
       journal_type_key, journal_type_definition_id, journal_type_version,
       source_document_id, source_event_key, idempotency_key, command_hash,
       origin, purpose, accounting_date, functional_currency,
       description, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, 'SYSTEM', $13, $14, $15, $16, $17
     ) RETURNING id`,
    [
      journalId,
      input.context.organizationId,
      input.ledgerId,
      input.legalEntityId,
      input.periodId,
      input.journalTypeKey,
      journalType.id,
      journalType.version,
      input.sourceDocumentId,
      input.sourceEventKey,
      input.idempotencyKey,
      input.commandHash,
      input.purpose,
      input.accountingDate,
      input.functionalCurrency,
      input.description,
      input.context.actorId,
    ],
  );
  if (!inserted.rows[0]) throw new Error("Source-owned journal was not persisted");
  await client.query(
    `INSERT INTO journal_lines (
       id, organization_id, ledger_id, journal_entry_id, line_number,
       account_combination_id, debit_functional, credit_functional,
       transaction_currency, debit_transaction, credit_transaction,
       fx_rate, fx_rate_source, fx_rate_effective_at,
       party_account_id, subledger_event_id, tax_snapshot_id, memo
     )
     SELECT input.id, $1, $2, $3, input.line_number,
       input.account_combination_id, input.debit_functional, input.credit_functional,
       input.transaction_currency, input.debit_transaction, input.credit_transaction,
       input.fx_rate, input.fx_rate_source, input.fx_rate_effective_at,
       input.party_account_id, input.subledger_event_id, input.tax_snapshot_id, input.memo
     FROM unnest(
       $4::uuid[], $5::integer[], $6::uuid[], $7::numeric[], $8::numeric[],
       $9::text[], $10::numeric[], $11::numeric[], $12::numeric[], $13::text[],
       $14::timestamptz[], $15::uuid[], $16::uuid[], $17::uuid[], $18::text[]
     ) AS input(
       id, line_number, account_combination_id, debit_functional, credit_functional,
       transaction_currency, debit_transaction, credit_transaction, fx_rate,
       fx_rate_source, fx_rate_effective_at, party_account_id, subledger_event_id,
       tax_snapshot_id, memo
     )`,
    [
      input.context.organizationId,
      input.ledgerId,
      journalId,
      input.lines.map(() => randomUUID()),
      input.lines.map((_, index) => index + 1),
      input.lines.map((line) => line.accountCombinationId),
      input.lines.map((line) => line.debitFunctional),
      input.lines.map((line) => line.creditFunctional),
      input.lines.map((line) => line.transactionCurrency),
      input.lines.map((line) => line.debitTransaction),
      input.lines.map((line) => line.creditTransaction),
      input.lines.map((line) => line.fxRate),
      input.lines.map((line) => line.fxRateSource),
      input.lines.map((line) => line.fxRateEffectiveAt),
      input.lines.map((line) => line.partyAccountId ?? null),
      input.lines.map((line) => line.subledgerEventId ?? null),
      input.lines.map((line) => line.taxSnapshotId ?? null),
      input.lines.map((line) => line.memo),
    ],
  );
  const posted = await postJournalInTransaction(client, {
    context: input.context,
    journalId,
  });
  return { journalId, journalNumber: posted.journalNumber };
}

export async function issuedReplayResult(
  client: PoolClient,
  row: SourceDocumentRow,
): Promise<IssuedDocumentResult> {
  const result = await client.query<{
    journal_id: string;
    journal_number: number;
    event_id: string;
    open_item_id: string;
  }>(
    `SELECT journal.id AS journal_id, journal.journal_number,
       event.id AS event_id, item.id AS open_item_id
     FROM journal_entries journal
     JOIN subledger_events event
       ON event.organization_id = journal.organization_id
      AND event.source_document_id = journal.source_document_id
     JOIN open_items item
       ON item.organization_id = event.organization_id
      AND item.source_event_id = event.id
     WHERE journal.organization_id = $1
       AND journal.source_document_id = $2
       AND journal.status = 'POSTED'
     LIMIT 1`,
    [row.organization_id, row.id],
  );
  const linked = result.rows[0];
  if (!linked || linked.journal_number === null) {
    throw new Error("Idempotent issued document is missing its posted accounting artifacts");
  }
  return {
    document: recordFromRow(row),
    idempotentReplay: true,
    journalId: linked.journal_id,
    journalNumber: Number(linked.journal_number),
    subledgerEventId: linked.event_id,
    openItemId: linked.open_item_id,
  };
}

export async function lockSettlementOpenItems(
  client: PoolClient,
  input: Readonly<{
    organizationId: string;
    ids: readonly string[];
  }>,
): Promise<Map<string, LockedOpenItemRow>> {
  const ids = [...new Set(input.ids)].sort();
  await acquireOpenItemLocks(client, input.organizationId, ids);
  const result = await client.query<LockedOpenItemRow>(
    `SELECT item.id, item.ledger_id, item.party_account_id,
       item.transaction_currency,
       item.original_transaction_amount::text,
       item.original_functional_amount::text,
       coalesce((
         SELECT sum(CASE allocation.allocation_type
           WHEN 'APPLY' THEN allocation.transaction_amount
           ELSE -allocation.transaction_amount END)
         FROM document_settlement_allocations allocation
         WHERE allocation.organization_id = item.organization_id
           AND allocation.open_item_id = item.id
       ), 0)::text AS allocated_transaction_amount,
       coalesce((
         SELECT sum(CASE allocation.allocation_type
           WHEN 'APPLY' THEN allocation.carrying_functional_amount
           ELSE -allocation.carrying_functional_amount END)
         FROM document_settlement_allocations allocation
         WHERE allocation.organization_id = item.organization_id
           AND allocation.open_item_id = item.id
       ), 0)::text AS allocated_carrying_amount,
       source.source_type,
       source.snapshot->'fx'->>'source' AS source_fx_source,
       source.snapshot->'fx'->>'effectiveAt' AS source_fx_effective_at,
       void_event.id AS void_event_id
     FROM open_items item
     JOIN subledger_events event
       ON event.organization_id = item.organization_id
      AND event.id = item.source_event_id
     JOIN source_documents source
       ON source.organization_id = event.organization_id
      AND source.id = event.source_document_id
     LEFT JOIN open_item_void_events void_event
       ON void_event.organization_id = item.organization_id
      AND void_event.open_item_id = item.id
     WHERE item.organization_id = $1 AND item.id = ANY($2::uuid[])
     ORDER BY item.id`,
    [input.organizationId, ids],
  );
  if (result.rows.length !== ids.length) {
    throw new Error("One or more open items were not found in the authorized organization");
  }
  return new Map(result.rows.map((row) => [row.id, row]));
}

export async function insertSettlementAllocations(
  client: PoolClient,
  input: Readonly<{
    context: TenantTransactionContext;
    sourceDocumentId: string;
    snapshot: SettlementDocumentSnapshot;
    allocations: readonly CalculatedSettlementAllocation[];
    baseIdempotencyKey: string;
    commandHash: string;
  }>,
): Promise<readonly string[]> {
  const ids = input.allocations.map(() => randomUUID());
  const result = await client.query<{ id: string }>(
    `INSERT INTO document_settlement_allocations (
       id, organization_id, ledger_id, payment_source_document_id,
       open_item_id, allocation_type, reverses_allocation_id,
       transaction_currency, transaction_amount, carrying_functional_amount,
       settlement_functional_amount, realized_fx_functional,
       settlement_fx_rate, fx_rate_source, fx_rate_effective_at,
       idempotency_key, command_hash, created_by
     )
     SELECT input.id, $1, $2, $3, input.open_item_id, 'APPLY', NULL,
       $4, input.transaction_amount, input.carrying_functional_amount,
       input.settlement_functional_amount, input.realized_fx_functional,
       $5, $6, $7, input.idempotency_key, $8, $9
     FROM unnest(
       $10::uuid[], $11::uuid[], $12::numeric[], $13::numeric[],
       $14::numeric[], $15::numeric[], $16::text[]
     ) AS input(
       id, open_item_id, transaction_amount, carrying_functional_amount,
       settlement_functional_amount, realized_fx_functional, idempotency_key
     )
     RETURNING id`,
    [
      input.context.organizationId,
      input.snapshot.ledgerId,
      input.sourceDocumentId,
      input.snapshot.currency,
      input.snapshot.fx.rate,
      input.snapshot.fx.source,
      input.snapshot.fx.effectiveAt,
      input.commandHash,
      input.context.actorId,
      ids,
      input.allocations.map((allocation) => allocation.openItemId),
      input.allocations.map((allocation) => allocation.transactionAmount),
      input.allocations.map((allocation) => allocation.carryingFunctionalAmount),
      input.allocations.map((allocation) => allocation.settlementFunctionalAmount),
      input.allocations.map((allocation) => allocation.realizedFxFunctional),
      input.allocations.map((_, index) => `${input.baseIdempotencyKey}:${index + 1}`),
    ],
  );
  const persistedIds = new Set(result.rows.map((row) => row.id));
  if (persistedIds.size !== ids.length || ids.some((id) => !persistedIds.has(id))) {
    throw new Error("Settlement allocation was not persisted");
  }
  return ids;
}

export async function settlementReplayResult(
  client: PoolClient,
  row: SourceDocumentRow,
): Promise<SettlementResult> {
  const linked = await client.query<{
    journal_id: string;
    journal_number: number;
    event_id: string;
  }>(
    `SELECT journal.id AS journal_id, journal.journal_number, event.id AS event_id
     FROM journal_entries journal
     JOIN subledger_events event
       ON event.organization_id = journal.organization_id
      AND event.source_document_id = journal.source_document_id
     WHERE journal.organization_id = $1
       AND journal.source_document_id = $2
       AND journal.status = 'POSTED'
     LIMIT 1`,
    [row.organization_id, row.id],
  );
  const artifacts = linked.rows[0];
  if (!artifacts || artifacts.journal_number === null) {
    throw new Error("Idempotent settlement is missing its posted accounting artifacts");
  }
  const allocations = await client.query<{ id: string }>(
    `SELECT id FROM document_settlement_allocations
     WHERE organization_id = $1 AND payment_source_document_id = $2
       AND allocation_type = 'APPLY'
     ORDER BY created_at, id`,
    [row.organization_id, row.id],
  );
  return {
    document: recordFromRow(row),
    idempotentReplay: true,
    journalId: artifacts.journal_id,
    journalNumber: Number(artifacts.journal_number),
    subledgerEventId: artifacts.event_id,
    allocationIds: allocations.rows.map((allocation) => allocation.id),
  };
}

export async function loadOriginalPostedJournal(
  client: PoolClient,
  organizationId: string,
  sourceDocumentId: string,
  journalTypeKey: string,
): Promise<Readonly<{ journal: OriginalJournalRow; lines: readonly OriginalJournalLineRow[] }>> {
  const journalResult = await client.query<OriginalJournalRow>(
    `SELECT id, status, functional_currency
     FROM journal_entries
     WHERE organization_id = $1 AND source_document_id = $2
       AND journal_type_key = $3 AND status = 'POSTED'
     FOR UPDATE`,
    [organizationId, sourceDocumentId, journalTypeKey],
  );
  const journal = journalResult.rows[0];
  if (!journal) throw new Error("Posted source-owned journal was not found for the document");
  const lineResult = await client.query<OriginalJournalLineRow>(
    `SELECT account_combination_id, debit_functional::text, credit_functional::text,
       transaction_currency, debit_transaction::text, credit_transaction::text,
       fx_rate::text, fx_rate_source, fx_rate_effective_at,
       party_account_id, subledger_event_id, tax_snapshot_id, memo
     FROM journal_lines
     WHERE organization_id = $1 AND journal_entry_id = $2
     ORDER BY line_number`,
    [organizationId, journal.id],
  );
  if (lineResult.rows.length < 2) throw new Error("Posted document journal has no reversible accounting lines");
  return { journal, lines: lineResult.rows };
}

export async function lockDocumentOpenItemForVoid(
  client: PoolClient,
  input: Readonly<{
    organizationId: string;
    sourceDocumentId: string;
  }>,
): Promise<string> {
  const candidate = await client.query<{ id: string }>(
    `SELECT item.id
     FROM subledger_events event
     JOIN open_items item
       ON item.organization_id = event.organization_id
      AND item.source_event_id = event.id
     WHERE event.organization_id = $1 AND event.source_document_id = $2
     LIMIT 1`,
    [input.organizationId, input.sourceDocumentId],
  );
  const candidateId = candidate.rows[0]?.id;
  if (!candidateId) throw new Error("Document open item was not found");
  await acquireOpenItemLocks(client, input.organizationId, [candidateId]);
  const result = await client.query<{
    id: string;
    net_allocated: string;
    void_event_id: string | null;
  }>(
    `SELECT item.id,
       coalesce((
         SELECT sum(CASE allocation.allocation_type
           WHEN 'APPLY' THEN allocation.transaction_amount
           ELSE -allocation.transaction_amount END)
         FROM document_settlement_allocations allocation
         WHERE allocation.organization_id = item.organization_id
           AND allocation.open_item_id = item.id
       ), 0)::text AS net_allocated,
       void_event.id AS void_event_id
     FROM subledger_events event
     JOIN open_items item
       ON item.organization_id = event.organization_id
      AND item.source_event_id = event.id
     LEFT JOIN open_item_void_events void_event
       ON void_event.organization_id = item.organization_id
      AND void_event.open_item_id = item.id
     WHERE event.organization_id = $1 AND event.source_document_id = $2`,
    [input.organizationId, input.sourceDocumentId],
  );
  const item = result.rows[0];
  if (!item) throw new Error("Document open item was not found");
  if (item.void_event_id !== null) throw new Error("Document open item is already voided");
  if (!exact(item.net_allocated).isZero()) {
    throw new Error("Reverse every settlement allocation before voiding the document");
  }
  return item.id;
}

export async function voidReplayResult(
  client: PoolClient,
  row: SourceDocumentRow,
  journalIdempotencyKey: string,
): Promise<VoidedDocumentResult> {
  const result = await client.query<{
    journal_id: string;
    journal_number: number;
    void_event_id: string;
  }>(
    `SELECT journal.id AS journal_id, journal.journal_number,
       void_event.id AS void_event_id
     FROM journal_entries journal
     JOIN open_item_void_events void_event
       ON void_event.organization_id = journal.organization_id
      AND void_event.void_source_document_id = $2
     WHERE journal.organization_id = $1
       AND journal.idempotency_key = $3
       AND journal.status = 'POSTED'
     LIMIT 1`,
    [row.organization_id, row.id, journalIdempotencyKey],
  );
  const artifacts = result.rows[0];
  if (!artifacts || artifacts.journal_number === null) {
    throw new Error("Idempotent void is missing its reversing accounting artifacts");
  }
  return {
    document: recordFromRow(row),
    idempotentReplay: true,
    journalId: artifacts.journal_id,
    journalNumber: Number(artifacts.journal_number),
    openItemVoidEventId: artifacts.void_event_id,
  };
}

export async function loadOriginalSettlementAllocations(
  client: PoolClient,
  organizationId: string,
  sourceDocumentId: string,
): Promise<readonly SettlementAllocationRow[]> {
  const result = await client.query<SettlementAllocationRow>(
    `SELECT id, open_item_id, transaction_currency,
       transaction_amount::text, carrying_functional_amount::text,
       settlement_functional_amount::text, realized_fx_functional::text,
       settlement_fx_rate::text, fx_rate_source, fx_rate_effective_at
     FROM document_settlement_allocations
     WHERE organization_id = $1
       AND payment_source_document_id = $2
       AND allocation_type = 'APPLY'
     ORDER BY open_item_id, created_at, id`,
    [organizationId, sourceDocumentId],
  );
  if (result.rows.length === 0) {
    throw new Error("Posted settlement has no allocation events to reverse");
  }
  return result.rows;
}

export async function insertExactAllocationReversals(
  client: PoolClient,
  input: Readonly<{
    context: TenantTransactionContext;
    ledgerId: string;
    voidSourceDocumentId: string;
    originals: readonly SettlementAllocationRow[];
    baseIdempotencyKey: string;
    commandHash: string;
  }>,
): Promise<readonly string[]> {
  const ids = input.originals.map(() => randomUUID());
  const effectiveAt = input.originals.map((original) => (
    original.fx_rate_effective_at instanceof Date
      ? original.fx_rate_effective_at.toISOString()
      : new Date(original.fx_rate_effective_at).toISOString()
  ));
  const result = await client.query<{ id: string }>(
    `INSERT INTO document_settlement_allocations (
       id, organization_id, ledger_id, payment_source_document_id,
       open_item_id, allocation_type, reverses_allocation_id,
       transaction_currency, transaction_amount, carrying_functional_amount,
       settlement_functional_amount, realized_fx_functional,
       settlement_fx_rate, fx_rate_source, fx_rate_effective_at,
       idempotency_key, command_hash, created_by
     )
     SELECT input.id, $1, $2, $3, input.open_item_id, 'REVERSAL',
       input.reverses_allocation_id, input.transaction_currency,
       input.transaction_amount, input.carrying_functional_amount,
       input.settlement_functional_amount, input.realized_fx_functional,
       input.settlement_fx_rate, input.fx_rate_source, input.fx_rate_effective_at,
       input.idempotency_key, $4, $5
     FROM unnest(
       $6::uuid[], $7::uuid[], $8::uuid[], $9::text[], $10::numeric[],
       $11::numeric[], $12::numeric[], $13::numeric[], $14::numeric[],
       $15::text[], $16::timestamptz[], $17::text[]
     ) AS input(
       id, open_item_id, reverses_allocation_id, transaction_currency,
       transaction_amount, carrying_functional_amount, settlement_functional_amount,
       realized_fx_functional, settlement_fx_rate, fx_rate_source,
       fx_rate_effective_at, idempotency_key
     )
     RETURNING id`,
    [
      input.context.organizationId,
      input.ledgerId,
      input.voidSourceDocumentId,
      input.commandHash,
      input.context.actorId,
      ids,
      input.originals.map((original) => original.open_item_id),
      input.originals.map((original) => original.id),
      input.originals.map((original) => original.transaction_currency),
      input.originals.map((original) => original.transaction_amount),
      input.originals.map((original) => original.carrying_functional_amount),
      input.originals.map((original) => original.settlement_functional_amount),
      input.originals.map((original) => original.realized_fx_functional),
      input.originals.map((original) => original.settlement_fx_rate),
      input.originals.map((original) => original.fx_rate_source),
      effectiveAt,
      input.originals.map((_, index) => `${input.baseIdempotencyKey}:${index + 1}`),
    ],
  );
  const persistedIds = new Set(result.rows.map((row) => row.id));
  if (persistedIds.size !== ids.length || ids.some((id) => !persistedIds.has(id))) {
    throw new Error("Exact settlement-allocation reversal was not persisted");
  }
  return ids;
}

export async function voidSettlementReplayResult(
  client: PoolClient,
  row: SourceDocumentRow,
  journalIdempotencyKey: string,
): Promise<VoidedSettlementResult> {
  const journalResult = await client.query<{ id: string; journal_number: number }>(
    `SELECT id, journal_number
     FROM journal_entries
     WHERE organization_id = $1 AND idempotency_key = $2 AND status = 'POSTED'
     LIMIT 1`,
    [row.organization_id, journalIdempotencyKey],
  );
  const journal = journalResult.rows[0];
  if (!journal || journal.journal_number === null) {
    throw new Error("Idempotent settlement void is missing its reversing journal");
  }
  const allocations = await client.query<{ id: string }>(
    `SELECT id
     FROM document_settlement_allocations
     WHERE organization_id = $1 AND payment_source_document_id = $2
       AND allocation_type = 'REVERSAL'
     ORDER BY created_at, id`,
    [row.organization_id, row.id],
  );
  return {
    document: recordFromRow(row),
    idempotentReplay: true,
    journalId: journal.id,
    journalNumber: Number(journal.journal_number),
    reversedAllocationIds: allocations.rows.map((allocation) => allocation.id),
  };
}
