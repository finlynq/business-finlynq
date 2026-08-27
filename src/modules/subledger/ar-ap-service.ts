import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import {
  exact,
  minorUnits,
  quantizeMoney,
  sumExact,
} from "@/kernel/money";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import { postJournalInTransaction } from "@/modules/ledger/posting-service";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
} from "@/modules/workspace/write-policy";
import {
  assertSnapshotTaxDecisionsCurrent,
  buildBusinessDocumentSnapshot,
  businessDocumentSnapshotSchema,
  canonicalHash,
  createBusinessDocumentSchema,
  DOCUMENT_KIND_POLICY,
  editBusinessDocumentSchema,
  issueBusinessDocumentSchema,
  recordSettlementSchema,
  SETTLEMENT_KIND_POLICY,
  settlementDocumentSnapshotSchema,
  sourceContentHash,
  subledgerSourceSnapshotSchema,
  voidBusinessDocumentSchema,
  voidSettlementSchema,
  type BusinessDocumentSnapshot,
  type SettlementDocumentSnapshot,
  type SubledgerOwnerModule,
  type SubledgerSourceSnapshot,
} from "./document-model";
import {
  balanceJournalLines,
  buildIssueJournalLines,
  transactionLine,
  type JournalLineInput,
} from "./journal-line-builders";

export { buildIssueJournalLines };

type SourceDocumentStatus = "DRAFT" | "POSTED" | "VOIDED";

type SourceDocumentRow = Readonly<{
  id: string;
  organization_id: string;
  legal_entity_id: string;
  owner_module: SubledgerOwnerModule;
  source_type: string;
  source_number: string;
  version: number;
  status: SourceDocumentStatus;
  snapshot: unknown;
  content_hash: string;
  command_hash: string | null;
  supersedes_source_document_id: string | null;
  void_reason: string | null;
  created_by: string | null;
  created_at: Date | string;
}>;

export type SubledgerDocumentRecord = Readonly<{
  id: string;
  organizationId: string;
  legalEntityId: string;
  ownerModule: SubledgerOwnerModule;
  sourceType: string;
  sourceNumber: string;
  version: number;
  status: SourceDocumentStatus;
  snapshot: SubledgerSourceSnapshot;
  contentHash: string;
  supersedesSourceDocumentId: string | null;
  voidReason: string | null;
  createdBy: string | null;
  createdAt: string;
}>;

export type CreateBusinessDocumentCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof createBusinessDocumentSchema>;

export type EditBusinessDocumentCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof editBusinessDocumentSchema>;

export type IssueBusinessDocumentCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof issueBusinessDocumentSchema>;

export type VoidBusinessDocumentCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof voidBusinessDocumentSchema>;

export type RecordSettlementCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof recordSettlementSchema>;

export type VoidSettlementCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof voidSettlementSchema>;

export type DocumentMutationResult = Readonly<{
  document: SubledgerDocumentRecord;
  idempotentReplay: boolean;
}>;

export type IssuedDocumentResult = DocumentMutationResult & Readonly<{
  journalId: string;
  journalNumber: number;
  subledgerEventId: string;
  openItemId: string;
}>;

export type SettlementResult = DocumentMutationResult & Readonly<{
  journalId: string;
  journalNumber: number;
  subledgerEventId: string;
  allocationIds: readonly string[];
}>;

export type VoidedDocumentResult = DocumentMutationResult & Readonly<{
  journalId: string;
  journalNumber: number;
  openItemVoidEventId: string;
}>;

export type VoidedSettlementResult = DocumentMutationResult & Readonly<{
  journalId: string;
  journalNumber: number;
  reversedAllocationIds: readonly string[];
}>;

export type ListCurrentDocumentsCommand = Readonly<{
  context: TenantTransactionContext;
  ownerModule: SubledgerOwnerModule;
  statuses?: readonly SourceDocumentStatus[];
  limit?: number;
}>;

export type GetCurrentDocumentCommand = Readonly<{
  context: TenantTransactionContext;
  ownerModule: SubledgerOwnerModule;
  sourceType: string;
  sourceNumber: string;
}>;

type AccountingSetup = Readonly<{
  functional_currency: string;
  period_state: "OPEN" | "ADJUSTMENT_ONLY" | "HARD_CLOSED" | "SEALED";
  starts_on: string;
  ends_on: string;
  party_role: "CUSTOMER" | "SUPPLIER";
  control_account_id: string;
  party_currency: string | null;
}>;

type AccountCombinationRow = Readonly<{
  id: string;
  account_id: string;
  account_class: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  control_kind: "NONE" | "AR" | "AP";
}>;

type TaxPackVersionRow = Readonly<{
  id: string;
  pack_key: string;
  version: string;
  effective_from: string;
  effective_to: string | null;
}>;

const SOURCE_TYPES_BY_OWNER: Readonly<Record<SubledgerOwnerModule, readonly string[]>> = {
  receivables: ["receivables.sales-invoice", "receivables.customer-receipt"],
  payables: ["payables.supplier-bill", "payables.supplier-payment"],
};

function withoutContext<T extends Readonly<{ context: TenantTransactionContext }>>(
  input: T,
): Omit<T, "context"> {
  const { context, ...payload } = input;
  void context;
  return payload;
}

function permissionForOwner(
  ownerModule: SubledgerOwnerModule,
  operation: "read" | "manage" | "post" | "settle" | "void",
): Permission {
  const permissions = ownerModule === "receivables"
    ? {
        read: PERMISSIONS.readReceivables,
        manage: PERMISSIONS.manageReceivables,
        post: PERMISSIONS.postReceivables,
        settle: PERMISSIONS.settleReceivables,
        void: PERMISSIONS.voidReceivables,
      }
    : {
        read: PERMISSIONS.readPayables,
        manage: PERMISSIONS.managePayables,
        post: PERMISSIONS.postPayables,
        settle: PERMISSIONS.settlePayables,
        void: PERMISSIONS.voidPayables,
      };
  return permissions[operation];
}

async function assertPermission(
  client: PoolClient,
  context: TenantTransactionContext,
  permission: Permission,
): Promise<void> {
  await assertActorHasActivePermission(client, {
    organizationId: context.organizationId,
    actorId: context.actorId,
    permission,
  });
}

function recordFromRow(row: SourceDocumentRow): SubledgerDocumentRecord {
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

export function subledgerOperationKey(
  ownerModule: SubledgerOwnerModule,
  operation: string,
  suppliedKey: string,
): string {
  return `subledger:${ownerModule}:${operation}:${canonicalHash(suppliedKey).slice(0, 40)}`;
}

async function acquireIdempotencyLock(
  client: PoolClient,
  organizationId: string,
  key: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${organizationId}:${key}`],
  );
}

async function acquireDocumentIdentityLock(
  client: PoolClient,
  organizationId: string,
  sourceType: string,
  sourceNumber: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${organizationId}:${sourceType}:${sourceNumber}`],
  );
}

async function acquireOpenItemLocks(
  client: PoolClient,
  organizationId: string,
  openItemIds: readonly string[],
): Promise<void> {
  for (const openItemId of [...new Set(openItemIds)].sort()) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${organizationId}:open-item:${openItemId}`],
    );
  }
}

async function findSourceByIdempotency(
  client: PoolClient,
  organizationId: string,
  idempotencyKey: string,
): Promise<SourceDocumentRow | undefined> {
  const result = await client.query<SourceDocumentRow>(
    `SELECT id, organization_id, legal_entity_id, owner_module, source_type,
       source_number, version, status, snapshot, content_hash, command_hash,
       supersedes_source_document_id, void_reason, created_by, created_at
     FROM source_documents
     WHERE organization_id = $1 AND idempotency_key = $2`,
    [organizationId, idempotencyKey],
  );
  return result.rows[0];
}

function assertIdempotentSource(
  row: SourceDocumentRow,
  commandHash: string,
  status?: SourceDocumentStatus,
): void {
  if (row.command_hash !== commandHash || (status !== undefined && row.status !== status)) {
    throw new Error("Idempotency key is already bound to a different subledger command");
  }
}

async function currentSourceDocument(
  client: PoolClient,
  organizationId: string,
  sourceType: string,
  sourceNumber: string,
  lock: boolean,
): Promise<SourceDocumentRow | undefined> {
  if (lock) {
    await acquireDocumentIdentityLock(client, organizationId, sourceType, sourceNumber);
  }
  const result = await client.query<SourceDocumentRow>(
    `SELECT id, organization_id, legal_entity_id, owner_module, source_type,
       source_number, version, status, snapshot, content_hash, command_hash,
       supersedes_source_document_id, void_reason, created_by, created_at
     FROM source_documents
     WHERE organization_id = $1 AND source_type = $2 AND source_number = $3
     ORDER BY version DESC
     LIMIT 1`,
    [organizationId, sourceType, sourceNumber],
  );
  return result.rows[0];
}

async function appendSourceDocument(
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

async function loadAccountingSetup(
  client: PoolClient,
  input: Readonly<{
    organizationId: string;
    ledgerId: string;
    legalEntityId: string;
    periodId: string;
    partyAccountId: string;
  }>,
): Promise<AccountingSetup> {
  const result = await client.query<AccountingSetup>(
    `SELECT ledger.functional_currency,
       period.state AS period_state, period.starts_on::text, period.ends_on::text,
       party_account.role AS party_role,
       party_account.control_account_id,
       party_account.transaction_currency AS party_currency
     FROM ledgers ledger
     JOIN legal_entities entity
       ON entity.organization_id = ledger.organization_id
      AND entity.id = ledger.legal_entity_id
      AND entity.id = $3 AND entity.active
     JOIN fiscal_periods period
       ON period.organization_id = ledger.organization_id
      AND period.ledger_id = ledger.id AND period.id = $4
     JOIN party_accounts party_account
       ON party_account.organization_id = ledger.organization_id
      AND party_account.ledger_id = ledger.id
      AND party_account.legal_entity_id = entity.id
      AND party_account.id = $5 AND party_account.active
     WHERE ledger.organization_id = $1 AND ledger.id = $2 AND ledger.active`,
    [
      input.organizationId,
      input.ledgerId,
      input.legalEntityId,
      input.periodId,
      input.partyAccountId,
    ],
  );
  const setup = result.rows[0];
  if (!setup) {
    throw new Error("Active ledger, entity, fiscal period, and party account configuration was not found");
  }
  return setup;
}

function assertRoutineSetup(
  setup: AccountingSetup,
  input: Readonly<{
    accountingDate: string;
    currency: string;
    partyRole: "CUSTOMER" | "SUPPLIER";
  }>,
): void {
  if (setup.period_state !== "OPEN") {
    throw new Error("Routine AR/AP activity requires an open fiscal period");
  }
  if (input.accountingDate < setup.starts_on || input.accountingDate > setup.ends_on) {
    throw new Error("Accounting date is outside the selected fiscal period");
  }
  if (setup.party_role !== input.partyRole) {
    throw new Error(`The selected party account is not configured as ${input.partyRole.toLowerCase()}`);
  }
  if (setup.party_currency !== null && setup.party_currency !== input.currency) {
    throw new Error("Document currency does not match the party account currency restriction");
  }
}

async function loadAccountCombinations(
  client: PoolClient,
  input: Readonly<{
    organizationId: string;
    ledgerId: string;
    legalEntityId: string;
    accountingDate: string;
    ids: readonly string[];
  }>,
): Promise<Map<string, AccountCombinationRow>> {
  const uniqueIds = [...new Set(input.ids)];
  const result = await client.query<AccountCombinationRow>(
    `SELECT combination.id, account.id AS account_id,
       account.class AS account_class, account.control_kind
     FROM account_combinations combination
     JOIN gl_accounts account
       ON account.organization_id = combination.organization_id
      AND account.ledger_id = combination.ledger_id
      AND account.id = combination.account_id
     WHERE combination.organization_id = $1
       AND combination.ledger_id = $2
       AND combination.entity_id = $3
       AND combination.id = ANY($4::uuid[])
       AND combination.active AND account.active AND account.postable
       AND account.valid_from <= $5::date
       AND (account.valid_to IS NULL OR account.valid_to >= $5::date)`,
    [
      input.organizationId,
      input.ledgerId,
      input.legalEntityId,
      uniqueIds,
      input.accountingDate,
    ],
  );
  if (result.rows.length !== uniqueIds.length) {
    throw new Error("One or more account combinations are inactive, out of date, or outside the tenant ledger");
  }
  return new Map(result.rows.map((row) => [row.id, row]));
}

function assertBusinessAccountMappings(
  snapshot: BusinessDocumentSnapshot,
  setup: AccountingSetup,
  combinations: ReadonlyMap<string, AccountCombinationRow>,
): void {
  const policy = DOCUMENT_KIND_POLICY[snapshot.kind];
  const control = combinations.get(snapshot.controlAccountCombinationId);
  if (!control || control.account_id !== setup.control_account_id || control.control_kind !== policy.controlKind) {
    throw new Error("Control account combination does not match the party subledger account");
  }
  for (const line of snapshot.lines) {
    const combination = combinations.get(line.accountCombinationId);
    if (!combination || combination.control_kind !== "NONE") {
      throw new Error("Source lines cannot post directly to an AR or AP control account");
    }
    if (snapshot.kind === "SALES_INVOICE" && combination.account_class !== "REVENUE") {
      throw new Error("Sales-invoice source lines require revenue account combinations");
    }
    if (snapshot.kind === "SUPPLIER_BILL" &&
        combination.account_class !== "EXPENSE" && combination.account_class !== "ASSET") {
      throw new Error("Supplier-bill source lines require expense or asset account combinations");
    }
  }
  if (snapshot.taxAccountCombinationId !== null) {
    const tax = combinations.get(snapshot.taxAccountCombinationId);
    if (!tax || tax.control_kind !== "NONE") {
      throw new Error("Tax mapping cannot use an AR or AP control account");
    }
    if (snapshot.kind === "SALES_INVOICE" && tax.account_class !== "LIABILITY") {
      throw new Error("Sales tax payable mapping requires a liability account");
    }
    if (snapshot.kind === "SUPPLIER_BILL") {
      const treatments = new Set(snapshot.lines.flatMap((line) =>
        line.taxDecision.components.map((component) => component.treatment)));
      const hasRecoverableTax = treatments.has("RECOVERABLE");
      const hasSelfAssessedTax = treatments.has("SELF_ASSESSED_PAYABLE");
      if (hasRecoverableTax && hasSelfAssessedTax) {
        throw new Error(
          "A supplier bill cannot share one tax mapping between recoverable and self-assessed payable tax",
        );
      }
      if (hasSelfAssessedTax && tax.account_class !== "LIABILITY") {
        throw new Error("Self-assessed use tax requires a liability tax-payable account");
      }
      if (hasRecoverableTax && tax.account_class !== "ASSET" && tax.account_class !== "EXPENSE") {
        throw new Error("Recoverable purchase tax requires an asset or expense account");
      }
    }
  }
  if (snapshot.fxRoundingAccountCombinationId !== null &&
      combinations.get(snapshot.fxRoundingAccountCombinationId)?.control_kind !== "NONE") {
    throw new Error("FX rounding mapping cannot use an AR or AP control account");
  }
}

async function validateDraftConfiguration(
  client: PoolClient,
  context: TenantTransactionContext,
  snapshot: BusinessDocumentSnapshot,
): Promise<AccountingSetup> {
  const policy = DOCUMENT_KIND_POLICY[snapshot.kind];
  const setup = await loadAccountingSetup(client, {
    organizationId: context.organizationId,
    ledgerId: snapshot.ledgerId,
    legalEntityId: snapshot.legalEntityId,
    periodId: snapshot.periodId,
    partyAccountId: snapshot.partyAccountId,
  });
  assertRoutineSetup(setup, {
    accountingDate: snapshot.accountingDate,
    currency: snapshot.currency,
    partyRole: policy.partyRole,
  });
  if (setup.functional_currency !== snapshot.functionalCurrency) {
    throw new Error("Document functional-currency snapshot does not match its ledger");
  }
  const combinationIds = [
    snapshot.controlAccountCombinationId,
    ...snapshot.lines.map((line) => line.accountCombinationId),
    ...(snapshot.taxAccountCombinationId ? [snapshot.taxAccountCombinationId] : []),
    ...(snapshot.fxRoundingAccountCombinationId ? [snapshot.fxRoundingAccountCombinationId] : []),
  ];
  const combinations = await loadAccountCombinations(client, {
    organizationId: context.organizationId,
    ledgerId: snapshot.ledgerId,
    legalEntityId: snapshot.legalEntityId,
    accountingDate: snapshot.accountingDate,
    ids: combinationIds,
  });
  assertBusinessAccountMappings(snapshot, setup, combinations);
  await loadTaxPackVersions(client, snapshot);
  return setup;
}

async function loadTaxPackVersions(
  client: PoolClient,
  snapshot: BusinessDocumentSnapshot,
): Promise<Map<string, TaxPackVersionRow>> {
  const identities = [...new Map(snapshot.lines.map((line) => [
    `${line.taxDecision.packKey}:${line.taxDecision.packVersion}`,
    { key: line.taxDecision.packKey, version: line.taxDecision.packVersion },
  ])).values()];
  const result = await client.query<TaxPackVersionRow>(
    `SELECT id, pack_key, version, effective_from::text, effective_to::text
     FROM tax_pack_versions
     WHERE (pack_key, version) IN (
       SELECT * FROM unnest($1::text[], $2::text[])
     )`,
    [identities.map((identity) => identity.key), identities.map((identity) => identity.version)],
  );
  const versions = new Map(result.rows.map((row) => [`${row.pack_key}:${row.version}`, row]));
  if (versions.size !== identities.length) {
    throw new Error("One or more approved tax-pack versions are not installed in the database");
  }
  for (const line of snapshot.lines) {
    const version = versions.get(`${line.taxDecision.packKey}:${line.taxDecision.packVersion}`);
    if (!version || snapshot.documentDate < version.effective_from ||
        (version.effective_to !== null && snapshot.documentDate > version.effective_to)) {
      throw new Error(`Tax pack is not approved for source line ${line.lineNumber} on the document date`);
    }
  }
  return versions;
}

export async function listCurrentSubledgerDocuments(
  command: ListCurrentDocumentsCommand,
): Promise<readonly SubledgerDocumentRecord[]> {
  const limit = Math.min(Math.max(command.limit ?? 100, 1), 500);
  const statuses = command.statuses ?? ["DRAFT", "POSTED", "VOIDED"];
  if (statuses.length === 0 || statuses.some((status) =>
    status !== "DRAFT" && status !== "POSTED" && status !== "VOIDED")) {
    throw new Error("At least one valid source-document status is required");
  }
  return withTenantTransaction(command.context, async (client) => {
    await assertPermission(client, command.context, permissionForOwner(command.ownerModule, "read"));
    const result = await client.query<SourceDocumentRow>(
      `SELECT current.id, current.organization_id, current.legal_entity_id,
         current.owner_module, current.source_type, current.source_number,
         current.version, current.status, current.snapshot, current.content_hash,
         current.command_hash, current.supersedes_source_document_id,
         current.void_reason, current.created_by, current.created_at
       FROM source_documents current
       WHERE current.organization_id = $1 AND current.owner_module = $2
         AND current.source_type = ANY($3::text[])
         AND current.status = ANY($4::text[])
         AND NOT EXISTS (
           SELECT 1 FROM source_documents newer
           WHERE newer.organization_id = current.organization_id
             AND newer.source_type = current.source_type
             AND newer.source_number = current.source_number
             AND newer.version > current.version
         )
       ORDER BY current.created_at DESC, current.source_number
       LIMIT $5`,
      [
        command.context.organizationId,
        command.ownerModule,
        SOURCE_TYPES_BY_OWNER[command.ownerModule],
        statuses,
        limit,
      ],
    );
    return result.rows.map(recordFromRow);
  });
}

export async function getCurrentSubledgerDocument(
  command: GetCurrentDocumentCommand,
): Promise<SubledgerDocumentRecord | null> {
  const sourceNumber = command.sourceNumber.trim().toUpperCase();
  if (!SOURCE_TYPES_BY_OWNER[command.ownerModule].includes(command.sourceType)) {
    throw new Error("Source type does not belong to the requested AR/AP module");
  }
  return withTenantTransaction(command.context, async (client) => {
    await assertPermission(client, command.context, permissionForOwner(command.ownerModule, "read"));
    const row = await currentSourceDocument(
      client,
      command.context.organizationId,
      command.sourceType,
      sourceNumber,
      false,
    );
    return row ? recordFromRow(row) : null;
  });
}

export async function createBusinessDocumentDraft(
  unparsedCommand: CreateBusinessDocumentCommand,
): Promise<DocumentMutationResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = createBusinessDocumentSchema.parse(withoutContext(unparsedCommand));
  const policy = DOCUMENT_KIND_POLICY[command.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "draft-create",
    command.idempotencyKey,
  );
  const commandHash = canonicalHash({ operation: "draft-create", command });

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "manage"));
    await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
    const replay = await findSourceByIdempotency(
      client,
      unparsedCommand.context.organizationId,
      idempotencyKey,
    );
    if (replay) {
      assertIdempotentSource(replay, commandHash, "DRAFT");
      return { document: recordFromRow(replay), idempotentReplay: true };
    }

    await acquireDocumentIdentityLock(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
    );
    if (await currentSourceDocument(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
      true,
    )) {
      throw new Error("Source number already exists in this organization and document type");
    }

    const setup = await loadAccountingSetup(client, {
      organizationId: unparsedCommand.context.organizationId,
      ledgerId: command.ledgerId,
      legalEntityId: command.legalEntityId,
      periodId: command.periodId,
      partyAccountId: command.partyAccountId,
    });
    const { idempotencyKey: _idempotencyKey, ...documentInput } = command;
    void _idempotencyKey;
    const snapshot = buildBusinessDocumentSnapshot(documentInput, setup.functional_currency);
    await validateDraftConfiguration(client, unparsedCommand.context, snapshot);
    const row = await appendSourceDocument(client, {
      context: unparsedCommand.context,
      ownerModule: policy.ownerModule,
      sourceType: policy.sourceType,
      sourceNumber: command.sourceNumber,
      legalEntityId: command.legalEntityId,
      version: 1,
      status: "DRAFT",
      snapshot,
      idempotencyKey,
      commandHash,
    });
    return { document: recordFromRow(row), idempotentReplay: false };
  });
}

export async function editBusinessDocumentDraft(
  unparsedCommand: EditBusinessDocumentCommand,
): Promise<DocumentMutationResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = editBusinessDocumentSchema.parse(withoutContext(unparsedCommand));
  const policy = DOCUMENT_KIND_POLICY[command.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "draft-edit",
    command.idempotencyKey,
  );
  const commandHash = canonicalHash({ operation: "draft-edit", command });

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "manage"));
    await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
    const replay = await findSourceByIdempotency(
      client,
      unparsedCommand.context.organizationId,
      idempotencyKey,
    );
    if (replay) {
      assertIdempotentSource(replay, commandHash, "DRAFT");
      return { document: recordFromRow(replay), idempotentReplay: true };
    }

    await acquireDocumentIdentityLock(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
    );
    const current = await currentSourceDocument(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
      true,
    );
    if (!current || current.status !== "DRAFT" || current.version !== command.expectedVersion) {
      throw new Error("Draft edit requires the exact current DRAFT version");
    }

    const setup = await loadAccountingSetup(client, {
      organizationId: unparsedCommand.context.organizationId,
      ledgerId: command.ledgerId,
      legalEntityId: command.legalEntityId,
      periodId: command.periodId,
      partyAccountId: command.partyAccountId,
    });
    const {
      idempotencyKey: _idempotencyKey,
      expectedVersion: _expectedVersion,
      ...documentInput
    } = command;
    void _idempotencyKey;
    void _expectedVersion;
    const snapshot = buildBusinessDocumentSnapshot(documentInput, setup.functional_currency);
    await validateDraftConfiguration(client, unparsedCommand.context, snapshot);
    const row = await appendSourceDocument(client, {
      context: unparsedCommand.context,
      ownerModule: policy.ownerModule,
      sourceType: policy.sourceType,
      sourceNumber: command.sourceNumber,
      legalEntityId: snapshot.legalEntityId,
      version: current.version + 1,
      status: "DRAFT",
      snapshot,
      idempotencyKey,
      commandHash,
      supersedesSourceDocumentId: current.id,
    });
    return { document: recordFromRow(row), idempotentReplay: false };
  });
}

function moneyString(value: string | ReturnType<typeof exact>, currency: string): string {
  return quantizeMoney(value, currency).toFixed(minorUnits(currency));
}

async function insertTaxDeterminationSnapshots(
  client: PoolClient,
  input: Readonly<{
    context: TenantTransactionContext;
    sourceDocumentId: string;
    snapshot: BusinessDocumentSnapshot;
    packVersions: ReadonlyMap<string, TaxPackVersionRow>;
  }>,
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const line of input.snapshot.lines) {
    const decision = line.taxDecision;
    const version = input.packVersions.get(`${decision.packKey}:${decision.packVersion}`);
    if (!version) throw new Error("Approved tax-pack version disappeared during issue");
    const id = randomUUID();
    const result = await client.query<{ id: string }>(
      `INSERT INTO tax_determination_snapshots (
         id, organization_id, ledger_id, legal_entity_id, tax_pack_version_id,
         source_document_id, status, rule_key, jurisdiction, currency,
         taxable_basis, total_tax, fact_snapshot, evidence_snapshot,
         component_snapshot, rounding_snapshot, gl_mapping_snapshot, decision_hash
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18
       ) RETURNING id`,
      [
        id,
        input.context.organizationId,
        input.snapshot.ledgerId,
        input.snapshot.legalEntityId,
        version.id,
        input.sourceDocumentId,
        decision.status,
        decision.ruleKey,
        decision.jurisdiction,
        input.snapshot.currency,
        line.netAmount,
        decision.totalTax,
        JSON.stringify(decision.facts),
        JSON.stringify({
          registrationReference: line.tax.registrationId ?? null,
          evidenceReference: line.tax.evidenceReference ?? null,
          locationCode: line.tax.locationCode ?? null,
        }),
        JSON.stringify(decision.components),
        JSON.stringify({ method: decision.rounding, lineNumber: line.lineNumber }),
        JSON.stringify({
          sourceAccountCombinationId: line.accountCombinationId,
          taxAccountCombinationId: input.snapshot.taxAccountCombinationId,
        }),
        line.taxDecisionHash,
      ],
    );
    if (!result.rows[0]) throw new Error("Tax determination snapshot was not persisted");
    ids.set(line.lineNumber, id);
  }
  return ids;
}

async function insertSubledgerEvent(
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

async function insertOpenItem(
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

async function insertAndPostJournal(
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
  for (const [index, line] of input.lines.entries()) {
    await client.query(
      `INSERT INTO journal_lines (
         id, organization_id, ledger_id, journal_entry_id, line_number,
         account_combination_id, debit_functional, credit_functional,
         transaction_currency, debit_transaction, credit_transaction,
         fx_rate, fx_rate_source, fx_rate_effective_at,
         party_account_id, subledger_event_id, tax_snapshot_id, memo
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17, $18
       )`,
      [
        randomUUID(),
        input.context.organizationId,
        input.ledgerId,
        journalId,
        index + 1,
        line.accountCombinationId,
        line.debitFunctional,
        line.creditFunctional,
        line.transactionCurrency,
        line.debitTransaction,
        line.creditTransaction,
        line.fxRate,
        line.fxRateSource,
        line.fxRateEffectiveAt,
        line.partyAccountId ?? null,
        line.subledgerEventId ?? null,
        line.taxSnapshotId ?? null,
        line.memo,
      ],
    );
  }
  const posted = await postJournalInTransaction(client, {
    context: input.context,
    journalId,
  });
  return { journalId, journalNumber: posted.journalNumber };
}

async function issuedReplayResult(
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

export async function issueBusinessDocument(
  unparsedCommand: IssueBusinessDocumentCommand,
): Promise<IssuedDocumentResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = issueBusinessDocumentSchema.parse(withoutContext(unparsedCommand));
  const policy = DOCUMENT_KIND_POLICY[command.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "issue",
    command.idempotencyKey,
  );
  const commandHash = canonicalHash({ operation: "issue", command });

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "post"));
    await assertPermission(client, unparsedCommand.context, PERMISSIONS.postJournal);
    await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
    const replay = await findSourceByIdempotency(
      client,
      unparsedCommand.context.organizationId,
      idempotencyKey,
    );
    if (replay) {
      assertIdempotentSource(replay, commandHash, "POSTED");
      return issuedReplayResult(client, replay);
    }

    await acquireDocumentIdentityLock(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
    );
    const current = await currentSourceDocument(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
      true,
    );
    if (!current || current.status !== "DRAFT" || current.version !== command.expectedVersion) {
      throw new Error("Issue requires the exact current DRAFT version");
    }
    const snapshot = businessDocumentSnapshotSchema.parse(current.snapshot);
    if (snapshot.kind !== command.kind || snapshot.ownerModule !== policy.ownerModule) {
      throw new Error("Draft snapshot does not match its source-document owner module");
    }
    assertSnapshotTaxDecisionsCurrent(snapshot);
    await validateDraftConfiguration(client, unparsedCommand.context, snapshot);
    const packVersions = await loadTaxPackVersions(client, snapshot);

    const postedSource = await appendSourceDocument(client, {
      context: unparsedCommand.context,
      ownerModule: policy.ownerModule,
      sourceType: policy.sourceType,
      sourceNumber: command.sourceNumber,
      legalEntityId: snapshot.legalEntityId,
      version: current.version + 1,
      status: "POSTED",
      snapshot,
      idempotencyKey,
      commandHash,
      supersedesSourceDocumentId: current.id,
    });
    const taxSnapshotIds = await insertTaxDeterminationSnapshots(client, {
      context: unparsedCommand.context,
      sourceDocumentId: postedSource.id,
      snapshot,
      packVersions,
    });
    const subledgerEventId = await insertSubledgerEvent(client, {
      context: unparsedCommand.context,
      ledgerId: snapshot.ledgerId,
      partyAccountId: snapshot.partyAccountId,
      sourceDocumentId: postedSource.id,
      eventType: snapshot.kind === "SALES_INVOICE" ? "SALES_INVOICE_ISSUED" : "SUPPLIER_BILL_ISSUED",
      eventVersion: String(postedSource.version),
    });
    const openItemId = await insertOpenItem(client, {
      context: unparsedCommand.context,
      snapshot,
      sourceEventId: subledgerEventId,
    });
    const journalLines = buildIssueJournalLines(snapshot, subledgerEventId, taxSnapshotIds);
    const journal = await insertAndPostJournal(client, {
      context: unparsedCommand.context,
      ledgerId: snapshot.ledgerId,
      legalEntityId: snapshot.legalEntityId,
      periodId: snapshot.periodId,
      journalTypeKey: policy.journalTypeKey,
      ownerModule: policy.ownerModule,
      sourceDocumentId: postedSource.id,
      sourceEventKey: `${policy.sourceType}:${postedSource.id}:issued`,
      idempotencyKey,
      commandHash,
      purpose: "ROUTINE",
      accountingDate: snapshot.accountingDate,
      functionalCurrency: snapshot.functionalCurrency,
      description: snapshot.description,
      lines: journalLines,
    });
    return {
      document: recordFromRow(postedSource),
      idempotentReplay: false,
      journalId: journal.journalId,
      journalNumber: journal.journalNumber,
      subledgerEventId,
      openItemId,
    };
  });
}

type LockedOpenItemRow = Readonly<{
  id: string;
  ledger_id: string;
  party_account_id: string;
  transaction_currency: string;
  original_transaction_amount: string;
  original_functional_amount: string;
  allocated_transaction_amount: string;
  allocated_carrying_amount: string;
  source_type: string;
  source_fx_source: string | null;
  source_fx_effective_at: string | null;
  void_event_id: string | null;
}>;

type CalculatedSettlementAllocation = Readonly<{
  openItemId: string;
  transactionAmount: string;
  carryingFunctionalAmount: string;
  settlementFunctionalAmount: string;
  realizedFxFunctional: string;
  carryingFxRate: string;
  carryingFxSource: string;
  carryingFxEffectiveAt: string;
}>;

async function lockSettlementOpenItems(
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

function calculateSettlementAllocations(
  command: z.infer<typeof recordSettlementSchema>,
  openItems: ReadonlyMap<string, LockedOpenItemRow>,
  functionalCurrency: string,
): readonly CalculatedSettlementAllocation[] {
  const policy = SETTLEMENT_KIND_POLICY[command.kind];
  return command.allocations.map((allocation) => {
    const item = openItems.get(allocation.openItemId);
    if (!item || item.ledger_id !== command.ledgerId ||
        item.party_account_id !== command.partyAccountId ||
        item.transaction_currency !== command.currency ||
        item.source_type !== policy.invoiceSourceType || item.void_event_id !== null) {
      throw new Error("Settlement allocation does not match the payment party, ledger, currency, or source type");
    }
    const transactionAmount = quantizeMoney(allocation.transactionAmount, command.currency);
    if (!transactionAmount.equals(allocation.transactionAmount)) {
      throw new Error(`Settlement allocation exceeds ${command.currency} precision`);
    }
    const originalTransaction = exact(item.original_transaction_amount);
    const originalFunctional = exact(item.original_functional_amount);
    const allocatedTransaction = exact(item.allocated_transaction_amount);
    const allocatedCarrying = exact(item.allocated_carrying_amount);
    const remainingTransaction = originalTransaction.minus(allocatedTransaction);
    const remainingCarrying = originalFunctional.minus(allocatedCarrying);
    if (!remainingTransaction.greaterThan(0) || !remainingCarrying.greaterThan(0) ||
        transactionAmount.greaterThan(remainingTransaction)) {
      throw new Error("Settlement would exceed the current open-item balance");
    }
    const carryingFunctional = transactionAmount.equals(remainingTransaction)
      ? remainingCarrying
      : quantizeMoney(
          transactionAmount.times(originalFunctional).div(originalTransaction),
          functionalCurrency,
        );
    const settlementFunctional = quantizeMoney(
      transactionAmount.times(command.fx.rate),
      functionalCurrency,
    );
    if (!carryingFunctional.greaterThan(0) || !settlementFunctional.greaterThan(0)) {
      throw new Error("Settlement converts to a zero functional amount");
    }
    const carryingRate = carryingFunctional.div(transactionAmount).toDecimalPlaces(18);
    if (!quantizeMoney(transactionAmount.times(carryingRate), functionalCurrency)
      .equals(carryingFunctional)) {
      throw new Error("Open-item carrying rate cannot be represented exactly at ledger precision");
    }
    const realized = policy.position === "RECEIVABLE"
      ? settlementFunctional.minus(carryingFunctional)
      : carryingFunctional.minus(settlementFunctional);
    const effectiveAt = item.source_fx_effective_at;
    if (!effectiveAt || Number.isNaN(Date.parse(effectiveAt))) {
      throw new Error("Open item is missing its immutable carrying FX effective time");
    }
    return {
      openItemId: item.id,
      transactionAmount: moneyString(transactionAmount, command.currency),
      carryingFunctionalAmount: moneyString(carryingFunctional, functionalCurrency),
      settlementFunctionalAmount: moneyString(settlementFunctional, functionalCurrency),
      realizedFxFunctional: moneyString(realized, functionalCurrency),
      carryingFxRate: carryingRate.toFixed(),
      carryingFxSource: item.source_fx_source ?? "OPEN_ITEM_CARRYING_SNAPSHOT",
      carryingFxEffectiveAt: effectiveAt,
    };
  });
}

function assertSettlementMappings(
  command: z.infer<typeof recordSettlementSchema>,
  setup: AccountingSetup,
  combinations: ReadonlyMap<string, AccountCombinationRow>,
): void {
  const policy = SETTLEMENT_KIND_POLICY[command.kind];
  const control = combinations.get(command.controlAccountCombinationId);
  const expectedControlKind = policy.partyRole === "CUSTOMER" ? "AR" : "AP";
  if (!control || control.account_id !== setup.control_account_id ||
      control.control_kind !== expectedControlKind) {
    throw new Error("Settlement control account combination does not match the party account");
  }
  const bank = combinations.get(command.bankAccountCombinationId);
  if (!bank || bank.control_kind !== "NONE" || bank.account_class !== "ASSET") {
    throw new Error("Settlement bank mapping requires a non-control asset account");
  }
  const gain = combinations.get(command.realizedFxGainAccountCombinationId);
  if (!gain || gain.control_kind !== "NONE" || gain.account_class !== "REVENUE") {
    throw new Error("Realized FX gain mapping requires a non-control revenue account");
  }
  const loss = combinations.get(command.realizedFxLossAccountCombinationId);
  if (!loss || loss.control_kind !== "NONE" || loss.account_class !== "EXPENSE") {
    throw new Error("Realized FX loss mapping requires a non-control expense account");
  }
  if (command.fxRoundingAccountCombinationId &&
      combinations.get(command.fxRoundingAccountCombinationId)?.control_kind !== "NONE") {
    throw new Error("Settlement rounding mapping cannot use an AR or AP control account");
  }
}

function buildSettlementSnapshot(
  command: z.infer<typeof recordSettlementSchema>,
  functionalCurrency: string,
  allocations: readonly CalculatedSettlementAllocation[],
): SettlementDocumentSnapshot {
  const policy = SETTLEMENT_KIND_POLICY[command.kind];
  return settlementDocumentSnapshotSchema.parse({
    schemaVersion: 1,
    kind: command.kind,
    ownerModule: policy.ownerModule,
    sourceType: policy.sourceType,
    sourceNumber: command.sourceNumber,
    ledgerId: command.ledgerId,
    legalEntityId: command.legalEntityId,
    partyAccountId: command.partyAccountId,
    controlAccountCombinationId: command.controlAccountCombinationId,
    periodId: command.periodId,
    accountingDate: command.accountingDate,
    settlementDate: command.settlementDate,
    currency: command.currency,
    functionalCurrency,
    amount: moneyString(command.amount, command.currency),
    settlementFunctionalAmount: moneyString(
      exact(command.amount).times(command.fx.rate),
      functionalCurrency,
    ),
    fx: { ...command.fx, rate: exact(command.fx.rate).toFixed() },
    bankAccountCombinationId: command.bankAccountCombinationId,
    realizedFxGainAccountCombinationId: command.realizedFxGainAccountCombinationId,
    realizedFxLossAccountCombinationId: command.realizedFxLossAccountCombinationId,
    fxRoundingAccountCombinationId: command.fxRoundingAccountCombinationId ?? null,
    description: command.description,
    allocations: allocations.map((allocation) => ({
      openItemId: allocation.openItemId,
      transactionAmount: allocation.transactionAmount,
      carryingFunctionalAmount: allocation.carryingFunctionalAmount,
      settlementFunctionalAmount: allocation.settlementFunctionalAmount,
      realizedFxFunctional: allocation.realizedFxFunctional,
      carryingFxRate: allocation.carryingFxRate,
    })),
  });
}

async function insertSettlementAllocations(
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
  const ids: string[] = [];
  for (const [index, allocation] of input.allocations.entries()) {
    const id = randomUUID();
    const result = await client.query<{ id: string }>(
      `INSERT INTO document_settlement_allocations (
         id, organization_id, ledger_id, payment_source_document_id,
         open_item_id, allocation_type, reverses_allocation_id,
         transaction_currency, transaction_amount, carrying_functional_amount,
         settlement_functional_amount, realized_fx_functional,
         settlement_fx_rate, fx_rate_source, fx_rate_effective_at,
         idempotency_key, command_hash, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, 'APPLY', NULL,
         $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
       ) RETURNING id`,
      [
        id,
        input.context.organizationId,
        input.snapshot.ledgerId,
        input.sourceDocumentId,
        allocation.openItemId,
        input.snapshot.currency,
        allocation.transactionAmount,
        allocation.carryingFunctionalAmount,
        allocation.settlementFunctionalAmount,
        allocation.realizedFxFunctional,
        input.snapshot.fx.rate,
        input.snapshot.fx.source,
        input.snapshot.fx.effectiveAt,
        `${input.baseIdempotencyKey}:${index + 1}`,
        input.commandHash,
        input.context.actorId,
      ],
    );
    if (!result.rows[0]) throw new Error("Settlement allocation was not persisted");
    ids.push(id);
  }
  return ids;
}

function buildSettlementJournalLines(
  snapshot: SettlementDocumentSnapshot,
  allocations: readonly CalculatedSettlementAllocation[],
  subledgerEventId: string,
): readonly JournalLineInput[] {
  const lines: JournalLineInput[] = [transactionLine({
    side: snapshot.kind === "CUSTOMER_RECEIPT" ? "DEBIT" : "CREDIT",
    accountCombinationId: snapshot.bankAccountCombinationId,
    transactionAmount: snapshot.amount,
    transactionCurrency: snapshot.currency,
    fxRate: snapshot.fx.rate,
    functionalCurrency: snapshot.functionalCurrency,
    fxRateSource: snapshot.fx.source,
    fxRateEffectiveAt: snapshot.fx.effectiveAt,
    memo: `${snapshot.sourceNumber} bank settlement`,
  })];
  for (const allocation of allocations) {
    lines.push(transactionLine({
      side: snapshot.kind === "CUSTOMER_RECEIPT" ? "CREDIT" : "DEBIT",
      accountCombinationId: snapshot.controlAccountCombinationId,
      transactionAmount: allocation.transactionAmount,
      transactionCurrency: snapshot.currency,
      fxRate: allocation.carryingFxRate,
      functionalCurrency: snapshot.functionalCurrency,
      functionalAmount: allocation.carryingFunctionalAmount,
      fxRateSource: allocation.carryingFxSource,
      fxRateEffectiveAt: allocation.carryingFxEffectiveAt,
      partyAccountId: snapshot.partyAccountId,
      subledgerEventId,
      memo: `${snapshot.sourceNumber} settlement of open item ${allocation.openItemId}`,
    }));
  }
  const realized = sumExact(allocations.map((allocation) => allocation.realizedFxFunctional));
  if (!realized.isZero()) {
    lines.push(transactionLine({
      side: realized.isPositive() ? "CREDIT" : "DEBIT",
      accountCombinationId: realized.isPositive()
        ? snapshot.realizedFxGainAccountCombinationId
        : snapshot.realizedFxLossAccountCombinationId,
      transactionAmount: realized.abs(),
      transactionCurrency: snapshot.functionalCurrency,
      fxRate: "1",
      functionalCurrency: snapshot.functionalCurrency,
      fxRateSource: "SYSTEM_REALIZED_FX",
      fxRateEffectiveAt: snapshot.fx.effectiveAt,
      memo: `${snapshot.sourceNumber} realized FX ${realized.isPositive() ? "gain" : "loss"}`,
    }));
  }
  return balanceJournalLines(lines, {
    functionalCurrency: snapshot.functionalCurrency,
    roundingAccountCombinationId: snapshot.fxRoundingAccountCombinationId,
    effectiveAt: snapshot.fx.effectiveAt,
    memo: `${snapshot.sourceNumber} settlement FX rounding`,
  });
}

function assertSettlementCommandAmounts(command: z.infer<typeof recordSettlementSchema>): void {
  const amount = quantizeMoney(command.amount, command.currency);
  if (!amount.equals(command.amount)) {
    throw new Error(`Settlement amount exceeds ${command.currency} precision`);
  }
  for (const allocation of command.allocations) {
    if (!quantizeMoney(allocation.transactionAmount, command.currency)
      .equals(allocation.transactionAmount)) {
      throw new Error(`Settlement allocation exceeds ${command.currency} precision`);
    }
  }
  if (!sumExact(command.allocations.map((allocation) => allocation.transactionAmount)).equals(amount)) {
    throw new Error("A settlement must be fully allocated and allocations must equal its exact amount");
  }
  if (new Set(command.allocations.map((allocation) => allocation.openItemId)).size !==
      command.allocations.length) {
    throw new Error("Combine duplicate open-item allocations into one exact amount");
  }
}

async function settlementReplayResult(
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

export async function recordCustomerReceiptOrSupplierPayment(
  unparsedCommand: RecordSettlementCommand,
): Promise<SettlementResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = recordSettlementSchema.parse(withoutContext(unparsedCommand));
  assertSettlementCommandAmounts(command);
  const policy = SETTLEMENT_KIND_POLICY[command.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "settlement",
    command.idempotencyKey,
  );
  const commandHash = canonicalHash({ operation: "settlement", command });

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "settle"));
    await assertPermission(client, unparsedCommand.context, PERMISSIONS.postJournal);
    await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
    const replay = await findSourceByIdempotency(
      client,
      unparsedCommand.context.organizationId,
      idempotencyKey,
    );
    if (replay) {
      assertIdempotentSource(replay, commandHash, "POSTED");
      return settlementReplayResult(client, replay);
    }
    await acquireDocumentIdentityLock(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
    );
    if (await currentSourceDocument(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
      true,
    )) {
      throw new Error("Settlement source number already exists in this organization and document type");
    }
    const setup = await loadAccountingSetup(client, {
      organizationId: unparsedCommand.context.organizationId,
      ledgerId: command.ledgerId,
      legalEntityId: command.legalEntityId,
      periodId: command.periodId,
      partyAccountId: command.partyAccountId,
    });
    assertRoutineSetup(setup, {
      accountingDate: command.accountingDate,
      currency: command.currency,
      partyRole: policy.partyRole,
    });
    if (command.currency === setup.functional_currency && !exact(command.fx.rate).equals(1)) {
      throw new Error("Functional-currency settlements require an FX rate of exactly 1");
    }
    const combinations = await loadAccountCombinations(client, {
      organizationId: unparsedCommand.context.organizationId,
      ledgerId: command.ledgerId,
      legalEntityId: command.legalEntityId,
      accountingDate: command.accountingDate,
      ids: [
        command.controlAccountCombinationId,
        command.bankAccountCombinationId,
        command.realizedFxGainAccountCombinationId,
        command.realizedFxLossAccountCombinationId,
        ...(command.fxRoundingAccountCombinationId ? [command.fxRoundingAccountCombinationId] : []),
      ],
    });
    assertSettlementMappings(command, setup, combinations);
    const openItems = await lockSettlementOpenItems(client, {
      organizationId: unparsedCommand.context.organizationId,
      ids: command.allocations.map((allocation) => allocation.openItemId),
    });
    const calculatedAllocations = calculateSettlementAllocations(
      command,
      openItems,
      setup.functional_currency,
    );
    const snapshot = buildSettlementSnapshot(command, setup.functional_currency, calculatedAllocations);
    const source = await appendSourceDocument(client, {
      context: unparsedCommand.context,
      ownerModule: policy.ownerModule,
      sourceType: policy.sourceType,
      sourceNumber: command.sourceNumber,
      legalEntityId: command.legalEntityId,
      version: 1,
      status: "POSTED",
      snapshot,
      idempotencyKey,
      commandHash,
    });
    const subledgerEventId = await insertSubledgerEvent(client, {
      context: unparsedCommand.context,
      ledgerId: command.ledgerId,
      partyAccountId: command.partyAccountId,
      sourceDocumentId: source.id,
      eventType: command.kind === "CUSTOMER_RECEIPT" ? "CUSTOMER_RECEIPT_RECORDED" : "SUPPLIER_PAYMENT_RECORDED",
      eventVersion: String(source.version),
    });
    const allocationIds = await insertSettlementAllocations(client, {
      context: unparsedCommand.context,
      sourceDocumentId: source.id,
      snapshot,
      allocations: calculatedAllocations,
      baseIdempotencyKey: idempotencyKey,
      commandHash,
    });
    const journalLines = buildSettlementJournalLines(snapshot, calculatedAllocations, subledgerEventId);
    const journal = await insertAndPostJournal(client, {
      context: unparsedCommand.context,
      ledgerId: command.ledgerId,
      legalEntityId: command.legalEntityId,
      periodId: command.periodId,
      journalTypeKey: policy.journalTypeKey,
      ownerModule: policy.ownerModule,
      sourceDocumentId: source.id,
      sourceEventKey: `${policy.sourceType}:${source.id}:settled`,
      idempotencyKey,
      commandHash,
      purpose: "ROUTINE",
      accountingDate: command.accountingDate,
      functionalCurrency: setup.functional_currency,
      description: command.description,
      lines: journalLines,
    });
    return {
      document: recordFromRow(source),
      idempotentReplay: false,
      journalId: journal.journalId,
      journalNumber: journal.journalNumber,
      subledgerEventId,
      allocationIds,
    };
  });
}

type OriginalJournalRow = Readonly<{
  id: string;
  status: string;
  functional_currency: string;
}>;

type OriginalJournalLineRow = Readonly<{
  account_combination_id: string;
  debit_functional: string;
  credit_functional: string;
  transaction_currency: string;
  debit_transaction: string;
  credit_transaction: string;
  fx_rate: string;
  fx_rate_source: string;
  fx_rate_effective_at: Date | string;
  party_account_id: string | null;
  subledger_event_id: string | null;
  tax_snapshot_id: string | null;
  memo: string | null;
}>;

async function loadOriginalPostedJournal(
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

function reverseJournalLines(lines: readonly OriginalJournalLineRow[]): readonly JournalLineInput[] {
  return lines.map((line) => ({
    accountCombinationId: line.account_combination_id,
    debitFunctional: line.credit_functional,
    creditFunctional: line.debit_functional,
    transactionCurrency: line.transaction_currency,
    debitTransaction: line.credit_transaction,
    creditTransaction: line.debit_transaction,
    fxRate: line.fx_rate,
    fxRateSource: line.fx_rate_source,
    fxRateEffectiveAt: line.fx_rate_effective_at instanceof Date
      ? line.fx_rate_effective_at.toISOString()
      : new Date(line.fx_rate_effective_at).toISOString(),
    partyAccountId: line.party_account_id ?? undefined,
    subledgerEventId: line.subledger_event_id ?? undefined,
    taxSnapshotId: line.tax_snapshot_id ?? undefined,
    memo: `${line.memo ? `${line.memo} · ` : ""}Document void reversal`,
  }));
}

async function lockDocumentOpenItemForVoid(
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

async function voidReplayResult(
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

export async function voidIssuedBusinessDocument(
  unparsedCommand: VoidBusinessDocumentCommand,
): Promise<VoidedDocumentResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = voidBusinessDocumentSchema.parse(withoutContext(unparsedCommand));
  if (unparsedCommand.context.reason !== command.reason) {
    throw new Error("Void reason must be bound to the transaction audit context");
  }
  const policy = DOCUMENT_KIND_POLICY[command.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "void",
    command.idempotencyKey,
  );
  const commandHash = canonicalHash({ operation: "void", command });

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "void"));
    await assertPermission(client, unparsedCommand.context, PERMISSIONS.postJournal);
    await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
    const replay = await findSourceByIdempotency(
      client,
      unparsedCommand.context.organizationId,
      idempotencyKey,
    );
    if (replay) {
      assertIdempotentSource(replay, commandHash, "VOIDED");
      return voidReplayResult(client, replay, idempotencyKey);
    }
    await acquireDocumentIdentityLock(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
    );
    const current = await currentSourceDocument(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
      true,
    );
    if (!current || current.status !== "POSTED" || current.version !== command.expectedVersion) {
      throw new Error("Void requires the exact current POSTED document version");
    }
    const snapshot = businessDocumentSnapshotSchema.parse(current.snapshot);
    if (snapshot.kind !== command.kind || snapshot.ownerModule !== policy.ownerModule) {
      throw new Error("Posted snapshot does not match its source-document owner module");
    }
    const setup = await loadAccountingSetup(client, {
      organizationId: unparsedCommand.context.organizationId,
      ledgerId: snapshot.ledgerId,
      legalEntityId: snapshot.legalEntityId,
      periodId: command.periodId,
      partyAccountId: snapshot.partyAccountId,
    });
    if (setup.period_state === "HARD_CLOSED" || setup.period_state === "SEALED") {
      throw new Error("Document reversal requires an open or adjustment-only fiscal period");
    }
    if (command.accountingDate < setup.starts_on || command.accountingDate > setup.ends_on) {
      throw new Error("Void accounting date is outside the selected fiscal period");
    }
    if (setup.period_state === "ADJUSTMENT_ONLY") {
      await assertPermission(client, unparsedCommand.context, PERMISSIONS.postAdjustment);
    }
    const openItemId = await lockDocumentOpenItemForVoid(client, {
      organizationId: unparsedCommand.context.organizationId,
      sourceDocumentId: current.id,
    });
    const original = await loadOriginalPostedJournal(
      client,
      unparsedCommand.context.organizationId,
      current.id,
      policy.journalTypeKey,
    );
    const voidSource = await appendSourceDocument(client, {
      context: unparsedCommand.context,
      ownerModule: policy.ownerModule,
      sourceType: policy.sourceType,
      sourceNumber: command.sourceNumber,
      legalEntityId: snapshot.legalEntityId,
      version: current.version + 1,
      status: "VOIDED",
      snapshot,
      idempotencyKey,
      commandHash,
      supersedesSourceDocumentId: current.id,
      voidReason: command.reason,
    });
    const journal = await insertAndPostJournal(client, {
      context: unparsedCommand.context,
      ledgerId: snapshot.ledgerId,
      legalEntityId: snapshot.legalEntityId,
      periodId: command.periodId,
      journalTypeKey: command.kind === "SALES_INVOICE"
        ? "receivables.invoice-void"
        : "payables.bill-void",
      ownerModule: policy.ownerModule,
      // The reversal retains the original immutable accounting source so its
      // copied subledger and tax provenance remains tenant-valid. The VOIDED
      // successor is linked separately by open_item_void_events below.
      sourceDocumentId: current.id,
      sourceEventKey: `${policy.sourceType}:${voidSource.id}:void`,
      idempotencyKey,
      commandHash,
      purpose: "REVERSAL",
      accountingDate: command.accountingDate,
      functionalCurrency: snapshot.functionalCurrency,
      description: command.description,
      lines: reverseJournalLines(original.lines),
    });
    await client.query(
      `INSERT INTO journal_entry_relations (
         organization_id, from_journal_id, to_journal_id, kind, reason
       ) VALUES ($1, $2, $3, 'REVERSAL_OF', $4)`,
      [
        unparsedCommand.context.organizationId,
        journal.journalId,
        original.journal.id,
        command.reason,
      ],
    );
    const voidEventId = randomUUID();
    const voidEvent = await client.query<{ id: string }>(
      `INSERT INTO open_item_void_events (
         id, organization_id, ledger_id, open_item_id,
         void_source_document_id, reason, idempotency_key,
         command_hash, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        voidEventId,
        unparsedCommand.context.organizationId,
        snapshot.ledgerId,
        openItemId,
        voidSource.id,
        command.reason,
        idempotencyKey,
        commandHash,
        unparsedCommand.context.actorId,
      ],
    );
    if (!voidEvent.rows[0]) throw new Error("Open-item void event was not persisted");
    return {
      document: recordFromRow(voidSource),
      idempotentReplay: false,
      journalId: journal.journalId,
      journalNumber: journal.journalNumber,
      openItemVoidEventId: voidEventId,
    };
  });
}

type SettlementAllocationRow = Readonly<{
  id: string;
  open_item_id: string;
  transaction_currency: string;
  transaction_amount: string;
  carrying_functional_amount: string;
  settlement_functional_amount: string;
  realized_fx_functional: string;
  settlement_fx_rate: string;
  fx_rate_source: string;
  fx_rate_effective_at: Date | string;
}>;

async function loadOriginalSettlementAllocations(
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

async function insertExactAllocationReversals(
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
  const ids: string[] = [];
  for (const [index, original] of input.originals.entries()) {
    const id = randomUUID();
    const effectiveAt = original.fx_rate_effective_at instanceof Date
      ? original.fx_rate_effective_at.toISOString()
      : new Date(original.fx_rate_effective_at).toISOString();
    const result = await client.query<{ id: string }>(
      `INSERT INTO document_settlement_allocations (
         id, organization_id, ledger_id, payment_source_document_id,
         open_item_id, allocation_type, reverses_allocation_id,
         transaction_currency, transaction_amount, carrying_functional_amount,
         settlement_functional_amount, realized_fx_functional,
         settlement_fx_rate, fx_rate_source, fx_rate_effective_at,
         idempotency_key, command_hash, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, 'REVERSAL', $6,
         $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
       ) RETURNING id`,
      [
        id,
        input.context.organizationId,
        input.ledgerId,
        input.voidSourceDocumentId,
        original.open_item_id,
        original.id,
        original.transaction_currency,
        original.transaction_amount,
        original.carrying_functional_amount,
        original.settlement_functional_amount,
        original.realized_fx_functional,
        original.settlement_fx_rate,
        original.fx_rate_source,
        effectiveAt,
        `${input.baseIdempotencyKey}:${index + 1}`,
        input.commandHash,
        input.context.actorId,
      ],
    );
    if (!result.rows[0]) throw new Error("Exact settlement-allocation reversal was not persisted");
    ids.push(id);
  }
  return ids;
}

async function voidSettlementReplayResult(
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

export async function voidSettlementAndReverseAllocations(
  unparsedCommand: VoidSettlementCommand,
): Promise<VoidedSettlementResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = voidSettlementSchema.parse(withoutContext(unparsedCommand));
  if (unparsedCommand.context.reason !== command.reason) {
    throw new Error("Settlement-void reason must be bound to the transaction audit context");
  }
  const policy = SETTLEMENT_KIND_POLICY[command.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "settlement-void",
    command.idempotencyKey,
  );
  const commandHash = canonicalHash({ operation: "settlement-void", command });

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "void"));
    await assertPermission(client, unparsedCommand.context, PERMISSIONS.postJournal);
    await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
    const replay = await findSourceByIdempotency(
      client,
      unparsedCommand.context.organizationId,
      idempotencyKey,
    );
    if (replay) {
      assertIdempotentSource(replay, commandHash, "VOIDED");
      return voidSettlementReplayResult(client, replay, idempotencyKey);
    }
    await acquireDocumentIdentityLock(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
    );
    const current = await currentSourceDocument(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
      true,
    );
    if (!current || current.status !== "POSTED" || current.version !== command.expectedVersion) {
      throw new Error("Settlement void requires the exact current POSTED version");
    }
    const snapshot = settlementDocumentSnapshotSchema.parse(current.snapshot);
    if (snapshot.kind !== command.kind || snapshot.ownerModule !== policy.ownerModule) {
      throw new Error("Settlement snapshot does not match its source-document owner module");
    }
    const setup = await loadAccountingSetup(client, {
      organizationId: unparsedCommand.context.organizationId,
      ledgerId: snapshot.ledgerId,
      legalEntityId: snapshot.legalEntityId,
      periodId: command.periodId,
      partyAccountId: snapshot.partyAccountId,
    });
    if (setup.period_state === "HARD_CLOSED" || setup.period_state === "SEALED") {
      throw new Error("Settlement reversal requires an open or adjustment-only fiscal period");
    }
    if (command.accountingDate < setup.starts_on || command.accountingDate > setup.ends_on) {
      throw new Error("Settlement-void accounting date is outside the selected fiscal period");
    }
    if (setup.period_state === "ADJUSTMENT_ONLY") {
      await assertPermission(client, unparsedCommand.context, PERMISSIONS.postAdjustment);
    }
    const originalAllocations = await loadOriginalSettlementAllocations(
      client,
      unparsedCommand.context.organizationId,
      current.id,
    );
    const originalJournal = await loadOriginalPostedJournal(
      client,
      unparsedCommand.context.organizationId,
      current.id,
      policy.journalTypeKey,
    );
    const voidSource = await appendSourceDocument(client, {
      context: unparsedCommand.context,
      ownerModule: policy.ownerModule,
      sourceType: policy.sourceType,
      sourceNumber: command.sourceNumber,
      legalEntityId: snapshot.legalEntityId,
      version: current.version + 1,
      status: "VOIDED",
      snapshot,
      idempotencyKey,
      commandHash,
      supersedesSourceDocumentId: current.id,
      voidReason: command.reason,
    });
    const reversedAllocationIds = await insertExactAllocationReversals(client, {
      context: unparsedCommand.context,
      ledgerId: snapshot.ledgerId,
      voidSourceDocumentId: voidSource.id,
      originals: originalAllocations,
      baseIdempotencyKey: idempotencyKey,
      commandHash,
    });
    const journal = await insertAndPostJournal(client, {
      context: unparsedCommand.context,
      ledgerId: snapshot.ledgerId,
      legalEntityId: snapshot.legalEntityId,
      periodId: command.periodId,
      // There is no separate receipt/payment-void registry entry yet. Keeping
      // the original source-owned type plus REVERSAL purpose preserves correct
      // module routing and prevents GL editing.
      journalTypeKey: policy.journalTypeKey,
      ownerModule: policy.ownerModule,
      sourceDocumentId: current.id,
      sourceEventKey: `${policy.sourceType}:${voidSource.id}:void`,
      idempotencyKey,
      commandHash,
      purpose: "REVERSAL",
      accountingDate: command.accountingDate,
      functionalCurrency: snapshot.functionalCurrency,
      description: command.description,
      lines: reverseJournalLines(originalJournal.lines),
    });
    await client.query(
      `INSERT INTO journal_entry_relations (
         organization_id, from_journal_id, to_journal_id, kind, reason
       ) VALUES ($1, $2, $3, 'REVERSAL_OF', $4)`,
      [
        unparsedCommand.context.organizationId,
        journal.journalId,
        originalJournal.journal.id,
        command.reason,
      ],
    );
    return {
      document: recordFromRow(voidSource),
      idempotentReplay: false,
      journalId: journal.journalId,
      journalNumber: journal.journalNumber,
      reversedAllocationIds,
    };
  });
}
