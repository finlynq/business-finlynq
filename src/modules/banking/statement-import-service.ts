import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import { actorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import {
  createBlindIndex,
  encryptField,
  serializeEncryptedField,
} from "@/security/organization-encryption";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import { BankingServiceError } from "./banking-error";
import {
  bankStatementMappingSchema,
  previewBankStatementExtraction,
  type BankStatementExtraction,
  type BankStatementMapping,
  type BankStatementPreview,
  type NormalizedBankStatementRow,
} from "./statement-import-model";

type ExternalAccount = Readonly<{
  id: string;
  connection_id: string;
  credential_version: number;
  active: boolean;
  account_kind: "CASH" | "CREDIT_CARD";
  currency_code: string;
  legal_entity_id: string;
  ledger_id: string;
  cash_account_combination_id: string;
}>;

type PendingImportRow = Readonly<{
  id: string;
  row: NormalizedBankStatementRow;
  disposition: "IMPORTED" | "DUPLICATE" | "EXCLUDED";
  observationVersionId: string | null;
  ciphertext: string;
}>;

function encryptedValue(input: Readonly<{
  plaintext: string;
  organizationId: string;
  table: string;
  column: string;
  recordId: string;
  keyVersion: number;
  dek: Buffer;
}>): string {
  return serializeEncryptedField(encryptField(input.plaintext, input.dek, {
    organizationId: input.organizationId,
    table: input.table,
    column: input.column,
    recordId: input.recordId,
    keyVersion: input.keyVersion,
  }));
}

function blindDigest(value: string, dek: Buffer, organizationId: string, purpose: string): string {
  return createBlindIndex(value, dek, organizationId, purpose).slice("hmac-sha256-v1:".length);
}

async function requirePermission(
  client: PoolClient,
  context: TenantTransactionContext,
  permission: Permission,
): Promise<void> {
  const allowed = await actorHasActivePermission(client, {
    organizationId: context.organizationId,
    actorId: context.actorId,
    permission,
  });
  if (!allowed) {
    throw new BankingServiceError(
      `${permission} permission is required for this statement import.`,
      403,
      "BANK_STATEMENT_PERMISSION_REQUIRED",
    );
  }
}

async function validateLedgerMapping(
  client: PoolClient,
  context: TenantTransactionContext,
  input: Readonly<{
    accountKind: "CASH" | "CREDIT_CARD";
    legalEntityId: string;
    ledgerId: string;
    accountCombinationId: string;
    currencyCode: string;
  }>,
): Promise<void> {
  const expectedClass = input.accountKind === "CASH" ? "ASSET" : "LIABILITY";
  const result = await client.query(
    `SELECT 1
     FROM account_combinations combination
     JOIN gl_accounts account
       ON account.organization_id = combination.organization_id
      AND account.ledger_id = combination.ledger_id
      AND account.id = combination.account_id
      AND account.active AND account.postable
      AND account.control_kind = 'NONE' AND account.class = $5
     JOIN ledgers ledger
       ON ledger.organization_id = combination.organization_id
      AND ledger.id = combination.ledger_id AND ledger.active
      AND ledger.legal_entity_id = combination.entity_id
     JOIN legal_entities entity
       ON entity.organization_id = combination.organization_id
      AND entity.id = combination.entity_id AND entity.active
     JOIN organization_currencies enabled_currency
       ON enabled_currency.organization_id = combination.organization_id
      AND enabled_currency.currency_code = $6 AND enabled_currency.enabled
     WHERE combination.organization_id = $1 AND combination.id = $4
       AND combination.entity_id = $2 AND combination.ledger_id = $3
       AND combination.active
     FOR SHARE OF combination, account, ledger, entity, enabled_currency`,
    [
      context.organizationId,
      input.legalEntityId,
      input.ledgerId,
      input.accountCombinationId,
      expectedClass,
      input.currencyCode,
    ],
  );
  if (!result.rows[0]) {
    throw new BankingServiceError(
      input.accountKind === "CASH"
        ? "Choose an active postable non-control asset account in the selected company ledger."
        : "Choose an active postable non-control liability account in the selected company ledger.",
      400,
      "INVALID_STATEMENT_ACCOUNT_MAPPING",
    );
  }
}

async function fileImportConnection(
  client: PoolClient,
  context: TenantTransactionContext,
  key: Readonly<{ keyVersion: number; dek: Buffer }>,
): Promise<Readonly<{ id: string; credentialVersion: number }>> {
  await requirePermission(client, context, PERMISSIONS.manageBankConnections);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:file-import-connection:' || $1::text, 0))",
    [context.organizationId],
  );
  const existing = await client.query<{ id: string; credential_version: number; status: string }>(
    `SELECT id, credential_version, status
     FROM bank_connections
     WHERE organization_id = $1 AND provider = 'FILE_IMPORT'
     FOR UPDATE`,
    [context.organizationId],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].status !== "ACTIVE") {
      throw new BankingServiceError(
        "The statement-file import connection is disabled. An organization administrator must reactivate it.",
        409,
        "FILE_IMPORT_CONNECTION_DISABLED",
      );
    }
    return { id: existing.rows[0].id, credentialVersion: existing.rows[0].credential_version };
  }

  const connectionId = randomUUID();
  const idempotencyKey = `file-import:${context.organizationId}`;
  const commandHash = blindDigest(
    JSON.stringify({ provider: "FILE_IMPORT", version: 1 }),
    key.dek,
    context.organizationId,
    "bank.connection-command",
  );
  const credentialCiphertext = encryptedValue({
    plaintext: "document-inbox-local-v1",
    organizationId: context.organizationId,
    table: "bank_connections",
    column: "credentials_ciphertext",
    recordId: connectionId,
    keyVersion: key.keyVersion,
    dek: key.dek,
  });
  await client.query(
    `INSERT INTO bank_connections(
       id, organization_id, provider, display_name, credentials_ciphertext,
       credentials_key_version, credential_version, status, idempotency_key,
       command_hash, created_by
     ) VALUES ($1,$2,'FILE_IMPORT','Statement file imports',$3,$4,1,'ACTIVE',$5,$6,$7)`,
    [connectionId, context.organizationId, credentialCiphertext, key.keyVersion,
      idempotencyKey, commandHash, context.actorId],
  );
  await client.query(
    `INSERT INTO bank_connection_credential_events(
       organization_id, connection_id, credential_version, event_type,
       credential_ciphertext_hash, credential_key_version, idempotency_key,
       command_hash, created_by
     ) VALUES ($1,$2,1,'CREATED',$3,$4,$5,$6,$7)`,
    [context.organizationId, connectionId,
      createHash("sha256").update(credentialCiphertext).digest("hex"),
      key.keyVersion, idempotencyKey, commandHash, context.actorId],
  );
  return { id: connectionId, credentialVersion: 1 };
}

async function resolveExternalAccount(
  client: PoolClient,
  context: TenantTransactionContext,
  preview: BankStatementPreview,
  untrustedMapping: BankStatementMapping,
  expectedLegalEntityId: string,
  key: Readonly<{ keyVersion: number; dek: Buffer }>,
): Promise<ExternalAccount> {
  const mapping = bankStatementMappingSchema.parse(untrustedMapping);
  if (mapping.mode === "EXISTING_ACCOUNT") {
    const selected = await client.query<ExternalAccount>(
      `SELECT external.id, external.connection_id, connection.credential_version,
         external.active, external.account_kind, external.currency_code, external.legal_entity_id,
         external.ledger_id, external.cash_account_combination_id
       FROM bank_external_accounts external
       JOIN bank_connections connection
         ON connection.organization_id = external.organization_id
        AND connection.id = external.connection_id
       WHERE external.organization_id = $1 AND external.id = $2
         AND external.active AND connection.status = 'ACTIVE'
         AND external.legal_entity_id = $3
         AND external.ledger_id IS NOT NULL
         AND external.cash_account_combination_id IS NOT NULL
       FOR UPDATE OF external`,
      [context.organizationId, mapping.externalAccountId, expectedLegalEntityId],
    );
    const account = selected.rows[0];
    if (!account) {
      throw new BankingServiceError(
        "Choose an active mapped banking account in this organization.",
        400,
        "STATEMENT_ACCOUNT_NOT_MAPPED",
      );
    }
    if (account.account_kind !== preview.accountKind || account.currency_code !== preview.currencyCode) {
      throw new BankingServiceError(
        "The selected banking account kind and currency must match the reviewed statement.",
        409,
        "STATEMENT_ACCOUNT_MISMATCH",
      );
    }
    await validateLedgerMapping(client, context, {
      accountKind: account.account_kind,
      legalEntityId: account.legal_entity_id,
      ledgerId: account.ledger_id,
      accountCombinationId: account.cash_account_combination_id,
      currencyCode: account.currency_code,
    });
    return account;
  }

  if (mapping.legalEntityId !== expectedLegalEntityId) {
    throw new BankingServiceError(
      "The statement account mapping must belong to the inbox company.",
      400,
      "STATEMENT_ACCOUNT_ENTITY_MISMATCH",
    );
  }
  await validateLedgerMapping(client, context, {
    accountKind: preview.accountKind,
    legalEntityId: mapping.legalEntityId,
    ledgerId: mapping.ledgerId,
    accountCombinationId: mapping.accountCombinationId,
    currencyCode: preview.currencyCode,
  });
  const connection = await fileImportConnection(client, context, key);
  const identity = JSON.stringify({
    version: 1,
    institution: preview.institution,
    maskedAccount: preview.maskedAccount,
    accountKind: preview.accountKind,
    currencyCode: preview.currencyCode,
  });
  const identityHash = createBlindIndex(
    identity,
    key.dek,
    context.organizationId,
    "bank.provider-account-id",
  );
  let selected = await client.query<ExternalAccount>(
    `SELECT external.id, external.connection_id, connection.credential_version,
       external.active, external.account_kind, external.currency_code, external.legal_entity_id,
       external.ledger_id, external.cash_account_combination_id
     FROM bank_external_accounts external
     JOIN bank_connections connection
       ON connection.organization_id = external.organization_id
      AND connection.id = external.connection_id
     WHERE external.organization_id = $1 AND external.connection_id = $2
       AND external.provider_account_id_hash = $3
     FOR UPDATE OF external`,
    [context.organizationId, connection.id, identityHash],
  );
  if (!selected.rows[0]) {
    const externalAccountId = randomUUID();
    const providerIdCiphertext = encryptedValue({
      plaintext: identity,
      organizationId: context.organizationId,
      table: "bank_external_accounts",
      column: "provider_account_id_ciphertext",
      recordId: externalAccountId,
      keyVersion: key.keyVersion,
      dek: key.dek,
    });
    const displayNameCiphertext = encryptedValue({
      plaintext: `${preview.institution} ${preview.maskedAccount}`,
      organizationId: context.organizationId,
      table: "bank_external_accounts",
      column: "display_name_ciphertext",
      recordId: externalAccountId,
      keyVersion: key.keyVersion,
      dek: key.dek,
    });
    await client.query(
      `INSERT INTO bank_external_accounts(
         id, organization_id, connection_id, provider_account_id_hash,
         provider_account_id_ciphertext, display_name_ciphertext, key_version,
         currency_code, account_kind, legal_entity_id, ledger_id,
         cash_account_combination_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [externalAccountId, context.organizationId, connection.id, identityHash,
        providerIdCiphertext, displayNameCiphertext, key.keyVersion,
        preview.currencyCode, preview.accountKind, mapping.legalEntityId,
        mapping.ledgerId, mapping.accountCombinationId],
    );
    selected = await client.query<ExternalAccount>(
      `SELECT external.id, external.connection_id, connection.credential_version,
         external.active, external.account_kind, external.currency_code, external.legal_entity_id,
         external.ledger_id, external.cash_account_combination_id
       FROM bank_external_accounts external
       JOIN bank_connections connection
         ON connection.organization_id = external.organization_id
        AND connection.id = external.connection_id
       WHERE external.organization_id = $1 AND external.id = $2
       FOR UPDATE OF external`,
      [context.organizationId, externalAccountId],
    );
  }
  const account = selected.rows[0];
  if (!account) throw new Error("Statement account could not be persisted");
  if (!account.active) {
    throw new BankingServiceError(
      "This statement account is inactive. Reactivate the retained mapping before importing another statement.",
      409,
      "STATEMENT_ACCOUNT_INACTIVE",
    );
  }
  if (
    account.account_kind !== preview.accountKind
    || account.currency_code !== preview.currencyCode
    || account.legal_entity_id !== mapping.legalEntityId
    || account.ledger_id !== mapping.ledgerId
    || account.cash_account_combination_id !== mapping.accountCombinationId
  ) {
    throw new BankingServiceError(
      "This statement identity is already mapped differently. Choose the retained account or review its mapping.",
      409,
      "STATEMENT_IDENTITY_MAPPING_CONFLICT",
    );
  }
  return account;
}

async function reconciliationForImport(
  client: PoolClient,
  context: TenantTransactionContext,
  account: ExternalAccount,
  preview: BankStatementPreview,
  statementImportId: string,
  key: Readonly<{ dek: Buffer }>,
): Promise<Readonly<{ id: string; reused: boolean }>> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:bank-reconciliation-chain:' || $1::text || ':' || $2::text, 0))",
    [context.organizationId, account.id],
  );
  const overlap = await client.query<{
    id: string;
    statement_start_on: string;
    statement_end_on: string;
    opening_balance: string;
    closing_balance: string;
    currency_code: string;
    status: "DRAFT" | "SUBMITTED" | "REVIEWED" | "FINALIZED";
  }>(
    `SELECT id, statement_start_on::text, statement_end_on::text,
       opening_balance::text, closing_balance::text, currency_code, status
     FROM bank_reconciliation_sessions
     WHERE organization_id = $1 AND external_account_id = $2
       AND status <> 'VOIDED'
       AND statement_start_on <= $4::date AND statement_end_on >= $3::date
     FOR SHARE`,
    [context.organizationId, account.id, preview.statementStartOn, preview.statementEndOn],
  );
  if (overlap.rows.length > 0) {
    const same = overlap.rows.find((row) => (
      row.statement_start_on === preview.statementStartOn
      && row.statement_end_on === preview.statementEndOn
      && row.currency_code === preview.currencyCode
      && row.opening_balance === preview.openingBalance
      && row.closing_balance === preview.closingBalance
    ));
    if (same && overlap.rows.length === 1) {
      if (same.status !== "DRAFT") {
        throw new BankingServiceError(
          "This statement period is already submitted or closed. Preserve the locked reconciliation and review the later file separately.",
          409,
          "RECONCILIATION_PERIOD_LOCKED",
        );
      }
      return { id: same.id, reused: true };
    }
    throw new BankingServiceError(
      "This statement period overlaps a different reconciliation. Import the missing transactions into the retained period or void the incorrect draft first.",
      409,
      "RECONCILIATION_OVERLAP",
    );
  }

  const previous = await client.query<{ status: string; adjacent: boolean; closing_balance: string }>(
    `SELECT status, statement_end_on + 1 = $3::date AS adjacent,
       closing_balance::text
     FROM bank_reconciliation_sessions
     WHERE organization_id = $1 AND external_account_id = $2
       AND status <> 'VOIDED' AND statement_end_on < $3::date
     ORDER BY statement_end_on DESC, created_at DESC LIMIT 1`,
    [context.organizationId, account.id, preview.statementStartOn],
  );
  const predecessor = previous.rows[0];
  if (predecessor?.status !== undefined && predecessor.status !== "FINALIZED") {
    throw new BankingServiceError(
      "Finalize the preceding reconciliation before importing its successor.",
      409,
      "PREVIOUS_RECONCILIATION_NOT_FINALIZED",
    );
  }
  if (predecessor && !predecessor.adjacent) {
    throw new BankingServiceError(
      "The next statement must begin on the day after the preceding finalized statement.",
      409,
      "RECONCILIATION_PERIOD_GAP",
    );
  }
  if (predecessor && predecessor.closing_balance !== preview.openingBalance) {
    throw new BankingServiceError(
      "The statement opening balance must equal the preceding finalized closing balance.",
      409,
      "OPENING_BALANCE_DISCONTINUITY",
    );
  }
  const future = await client.query(
    `SELECT 1 FROM bank_reconciliation_sessions
     WHERE organization_id = $1 AND external_account_id = $2
       AND status <> 'VOIDED' AND statement_start_on > $3::date
     LIMIT 1`,
    [context.organizationId, account.id, preview.statementEndOn],
  );
  if (future.rows[0]) {
    throw new BankingServiceError(
      "Import statements for this account in chronological order.",
      409,
      "RECONCILIATION_OUT_OF_ORDER",
    );
  }

  const reconciliationId = randomUUID();
  const idempotencyKey = `statement-import:${statementImportId}`;
  const commandHash = blindDigest(
    JSON.stringify({
      externalAccountId: account.id,
      statementStartOn: preview.statementStartOn,
      statementEndOn: preview.statementEndOn,
      openingBalance: preview.openingBalance,
      closingBalance: preview.closingBalance,
      previewHash: preview.previewHash,
    }),
    key.dek,
    context.organizationId,
    "bank.reconciliation-command",
  );
  await client.query(
    `INSERT INTO bank_reconciliation_sessions(
       id, organization_id, external_account_id, legal_entity_id, ledger_id,
       cash_account_combination_id, statement_start_on, statement_end_on,
       opening_balance, closing_balance, currency_code, status, version,
       idempotency_key, command_hash, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT',1,$12,$13,$14)`,
    [reconciliationId, context.organizationId, account.id,
      account.legal_entity_id, account.ledger_id,
      account.cash_account_combination_id, preview.statementStartOn,
      preview.statementEndOn, preview.openingBalance, preview.closingBalance,
      preview.currencyCode, idempotencyKey, commandHash, context.actorId],
  );
  return { id: reconciliationId, reused: false };
}

async function transferCandidates(
  client: PoolClient,
  context: TenantTransactionContext,
  externalAccountId: string,
  versionIds: readonly string[],
) {
  if (versionIds.length === 0) return [];
  const result = await client.query<{
    source_version_id: string;
    counterpart_version_id: string;
    source_account_id: string;
    counterpart_account_id: string;
    posted_on: string;
    amount: string;
    currency_code: string;
  }>(
    `SELECT source.id AS source_version_id, counterpart.id AS counterpart_version_id,
       source_observation.external_account_id AS source_account_id,
       counterpart_observation.external_account_id AS counterpart_account_id,
       source.posted_on::text, source.amount::text, source.currency_code
     FROM bank_observation_versions source
     JOIN bank_observations source_observation
       ON source_observation.organization_id = source.organization_id
      AND source_observation.id = source.observation_id
     JOIN bank_observation_versions counterpart
       ON counterpart.organization_id = source.organization_id
      AND counterpart.currency_code = source.currency_code
      AND counterpart.amount = -source.amount
      AND counterpart.posted_on BETWEEN source.posted_on - 3 AND source.posted_on + 3
     JOIN bank_observations counterpart_observation
       ON counterpart_observation.organization_id = counterpart.organization_id
      AND counterpart_observation.id = counterpart.observation_id
      AND counterpart_observation.external_account_id <> source_observation.external_account_id
     WHERE source.organization_id = $1
       AND source.status = 'POSTED'
       AND counterpart.status = 'POSTED'
       AND source_observation.external_account_id = $2
       AND source.id = ANY($3::uuid[])
       AND NOT EXISTS (
         SELECT 1 FROM bank_observation_versions newer
         WHERE newer.organization_id = counterpart.organization_id
           AND newer.observation_id = counterpart.observation_id
           AND newer.version_number > counterpart.version_number
       )
       AND NOT EXISTS (
         SELECT 1 FROM bank_match_allocations allocation
         LEFT JOIN bank_match_allocation_voids void
           ON void.organization_id = allocation.organization_id
          AND void.allocation_id = allocation.id
         WHERE allocation.organization_id = source.organization_id
           AND allocation.observation_version_id IN (source.id, counterpart.id)
           AND void.id IS NULL
       )
     ORDER BY source.posted_on, source.id, counterpart.id
     LIMIT 50`,
    [context.organizationId, externalAccountId, versionIds],
  );
  return result.rows.map((row) => ({
    sourceObservationVersionId: row.source_version_id,
    counterpartObservationVersionId: row.counterpart_version_id,
    sourceAccountId: row.source_account_id,
    counterpartAccountId: row.counterpart_account_id,
    postedOn: row.posted_on,
    amount: row.amount,
    currencyCode: row.currency_code,
    instruction: "Review this opposite-value pair as a possible transfer. No journal or match was created.",
  }));
}

export async function importBankStatementInTransaction(
  client: PoolClient,
  input: Readonly<{
    context: TenantTransactionContext;
    inboxItemId: string;
    evidenceAssetId: string;
    sourceSha256: string;
    extraction: BankStatementExtraction;
    mapping: BankStatementMapping;
    previewHash: string;
    expectedLegalEntityId: string;
  }>,
) {
  await requirePermission(client, input.context, PERMISSIONS.syncBanking);
  await requirePermission(client, input.context, PERMISSIONS.prepareBankReconciliation);
  const preview = previewBankStatementExtraction(input.extraction);
  if (!preview.readyToImport) {
    throw new BankingServiceError(
      "The bank-statement extraction has unresolved validation issues. Preview and correct it before importing.",
      400,
      "STATEMENT_PREVIEW_INVALID",
    );
  }
  if (preview.previewHash !== input.previewHash) {
    throw new BankingServiceError(
      "The bank-statement extraction changed after review. Generate and review a new previewHash.",
      409,
      "STATEMENT_PREVIEW_CHANGED",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.sourceSha256)) {
    throw new BankingServiceError("The source statement checksum is invalid.", 400, "STATEMENT_CHECKSUM_INVALID");
  }

  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:statement-import:' || $1::text || ':' || $2::text, 0))",
    [input.context.organizationId, input.inboxItemId],
  );
  const replay = await client.query<{
    id: string;
    external_account_id: string;
    reconciliation_session_id: string | null;
    evidence_asset_id: string;
    source_sha256: string;
    preview_hash: string;
    included_row_count: number;
    excluded_row_count: number;
    duplicate_row_count: number;
  }>(
    `SELECT id, external_account_id, reconciliation_session_id, evidence_asset_id,
       source_sha256, preview_hash, included_row_count, excluded_row_count, duplicate_row_count
     FROM bank_statement_imports
     WHERE organization_id = $1 AND inbox_item_id = $2`,
    [input.context.organizationId, input.inboxItemId],
  );
  if (replay.rows[0]) {
    if (replay.rows[0].source_sha256 !== input.sourceSha256 || replay.rows[0].preview_hash !== preview.previewHash) {
      throw new BankingServiceError(
        "This inbox statement was already imported with different reviewed facts.",
        409,
        "STATEMENT_IMPORT_CONFLICT",
      );
    }
    return {
      statementImportId: replay.rows[0].id,
      externalAccountId: replay.rows[0].external_account_id,
      reconciliationId: replay.rows[0].reconciliation_session_id,
      evidenceAssetId: replay.rows[0].evidence_asset_id,
      importedRowCount: replay.rows[0].included_row_count - replay.rows[0].duplicate_row_count,
      duplicateRowCount: replay.rows[0].duplicate_row_count,
      excludedRowCount: replay.rows[0].excluded_row_count,
      idempotentReplay: true,
      duplicateSource: false,
      transferCandidates: [],
      instruction: "The reviewed statement import already exists. No journal was posted.",
    };
  }

  const key = await loadActiveOrganizationKey(client, input.context.organizationId);
  try {
    const account = await resolveExternalAccount(
      client,
      input.context,
      preview,
      input.mapping,
      input.expectedLegalEntityId,
      key,
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:bank-evidence:' || $1::text || ':' || $2::text, 0))",
      [input.context.organizationId, account.id],
    );
    const sameSource = await client.query<{
      id: string;
      reconciliation_session_id: string | null;
      evidence_asset_id: string;
      included_row_count: number;
    }>(
      `SELECT id, reconciliation_session_id, evidence_asset_id, included_row_count
       FROM bank_statement_imports
       WHERE organization_id = $1 AND external_account_id = $2
         AND source_sha256 = $3`,
      [input.context.organizationId, account.id, input.sourceSha256],
    );
    if (sameSource.rows[0]) {
      return {
        statementImportId: sameSource.rows[0].id,
        externalAccountId: account.id,
        reconciliationId: sameSource.rows[0].reconciliation_session_id,
        evidenceAssetId: input.evidenceAssetId,
        importedRowCount: 0,
        duplicateRowCount: sameSource.rows[0].included_row_count,
        excludedRowCount: preview.excludedRowCount,
        idempotentReplay: false,
        duplicateSource: true,
        transferCandidates: [],
        instruction: "This exact source file was imported previously. The new inbox evidence can be archived, but no observations or journal were created.",
      };
    }

    const statementImportId = randomUUID();
    const reconciliation = await reconciliationForImport(
      client, input.context, account, preview, statementImportId, key,
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:bank-sync-connection:' || $1::text || ':' || $2::text, 0))",
      [input.context.organizationId, account.connection_id],
    );
    const running = await client.query(
      "SELECT 1 FROM bank_sync_runs WHERE organization_id = $1 AND connection_id = $2 AND status = 'RUNNING'",
      [input.context.organizationId, account.connection_id],
    );
    if (running.rows[0]) {
      throw new BankingServiceError(
        "This banking connection is synchronizing. Retry the statement import after that run finishes.",
        409,
        "BANK_SYNC_IN_PROGRESS",
      );
    }

    const syncRunId = randomUUID();
    await client.query(
      `INSERT INTO bank_sync_runs(
         id, organization_id, connection_id, credential_version, status,
         requested_start_on, requested_end_on, created_by
       ) VALUES ($1,$2,$3,$4,'RUNNING',$5,$6,$7)`,
      [syncRunId, input.context.organizationId, account.connection_id,
        account.credential_version, preview.statementStartOn,
        preview.statementEndOn, input.context.actorId],
    );

    const pendingRows: PendingImportRow[] = [];
    let importedRowCount = 0;
    let duplicateRowCount = 0;
    const importedVersionIds: string[] = [];
    for (const row of preview.rows) {
      const rowId = randomUUID();
      const rowCiphertext = encryptedValue({
        plaintext: JSON.stringify(row),
        organizationId: input.context.organizationId,
        table: "bank_statement_import_rows",
        column: "row_ciphertext",
        recordId: rowId,
        keyVersion: key.keyVersion,
        dek: key.dek,
      });
      if (row.excluded) {
        pendingRows.push({
          id: rowId, row, disposition: "EXCLUDED",
          observationVersionId: null, ciphertext: rowCiphertext,
        });
        continue;
      }

      const providerTransactionId = `statement-row:${row.fingerprint}`;
      const providerTransactionHash = createBlindIndex(
        providerTransactionId, key.dek, input.context.organizationId,
        `bank.transaction-id.${account.id}`,
      );
      let observation = await client.query<{ id: string }>(
        `SELECT id FROM bank_observations
         WHERE organization_id = $1 AND external_account_id = $2
           AND provider_transaction_id_hash = $3`,
        [input.context.organizationId, account.id, providerTransactionHash],
      );
      if (!observation.rows[0]) {
        const observationId = randomUUID();
        const transactionIdCiphertext = encryptedValue({
          plaintext: providerTransactionId,
          organizationId: input.context.organizationId,
          table: "bank_observations",
          column: "provider_transaction_id_ciphertext",
          recordId: observationId,
          keyVersion: key.keyVersion,
          dek: key.dek,
        });
        await client.query(
          `INSERT INTO bank_observations(
             id, organization_id, external_account_id, provider_transaction_id_hash,
             provider_transaction_id_ciphertext, key_version, first_seen_run_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (external_account_id, provider_transaction_id_hash) DO NOTHING`,
          [observationId, input.context.organizationId, account.id,
            providerTransactionHash, transactionIdCiphertext, key.keyVersion, syncRunId],
        );
        observation = await client.query<{ id: string }>(
          `SELECT id FROM bank_observations
           WHERE organization_id = $1 AND external_account_id = $2
             AND provider_transaction_id_hash = $3`,
          [input.context.organizationId, account.id, providerTransactionHash],
        );
      }
      const observationId = observation.rows[0]?.id;
      if (!observationId) throw new Error("Statement observation identity could not be persisted");

      const details = {
        payee: row.payee,
        description: row.description,
        memo: row.reference,
        merchantCategoryCode: null,
        source: "STATEMENT_FILE",
        direction: row.direction,
        sourceKind: row.sourceKind,
        originalAmount: row.originalAmount,
        originalCurrency: row.originalCurrency,
      };
      const canonicalContent = JSON.stringify({
        status: row.status,
        postedOn: row.postedOn,
        transactedAt: null,
        amount: row.amount,
        currencyCode: row.currencyCode,
        details,
      });
      const contentHash = createBlindIndex(
        canonicalContent, key.dek, input.context.organizationId,
        "bank.observation-content",
      );
      const existingVersion = await client.query<{ id: string }>(
        `SELECT id FROM bank_observation_versions
         WHERE organization_id = $1 AND observation_id = $2 AND content_hash = $3`,
        [input.context.organizationId, observationId, contentHash],
      );
      let observationVersionId = existingVersion.rows[0]?.id;
      let disposition: PendingImportRow["disposition"] = "DUPLICATE";
      if (!observationVersionId) {
        const nextVersion = await client.query<{ next_version: number }>(
          `SELECT coalesce(max(version_number), 0)::int + 1 AS next_version
           FROM bank_observation_versions
           WHERE organization_id = $1 AND observation_id = $2`,
          [input.context.organizationId, observationId],
        );
        observationVersionId = randomUUID();
        const detailsCiphertext = encryptedValue({
          plaintext: JSON.stringify(details),
          organizationId: input.context.organizationId,
          table: "bank_observation_versions",
          column: "details_ciphertext",
          recordId: observationVersionId,
          keyVersion: key.keyVersion,
          dek: key.dek,
        });
        await client.query(
          `INSERT INTO bank_observation_versions(
             id, organization_id, observation_id, sync_run_id, version_number,
             content_hash, status, posted_on, transacted_at, amount, currency_code,
             details_ciphertext, key_version
           ) VALUES ($1,$2,$3,$4,$5,$6,'POSTED',$7,NULL,$8,$9,$10,$11)`,
          [observationVersionId, input.context.organizationId, observationId,
            syncRunId, nextVersion.rows[0]?.next_version ?? 1, contentHash,
            row.postedOn, row.amount, row.currencyCode, detailsCiphertext,
            key.keyVersion],
        );
        disposition = "IMPORTED";
        importedRowCount += 1;
        importedVersionIds.push(observationVersionId);
      } else {
        duplicateRowCount += 1;
      }
      pendingRows.push({
        id: rowId, row, disposition, observationVersionId, ciphertext: rowCiphertext,
      });
    }

    await client.query(
      `INSERT INTO bank_balance_anchors(
         organization_id, external_account_id, sync_run_id, balance,
         available_balance, currency_code, balance_at
       ) VALUES ($1,$2,$3,$4,NULL,$5,($6::date + interval '1 day' - interval '1 millisecond'))
       ON CONFLICT (external_account_id, sync_run_id) DO NOTHING`,
      [input.context.organizationId, account.id, syncRunId,
        preview.closingBalance, preview.currencyCode, preview.statementEndOn],
    );

    const extractionCiphertext = encryptedValue({
      plaintext: JSON.stringify({ preview, mapping: input.mapping, confirmedBy: input.context.actorId }),
      organizationId: input.context.organizationId,
      table: "bank_statement_imports",
      column: "extraction_ciphertext",
      recordId: statementImportId,
      keyVersion: key.keyVersion,
      dek: key.dek,
    });
    await client.query(
      `INSERT INTO bank_statement_imports(
         id, organization_id, inbox_item_id, evidence_asset_id,
         external_account_id, sync_run_id, reconciliation_session_id,
         source_sha256, extraction_version, extraction_ciphertext, key_version,
         preview_hash, statement_start_on, statement_end_on, opening_balance,
         closing_balance, currency_code, included_row_count, excluded_row_count,
         duplicate_row_count, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [statementImportId, input.context.organizationId, input.inboxItemId,
        input.evidenceAssetId, account.id, syncRunId, reconciliation.id,
        input.sourceSha256, preview.extractionVersion, extractionCiphertext,
        key.keyVersion, preview.previewHash, preview.statementStartOn,
        preview.statementEndOn, preview.openingBalance, preview.closingBalance,
        preview.currencyCode, preview.includedRowCount, preview.excludedRowCount,
        duplicateRowCount, input.context.actorId],
    );
    for (const pending of pendingRows) {
      await client.query(
        `INSERT INTO bank_statement_import_rows(
           id, organization_id, statement_import_id, source_row_number,
           row_fingerprint, disposition, observation_version_id,
           row_ciphertext, key_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [pending.id, input.context.organizationId, statementImportId,
          pending.row.rowNumber,
          blindDigest(
            pending.row.fingerprint,
            key.dek,
            input.context.organizationId,
            "bank.statement-row-fingerprint",
          ),
          pending.disposition, pending.observationVersionId,
          pending.ciphertext, key.keyVersion],
      );
    }
    await client.query(
      `UPDATE bank_sync_runs SET status = 'SUCCEEDED', account_count = 1,
         observation_count = $3, version_count = $4,
         provider_warning_count = 0, completed_at = now()
       WHERE organization_id = $1 AND id = $2 AND status = 'RUNNING'`,
      [input.context.organizationId, syncRunId,
        preview.includedRowCount, importedRowCount],
    );
    await client.query(
      `UPDATE bank_external_accounts SET last_reported_balance = $3,
         last_balance_at = ($4::date + interval '1 day' - interval '1 millisecond')
       WHERE organization_id = $1 AND id = $2`,
      [input.context.organizationId, account.id,
        preview.closingBalance, preview.statementEndOn],
    );
    await client.query(
      `UPDATE bank_connections SET last_synced_at = now(), last_error_code = NULL
       WHERE organization_id = $1 AND id = $2 AND credential_version = $3`,
      [input.context.organizationId, account.connection_id, account.credential_version],
    );

    return {
      statementImportId,
      externalAccountId: account.id,
      reconciliationId: reconciliation.id,
      evidenceAssetId: input.evidenceAssetId,
      reconciliationReused: reconciliation.reused,
      importedRowCount,
      duplicateRowCount,
      excludedRowCount: preview.excludedRowCount,
      idempotentReplay: false,
      duplicateSource: false,
      transferCandidates: await transferCandidates(
        client, input.context, account.id, importedVersionIds,
      ),
      instruction: "Immutable observations and a draft reconciliation were created. Review and match them in banking. No journal was posted.",
    };
  } finally {
    key.dek.fill(0);
  }
}
