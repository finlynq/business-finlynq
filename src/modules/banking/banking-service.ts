import "server-only";

import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction } from "@/db/transaction";
import {
  createCommandFingerprint,
  matchesStoredCommandFingerprint,
} from "@/kernel/command-fingerprint";
import { actorHasActivePermission, assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import {
  hasRecentStepUp,
  type SessionPrincipal,
} from "@/modules/identity/session";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
  mutationContext,
  principalCanWrite,
} from "@/modules/workspace/write-policy";
import {
  createBlindIndex,
  decryptField,
  encryptField,
  parseEncryptedField,
  serializeEncryptedField,
} from "@/security/organization-encryption";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import {
  exchangeSimpleFinSetupToken,
  fetchSimpleFinAccounts,
  SimpleFinClientError,
} from "./simplefin-client";
import {
  normalizeSimpleFinPayload,
  type NormalizedBankTransaction,
} from "./simplefin-transform";
import { consumeBankingProviderOrganizationRateLimit } from "./rate-limit";
import { BankingServiceError } from "./banking-error";
export { BankingServiceError } from "./banking-error";

const decimalSchema = z.string().trim().regex(/^-?\d+(?:\.\d{1,9})?$/).refine((value) => {
  try {
    return new Decimal(value).abs().lessThanOrEqualTo("99999999999999999999999999999");
  } catch {
    return false;
  }
});
const idempotencyKeySchema = z.string().trim().min(1).max(180);
const matchAllocationAmountSchema = z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/);
const bankMatchAllocationFingerprintVersion = "v2";

export const bankRuleConditionSchema = z.object({
  descriptionContains: z.string().trim().min(2).max(100).optional(),
  direction: z.enum(["ANY", "INFLOW", "OUTFLOW"]).default("ANY"),
  minimumAbsoluteAmount: decimalSchema.optional(),
  maximumAbsoluteAmount: decimalSchema.optional(),
  merchantCategoryCode: z.string().trim().regex(/^[A-Za-z0-9_-]{2,16}$/).optional(),
  externalAccountId: z.uuid().optional(),
}).strict().refine((value) => (
  value.descriptionContains !== undefined || value.direction !== "ANY" ||
  value.minimumAbsoluteAmount !== undefined || value.maximumAbsoluteAmount !== undefined ||
  value.merchantCategoryCode !== undefined || value.externalAccountId !== undefined
), { message: "A rule needs at least one condition" }).refine((value) => (
  value.minimumAbsoluteAmount === undefined || value.maximumAbsoluteAmount === undefined ||
  new Decimal(value.maximumAbsoluteAmount).greaterThanOrEqualTo(value.minimumAbsoluteAmount)
), { message: "The maximum amount must not be below the minimum amount" });

export const bankRuleActionSchema = z.object({
  kind: z.literal("MANUAL_REVIEW"),
  targetAccountCombinationId: z.uuid().optional(),
  memo: z.string().trim().max(500).optional(),
}).strict();

export type BankRuleCondition = z.output<typeof bankRuleConditionSchema>;
export type BankRuleAction = z.output<typeof bankRuleActionSchema>;

function bankingContext(principal: SessionPrincipal, requestId: string, reason: string) {
  return mutationContext(principal, requestId, { reason, sourceSurface: "IMPORT" });
}

function assertBankingSession(principal: SessionPrincipal, options: Readonly<{ stepUp?: boolean; externalProvider?: boolean }> = {}): void {
  if (!principalCanWrite(principal)) {
    throw new BankingServiceError("A writable business account is required.", 403, "WRITES_DISABLED");
  }
  if (principal.sessionMode === "demo" && options.externalProvider) {
    throw new BankingServiceError(
      "External bank credentials are disabled in the public demo. Create a private account to connect SimpleFIN.",
      403,
      "DEMO_EXTERNAL_CONNECTIONS_DISABLED",
    );
  }
  if (options.externalProvider && process.env.BANK_FEEDS_ENABLED !== "true") {
    throw new BankingServiceError("Bank feeds are disabled by this deployment.", 503, "BANK_FEEDS_DISABLED");
  }
  if (options.stepUp && !hasRecentStepUp(principal)) {
    throw new BankingServiceError(
      "Verify your authenticator before changing encrypted bank credentials.",
      428,
      "MFA_STEP_UP_REQUIRED",
    );
  }
}

async function withAuthorizedBankingWrite<T>(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  permission: Permission | null;
  reason: string;
}>, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const context = bankingContext(input.principal, input.requestId, input.reason);
  assertTenantWritesEnabled(context);
  return withTenantTransaction(context, async (client) => {
    await assertWritableOrganization(client, context);
    if (input.permission) {
      await assertActorHasActivePermission(client, {
        organizationId: input.principal.organizationId,
        actorId: input.principal.userId,
        permission: input.permission,
      });
    }
    return work(client);
  });
}

function blindDigest(value: string, dek: Buffer, organizationId: string, purpose: string): string {
  return createBlindIndex(value, dek, organizationId, purpose).slice("hmac-sha256-v1:".length);
}

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

async function lockBankEvidence(
  client: PoolClient,
  organizationId: string,
  externalAccountId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:bank-evidence:' || $1::text || ':' || $2::text, 0))",
    [organizationId, externalAccountId],
  );
}

export async function connectSimpleFin(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  displayName: string;
  setupToken: string;
  idempotencyKey: string;
}>): Promise<Readonly<{ connectionId: string; idempotentReplay: boolean }>> {
  assertBankingSession(input.principal, { stepUp: true, externalProvider: true });
  const connectionId = randomUUID();
  const commandFingerprint = await withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: `${input.requestId}:preflight`,
    permission: PERMISSIONS.manageBankConnections,
    reason: "Validate a SimpleFIN connection request before consuming its one-time token",
  }, async (client) => {
    const key = await loadActiveOrganizationKey(client, input.principal.organizationId);
    try {
      const commandHash = blindDigest(
        JSON.stringify({ provider: "SIMPLEFIN", displayName: input.displayName, setupToken: input.setupToken }),
        key.dek,
        input.principal.organizationId,
        "bank.connection-command",
      );
      const replay = await client.query<{ id: string; command_hash: string }>(
        `SELECT id, command_hash FROM bank_connections
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [input.principal.organizationId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].command_hash !== commandHash) {
          throw new BankingServiceError("The connection idempotency key was already used for another request.", 409, "IDEMPOTENCY_CONFLICT");
        }
        return { commandHash, replayId: replay.rows[0].id };
      }
      const existing = await client.query(
        `SELECT 1 FROM bank_connections
         WHERE organization_id = $1 AND provider = 'SIMPLEFIN'`,
        [input.principal.organizationId],
      );
      if (existing.rows[0]) {
        throw new BankingServiceError("This organization already has a SimpleFIN connection.", 409, "PROVIDER_ALREADY_CONNECTED");
      }
      return { commandHash, replayId: null };
    } finally {
      key.dek.fill(0);
    }
  });
  if (commandFingerprint.replayId) {
    return { connectionId: commandFingerprint.replayId, idempotentReplay: true };
  }

  const organizationRateLimit = await consumeBankingProviderOrganizationRateLimit(
    input.principal.organizationId,
    "connect",
  );
  if (!organizationRateLimit.allowed) {
    throw new BankingServiceError(
      "This business has reached its secure bank-connection attempt limit. Try again later.",
      429,
      "BANK_CONNECTION_RATE_LIMITED",
      organizationRateLimit.retryAfterSeconds,
    );
  }

  const accessUrl = await exchangeSimpleFinSetupToken(input.setupToken);
  return withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.manageBankConnections,
    reason: "Store an organization-encrypted SimpleFIN access credential",
  }, async (client) => {
    const key = await loadActiveOrganizationKey(client, input.principal.organizationId);
    try {
      const ciphertext = encryptedValue({
        plaintext: accessUrl,
        organizationId: input.principal.organizationId,
        table: "bank_connections",
        column: "credentials_ciphertext",
        recordId: connectionId,
        keyVersion: key.keyVersion,
        dek: key.dek,
      });
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO bank_connections(
           id, organization_id, provider, display_name,
           credentials_ciphertext, credentials_key_version, status,
           idempotency_key, command_hash, created_by
         ) VALUES ($1,$2,'SIMPLEFIN',$3,$4,$5,'ACTIVE',$6,$7,$8)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [connectionId, input.principal.organizationId, input.displayName, ciphertext,
          key.keyVersion, input.idempotencyKey, commandFingerprint.commandHash, input.principal.userId],
      );
      if (inserted.rows[0]) {
        await client.query(
          `INSERT INTO bank_connection_credential_events(
             organization_id, connection_id, credential_version, event_type,
             credential_ciphertext_hash, credential_key_version,
             idempotency_key, command_hash, created_by
           ) VALUES ($1,$2,1,'CREATED',$3,$4,$5,$6,$7)`,
          [input.principal.organizationId, inserted.rows[0].id,
            createHash("sha256").update(ciphertext).digest("hex"), key.keyVersion,
            input.idempotencyKey, commandFingerprint.commandHash, input.principal.userId],
        );
        return { connectionId: inserted.rows[0].id, idempotentReplay: false };
      }
      const replay = await client.query<{ id: string; command_hash: string }>(
        `SELECT id, command_hash FROM bank_connections
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [input.principal.organizationId, input.idempotencyKey],
      );
      if (!replay.rows[0] || replay.rows[0].command_hash !== commandFingerprint.commandHash) {
        throw new BankingServiceError("The connection request conflicted with another change.", 409, "CONNECTION_CONFLICT");
      }
      return { connectionId: replay.rows[0].id, idempotentReplay: true };
    } finally {
      key.dek.fill(0);
    }
  });
}

export async function reauthorizeSimpleFin(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  connectionId: string;
  setupToken: string;
  idempotencyKey: string;
}>): Promise<Readonly<{ connectionId: string; credentialVersion: number; idempotentReplay: boolean }>> {
  assertBankingSession(input.principal, { stepUp: true, externalProvider: true });
  const commandFingerprint = await withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: `${input.requestId}:preflight`,
    permission: PERMISSIONS.manageBankConnections,
    reason: "Validate a SimpleFIN reauthorization before consuming its one-time token",
  }, async (client) => {
    const connection = await client.query(
      `SELECT 1 FROM bank_connections
       WHERE organization_id = $1 AND id = $2 AND provider = 'SIMPLEFIN'`,
      [input.principal.organizationId, input.connectionId],
    );
    if (!connection.rows[0]) {
      throw new BankingServiceError("The SimpleFIN connection was not found.", 404, "CONNECTION_NOT_FOUND");
    }
    const key = await loadActiveOrganizationKey(client, input.principal.organizationId);
    try {
      const commandHash = blindDigest(
        JSON.stringify({ connectionId: input.connectionId, setupToken: input.setupToken }),
        key.dek,
        input.principal.organizationId,
        "bank.connection-reauthorization-command",
      );
      const replay = await client.query<{ connection_id: string; credential_version: number; command_hash: string }>(
        `SELECT connection_id, credential_version, command_hash
         FROM bank_connection_credential_events
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [input.principal.organizationId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].connection_id !== input.connectionId || replay.rows[0].command_hash !== commandHash) {
          throw new BankingServiceError("The credential idempotency key was already used for another request.", 409, "IDEMPOTENCY_CONFLICT");
        }
        return { commandHash, replayVersion: replay.rows[0].credential_version };
      }
      return { commandHash, replayVersion: null };
    } finally {
      key.dek.fill(0);
    }
  });
  if (commandFingerprint.replayVersion !== null) {
    return {
      connectionId: input.connectionId,
      credentialVersion: commandFingerprint.replayVersion,
      idempotentReplay: true,
    };
  }

  const organizationRateLimit = await consumeBankingProviderOrganizationRateLimit(
    input.principal.organizationId,
    "connect",
  );
  if (!organizationRateLimit.allowed) {
    throw new BankingServiceError(
      "This business has reached its secure bank-connection attempt limit. Try again later.",
      429,
      "BANK_CONNECTION_RATE_LIMITED",
      organizationRateLimit.retryAfterSeconds,
    );
  }
  const accessUrl = await exchangeSimpleFinSetupToken(input.setupToken);
  return withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.manageBankConnections,
    reason: "Replace an encrypted SimpleFIN credential and reactivate the retained connection",
  }, async (client) => {
    const connection = await client.query<{ credential_version: number }>(
      `SELECT credential_version FROM bank_connections
       WHERE organization_id = $1 AND id = $2 AND provider = 'SIMPLEFIN'
       FOR UPDATE`,
      [input.principal.organizationId, input.connectionId],
    );
    if (!connection.rows[0]) {
      throw new BankingServiceError("The SimpleFIN connection was not found.", 404, "CONNECTION_NOT_FOUND");
    }
    const replay = await client.query<{ connection_id: string; credential_version: number; command_hash: string }>(
      `SELECT connection_id, credential_version, command_hash
       FROM bank_connection_credential_events
       WHERE organization_id = $1 AND idempotency_key = $2`,
      [input.principal.organizationId, input.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].connection_id !== input.connectionId || replay.rows[0].command_hash !== commandFingerprint.commandHash) {
        throw new BankingServiceError("The credential idempotency key was already used for another request.", 409, "IDEMPOTENCY_CONFLICT");
      }
      return {
        connectionId: input.connectionId,
        credentialVersion: replay.rows[0].credential_version,
        idempotentReplay: true,
      };
    }
    const credentialVersion = connection.rows[0].credential_version + 1;
    const key = await loadActiveOrganizationKey(client, input.principal.organizationId);
    try {
      const ciphertext = encryptedValue({
        plaintext: accessUrl,
        organizationId: input.principal.organizationId,
        table: "bank_connections",
        column: "credentials_ciphertext",
        recordId: input.connectionId,
        keyVersion: key.keyVersion,
        dek: key.dek,
      });
      await client.query(
        `UPDATE bank_connections SET credentials_ciphertext = $3,
           credentials_key_version = $4, credential_version = $5,
           status = 'ACTIVE', last_error_code = NULL
         WHERE organization_id = $1 AND id = $2`,
        [input.principal.organizationId, input.connectionId, ciphertext, key.keyVersion,
          credentialVersion],
      );
      await client.query(
        `INSERT INTO bank_connection_credential_events(
           organization_id, connection_id, credential_version, event_type,
           credential_ciphertext_hash, credential_key_version,
           idempotency_key, command_hash, created_by
         ) VALUES ($1,$2,$3,'REAUTHORIZED',$4,$5,$6,$7,$8)`,
        [input.principal.organizationId, input.connectionId, credentialVersion,
          createHash("sha256").update(ciphertext).digest("hex"), key.keyVersion,
          input.idempotencyKey, commandFingerprint.commandHash, input.principal.userId],
      );
      return { connectionId: input.connectionId, credentialVersion, idempotentReplay: false };
    } finally {
      key.dek.fill(0);
    }
  });
}

export async function disableSimpleFin(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  connectionId: string;
}>): Promise<Readonly<{ connectionId: string; status: "DISABLED"; idempotentReplay: boolean }>> {
  assertBankingSession(input.principal, { stepUp: true });
  return withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.manageBankConnections,
    reason: "Disable outbound synchronization while retaining bank-feed evidence",
  }, async (client) => {
    const connection = await client.query<{ status: string }>(
      `SELECT status FROM bank_connections
       WHERE organization_id = $1 AND id = $2 AND provider = 'SIMPLEFIN'
       FOR UPDATE`,
      [input.principal.organizationId, input.connectionId],
    );
    if (!connection.rows[0]) {
      throw new BankingServiceError("The SimpleFIN connection was not found.", 404, "CONNECTION_NOT_FOUND");
    }
    if (connection.rows[0].status === "DISABLED") {
      return { connectionId: input.connectionId, status: "DISABLED", idempotentReplay: true };
    }
    await client.query(
      `UPDATE bank_connections SET status = 'DISABLED', last_error_code = NULL
       WHERE organization_id = $1 AND id = $2`,
      [input.principal.organizationId, input.connectionId],
    );
    return { connectionId: input.connectionId, status: "DISABLED", idempotentReplay: false };
  });
}

type StoredActiveRule = Readonly<{
  id: string;
  condition: BankRuleCondition;
  action: BankRuleAction;
}>;

function ruleMatches(
  rule: StoredActiveRule,
  externalAccountId: string,
  transaction: NormalizedBankTransaction,
): boolean {
  const condition = rule.condition;
  if (condition.externalAccountId && condition.externalAccountId !== externalAccountId) return false;
  const amount = new Decimal(transaction.amount);
  if (condition.direction === "INFLOW" && !amount.isPositive()) return false;
  if (condition.direction === "OUTFLOW" && !amount.isNegative()) return false;
  const absolute = amount.abs();
  if (condition.minimumAbsoluteAmount && absolute.lessThan(condition.minimumAbsoluteAmount)) return false;
  if (condition.maximumAbsoluteAmount && absolute.greaterThan(condition.maximumAbsoluteAmount)) return false;
  if (condition.merchantCategoryCode && transaction.details.merchantCategoryCode?.toLowerCase() !== condition.merchantCategoryCode.toLowerCase()) return false;
  if (condition.descriptionContains) {
    const searchable = [transaction.details.payee, transaction.details.description, transaction.details.memo]
      .filter(Boolean).join(" ").toLocaleLowerCase("en-US");
    if (!searchable.includes(condition.descriptionContains.toLocaleLowerCase("en-US"))) return false;
  }
  return true;
}

async function loadActiveRules(client: PoolClient, organizationId: string, dek: Buffer): Promise<readonly StoredActiveRule[]> {
  const result = await client.query<{
    id: string; condition_ciphertext: string; action_ciphertext: string; key_version: number;
  }>(
    `SELECT rule.id, rule.condition_ciphertext, rule.action_ciphertext, rule.key_version
     FROM bank_rules rule
     WHERE rule.organization_id = $1 AND rule.state = 'ACTIVE'
       AND NOT EXISTS (
         SELECT 1 FROM bank_rules successor
         WHERE successor.organization_id = rule.organization_id
           AND successor.supersedes_rule_id = rule.id
       )
     ORDER BY rule.priority, rule.created_at, rule.id LIMIT 100`,
    [organizationId],
  );
  const rules: StoredActiveRule[] = [];
  for (const row of result.rows) {
    try {
      const condition = bankRuleConditionSchema.parse(JSON.parse(decryptField(
        parseEncryptedField(row.condition_ciphertext), dek,
        { organizationId, table: "bank_rules", column: "condition_ciphertext", recordId: row.id, keyVersion: row.key_version },
      )));
      const action = bankRuleActionSchema.parse(JSON.parse(decryptField(
        parseEncryptedField(row.action_ciphertext), dek,
        { organizationId, table: "bank_rules", column: "action_ciphertext", recordId: row.id, keyVersion: row.key_version },
      )));
      rules.push({ id: row.id, condition, action });
    } catch {
      // Corrupt or obsolete rule data fails closed and produces no proposal.
    }
  }
  return rules;
}

async function finishFailedSync(
  principal: SessionPrincipal,
  requestId: string,
  runId: string,
  errorCode: string,
): Promise<void> {
  try {
    await withAuthorizedBankingWrite({
      principal,
      requestId: `${requestId}:fail`,
      permission: PERMISSIONS.syncBanking,
      reason: "Record a terminal bank-feed synchronization failure",
    }, async (client) => {
      await client.query(
        `UPDATE bank_sync_runs SET status = 'FAILED', completed_at = now(), error_code = $3
         WHERE organization_id = $1 AND id = $2 AND status = 'RUNNING'`,
        [principal.organizationId, runId, errorCode],
      );
      await client.query(
        `UPDATE bank_connections connection SET last_error_code = $3,
           status = CASE WHEN $3 = 'PROVIDER_AUTHORIZATION_REJECTED'
             THEN 'REAUTHORIZATION_REQUIRED' ELSE connection.status END
         FROM bank_sync_runs run
         WHERE connection.organization_id = $1 AND run.organization_id = connection.organization_id
           AND run.id = $2 AND connection.id = run.connection_id
           AND run.credential_version = connection.credential_version`,
        [principal.organizationId, runId, errorCode],
      );
    });
  } catch {
    // Preserve the original sanitized sync failure if the terminal marker also fails.
  }
}

async function markSimpleFinReauthorizationRequired(
  principal: SessionPrincipal,
  requestId: string,
  connectionId: string,
  errorCode: string,
): Promise<void> {
  try {
    await withAuthorizedBankingWrite({
      principal,
      requestId: `${requestId}:reauthorization-required`,
      permission: PERMISSIONS.syncBanking,
      reason: "Mark an unusable encrypted bank credential for authorized replacement",
    }, async (client) => {
      await client.query(
        `UPDATE bank_connections SET status = 'REAUTHORIZATION_REQUIRED', last_error_code = $3
         WHERE organization_id = $1 AND id = $2 AND provider = 'SIMPLEFIN' AND status = 'ACTIVE'
           AND credentials_key_version <> (
             SELECT key_version.version FROM organization_key_versions key_version
             WHERE key_version.organization_id = $1 AND key_version.active
           )`,
        [principal.organizationId, connectionId, errorCode],
      );
    });
  } catch {
    // Preserve the original credential error if the lifecycle marker also fails.
  }
}

export async function syncSimpleFin(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  connectionId: string;
  startOn?: string;
  endOn?: string;
}>): Promise<Readonly<{
  syncRunId: string;
  accountCount: number;
  observationCount: number;
  versionCount: number;
  warningCount: number;
}>> {
  assertBankingSession(input.principal, { externalProvider: true });
  const runId = randomUUID();
  let activeCredential: Readonly<{ accessUrl: string; credentialVersion: number }>;
  try {
    activeCredential = await withAuthorizedBankingWrite({
      principal: input.principal,
      requestId: `${input.requestId}:begin`,
      permission: PERMISSIONS.syncBanking,
      reason: "Begin a bounded SimpleFIN synchronization",
    }, async (client) => {
      await client.query(
        `UPDATE bank_sync_runs SET status = 'FAILED', completed_at = now(), error_code = 'ABANDONED_SYNC'
         WHERE organization_id = $1 AND connection_id = $2 AND status = 'RUNNING'
           AND started_at < now() - interval '15 minutes'`,
        [input.principal.organizationId, input.connectionId],
      );
      const running = await client.query(
        `SELECT 1 FROM bank_sync_runs
         WHERE organization_id = $1 AND connection_id = $2 AND status = 'RUNNING'`,
        [input.principal.organizationId, input.connectionId],
      );
      if (running.rows[0]) {
        throw new BankingServiceError("A synchronization is already running for this connection.", 409, "SYNC_IN_PROGRESS");
      }
      const connection = await client.query<{
        credentials_ciphertext: string; credentials_key_version: number; credential_version: number;
      }>(
        `SELECT connection.credentials_ciphertext, connection.credentials_key_version,
           connection.credential_version
         FROM bank_connections connection
         WHERE connection.organization_id = $1 AND connection.id = $2
           AND connection.provider = 'SIMPLEFIN' AND connection.status = 'ACTIVE'`,
        [input.principal.organizationId, input.connectionId],
      );
      if (!connection.rows[0]) throw new BankingServiceError("The SimpleFIN connection is not active.", 404, "CONNECTION_NOT_ACTIVE");
      const key = await loadActiveOrganizationKey(client, input.principal.organizationId);
      try {
        if (key.keyVersion !== connection.rows[0].credentials_key_version) {
          throw new BankingServiceError("The bank credential must be replaced after key rotation.", 409, "CREDENTIAL_KEY_VERSION_MISMATCH");
        }
        const decryptedAccessUrl = decryptField(parseEncryptedField(connection.rows[0].credentials_ciphertext), key.dek, {
          organizationId: input.principal.organizationId,
          table: "bank_connections",
          column: "credentials_ciphertext",
          recordId: input.connectionId,
          keyVersion: key.keyVersion,
        });
        await client.query(
          `INSERT INTO bank_sync_runs(
             id, organization_id, connection_id, status, requested_start_on,
             requested_end_on, created_by, credential_version
           ) VALUES ($1,$2,$3,'RUNNING',$4,$5,$6,$7)`,
          [runId, input.principal.organizationId, input.connectionId,
            input.startOn ?? null, input.endOn ?? null, input.principal.userId,
            connection.rows[0].credential_version],
        );
        return {
          accessUrl: decryptedAccessUrl,
          credentialVersion: connection.rows[0].credential_version,
        };
      } finally {
        key.dek.fill(0);
      }
    });
  } catch (error) {
    if (error instanceof BankingServiceError && error.code === "CREDENTIAL_KEY_VERSION_MISMATCH") {
      await markSimpleFinReauthorizationRequired(
        input.principal,
        input.requestId,
        input.connectionId,
        error.code,
      );
    }
    throw error;
  }

  try {
    const organizationRateLimit = await consumeBankingProviderOrganizationRateLimit(
      input.principal.organizationId,
      "sync",
    );
    if (!organizationRateLimit.allowed) {
      throw new BankingServiceError(
        "This business has reached its secure bank synchronization limit. Try again later.",
        429,
        "BANK_SYNC_RATE_LIMITED",
        organizationRateLimit.retryAfterSeconds,
      );
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const startSeconds = input.startOn
      ? Math.floor(new Date(`${input.startOn}T00:00:00.000Z`).getTime() / 1000)
      : nowSeconds - 90 * 86_400;
    const endSeconds = input.endOn
      ? Math.floor(new Date(`${input.endOn}T23:59:59.999Z`).getTime() / 1000)
      : nowSeconds;
    const response = await fetchSimpleFinAccounts(activeCredential.accessUrl, {
      startDate: startSeconds,
      endDate: endSeconds,
      includePending: true,
    });
    const normalized = normalizeSimpleFinPayload(response);

    return await withAuthorizedBankingWrite({
      principal: input.principal,
      requestId: `${input.requestId}:ingest`,
      permission: PERMISSIONS.syncBanking,
      reason: "Ingest immutable SimpleFIN observations and draft-only rule proposals",
    }, async (client) => {
      const key = await loadActiveOrganizationKey(client, input.principal.organizationId);
      let observationCount = 0;
      let versionCount = 0;
      try {
        const activeRules = await loadActiveRules(client, input.principal.organizationId, key.dek);
        for (const account of normalized.accounts) {
          const accountHash = createBlindIndex(
            account.providerAccountId, key.dek, input.principal.organizationId, "bank.provider-account-id",
          );
          let external = await client.query<{ id: string; currency_code: string }>(
            `SELECT id, currency_code FROM bank_external_accounts
             WHERE organization_id = $1 AND connection_id = $2 AND provider_account_id_hash = $3`,
            [input.principal.organizationId, input.connectionId, accountHash],
          );
          if (!external.rows[0]) {
            const externalAccountId = randomUUID();
            const providerIdCiphertext = encryptedValue({
              plaintext: account.providerAccountId, organizationId: input.principal.organizationId,
              table: "bank_external_accounts", column: "provider_account_id_ciphertext",
              recordId: externalAccountId, keyVersion: key.keyVersion, dek: key.dek,
            });
            const nameCiphertext = encryptedValue({
              plaintext: account.displayName, organizationId: input.principal.organizationId,
              table: "bank_external_accounts", column: "display_name_ciphertext",
              recordId: externalAccountId, keyVersion: key.keyVersion, dek: key.dek,
            });
            await client.query(
              `INSERT INTO bank_external_accounts(
                 id, organization_id, connection_id, provider_account_id_hash,
                 provider_account_id_ciphertext, display_name_ciphertext,
                 key_version, currency_code
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (connection_id, provider_account_id_hash) DO NOTHING`,
              [externalAccountId, input.principal.organizationId, input.connectionId, accountHash,
                providerIdCiphertext, nameCiphertext, key.keyVersion, account.currencyCode],
            );
            external = await client.query<{ id: string; currency_code: string }>(
              `SELECT id, currency_code FROM bank_external_accounts
               WHERE organization_id = $1 AND connection_id = $2 AND provider_account_id_hash = $3`,
              [input.principal.organizationId, input.connectionId, accountHash],
            );
          }
          const persistedExternal = external.rows[0];
          if (!persistedExternal) throw new Error("External bank account identity could not be persisted");
          const externalAccountId = persistedExternal.id;
          if (persistedExternal.currency_code !== account.currencyCode) {
            throw new BankingServiceError(
              "The provider changed an existing bank account currency. Review the connection before importing more evidence.",
              409,
              "ACCOUNT_CURRENCY_CHANGED",
            );
          }
          await lockBankEvidence(client, input.principal.organizationId, externalAccountId);

          if (account.balance !== null) {
            await client.query(
              `INSERT INTO bank_balance_anchors(
                 organization_id, external_account_id, sync_run_id, balance,
                 available_balance, currency_code, balance_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (external_account_id, sync_run_id) DO NOTHING`,
              [input.principal.organizationId, externalAccountId, runId, account.balance,
                account.availableBalance, account.currencyCode, account.balanceAt ?? new Date().toISOString()],
            );
          }

          for (const transaction of account.transactions) {
            observationCount += 1;
            const providerTransactionHash = createBlindIndex(
              transaction.providerTransactionId, key.dek, input.principal.organizationId,
              `bank.transaction-id.${externalAccountId}`,
            );
            let observation = await client.query<{ id: string }>(
              `SELECT id FROM bank_observations
               WHERE organization_id = $1 AND external_account_id = $2
                 AND provider_transaction_id_hash = $3`,
              [input.principal.organizationId, externalAccountId, providerTransactionHash],
            );
            if (!observation.rows[0]) {
              const observationId = randomUUID();
              const transactionIdCiphertext = encryptedValue({
                plaintext: transaction.providerTransactionId, organizationId: input.principal.organizationId,
                table: "bank_observations", column: "provider_transaction_id_ciphertext",
                recordId: observationId, keyVersion: key.keyVersion, dek: key.dek,
              });
              await client.query(
                `INSERT INTO bank_observations(
                   id, organization_id, external_account_id, provider_transaction_id_hash,
                   provider_transaction_id_ciphertext, key_version, first_seen_run_id
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (external_account_id, provider_transaction_id_hash) DO NOTHING`,
                [observationId, input.principal.organizationId, externalAccountId, providerTransactionHash,
                  transactionIdCiphertext, key.keyVersion, runId],
              );
              observation = await client.query<{ id: string }>(
                `SELECT id FROM bank_observations
                 WHERE organization_id = $1 AND external_account_id = $2
                   AND provider_transaction_id_hash = $3`,
                [input.principal.organizationId, externalAccountId, providerTransactionHash],
              );
            }
            const observationId = observation.rows[0]?.id;
            if (!observationId) throw new Error("Bank observation identity could not be persisted");

            const canonicalContent = JSON.stringify({
              status: transaction.status, postedOn: transaction.postedOn,
              transactedAt: transaction.transactedAt, amount: transaction.amount,
              currencyCode: transaction.currencyCode, details: transaction.details,
            });
            const contentHash = createBlindIndex(
              canonicalContent, key.dek, input.principal.organizationId, "bank.observation-content",
            );
            const exists = await client.query(
              `SELECT 1 FROM bank_observation_versions
               WHERE organization_id = $1 AND observation_id = $2 AND content_hash = $3`,
              [input.principal.organizationId, observationId, contentHash],
            );
            if (exists.rows[0]) continue;
            const nextVersion = await client.query<{ next_version: number }>(
              `SELECT coalesce(max(version_number), 0)::int + 1 AS next_version
               FROM bank_observation_versions
               WHERE organization_id = $1 AND observation_id = $2`,
              [input.principal.organizationId, observationId],
            );
            const observationVersionId = randomUUID();
            const detailsCiphertext = encryptedValue({
              plaintext: JSON.stringify(transaction.details), organizationId: input.principal.organizationId,
              table: "bank_observation_versions", column: "details_ciphertext",
              recordId: observationVersionId, keyVersion: key.keyVersion, dek: key.dek,
            });
            await client.query(
              `INSERT INTO bank_observation_versions(
                 id, organization_id, observation_id, sync_run_id, version_number,
                 content_hash, status, posted_on, transacted_at, amount, currency_code,
                 details_ciphertext, key_version
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [observationVersionId, input.principal.organizationId, observationId, runId,
                nextVersion.rows[0]?.next_version ?? 1, contentHash, transaction.status,
                transaction.postedOn, transaction.transactedAt, transaction.amount,
                transaction.currencyCode, detailsCiphertext, key.keyVersion],
            );
            versionCount += 1;

            const matchedRule = activeRules.find((rule) => ruleMatches(rule, externalAccountId, transaction));
            if (!matchedRule) continue;
            await client.query(
              `INSERT INTO bank_rule_runs(
                 organization_id, sync_run_id, observation_version_id, rule_id, matched
               ) VALUES ($1,$2,$3,$4,true)
               ON CONFLICT (sync_run_id, observation_version_id, rule_id) DO NOTHING`,
              [input.principal.organizationId, runId, observationVersionId, matchedRule.id],
            );
            const proposalId = randomUUID();
            const proposalPayload = JSON.stringify({
              action: matchedRule.action,
              source: { externalAccountId, observationVersionId },
            });
            const payloadHash = createBlindIndex(
              proposalPayload, key.dek, input.principal.organizationId, "bank.proposal-payload",
            );
            const payloadCiphertext = encryptedValue({
              plaintext: proposalPayload, organizationId: input.principal.organizationId,
              table: "bank_draft_proposals", column: "payload_ciphertext",
              recordId: proposalId, keyVersion: key.keyVersion, dek: key.dek,
            });
            await client.query(
              `INSERT INTO bank_draft_proposals(
                 id, organization_id, observation_version_id, rule_id, kind,
                 payload_ciphertext, payload_hash, key_version
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (observation_version_id, rule_id, payload_hash) DO NOTHING`,
              [proposalId, input.principal.organizationId, observationVersionId, matchedRule.id,
                matchedRule.action.kind, payloadCiphertext, payloadHash, key.keyVersion],
            );
          }
        }

        await client.query(
          `UPDATE bank_sync_runs SET
             status = 'SUCCEEDED', account_count = $3, observation_count = $4,
             version_count = $5, provider_warning_count = $6, completed_at = now()
           WHERE organization_id = $1 AND id = $2 AND status = 'RUNNING'`,
          [input.principal.organizationId, runId, normalized.accounts.length,
            observationCount, versionCount, normalized.warnings.length],
        );
        await client.query(
          `UPDATE bank_connections SET last_synced_at = now(), last_error_code = NULL
           WHERE organization_id = $1 AND id = $2
             AND credential_version = $3`,
          [input.principal.organizationId, input.connectionId,
            activeCredential.credentialVersion],
        );
        return {
          syncRunId: runId,
          accountCount: normalized.accounts.length,
          observationCount,
          versionCount,
          warningCount: normalized.warnings.length,
        };
      } finally {
        key.dek.fill(0);
      }
    });
  } catch (error) {
    const code = error instanceof SimpleFinClientError || error instanceof BankingServiceError
      ? error.code
      : "INGESTION_FAILED";
    await finishFailedSync(input.principal, input.requestId, runId, code);
    if (error instanceof BankingServiceError || error instanceof SimpleFinClientError) throw error;
    throw new BankingServiceError("The bank feed could not be safely synchronized.", 409, code);
  }
}

export async function mapBankExternalAccount(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  externalAccountId: string;
  legalEntityId: string;
  ledgerId: string;
  cashAccountCombinationId: string;
  accountKind?: "CASH" | "CREDIT_CARD";
}>): Promise<Readonly<{ accountId: string; mapped: true }>> {
  assertBankingSession(input.principal);
  return withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.prepareBankReconciliation,
    reason: "Map an observed cash or credit-card account to a tenant ledger combination",
  }, async (client) => {
    const valid = await client.query<{
      account_kind: "CASH" | "CREDIT_CARD";
      legal_entity_id: string | null;
      ledger_id: string | null;
      cash_account_combination_id: string | null;
      provider: string;
      account_class: string;
    }>(
      `SELECT external.account_kind, external.legal_entity_id, external.ledger_id,
         external.cash_account_combination_id, connection.provider,
         account.class AS account_class
       FROM bank_external_accounts external
       JOIN bank_connections connection
         ON connection.organization_id = external.organization_id
        AND connection.id = external.connection_id
       JOIN account_combinations combination
         ON combination.organization_id = external.organization_id
        AND combination.id = $5 AND combination.active
       JOIN gl_accounts account
         ON account.organization_id = combination.organization_id
        AND account.id = combination.account_id
        AND account.active AND account.postable
        AND account.control_kind = 'NONE'
       JOIN ledgers ledger
         ON ledger.organization_id = combination.organization_id
        AND ledger.id = combination.ledger_id AND ledger.active
       WHERE external.organization_id = $1 AND external.id = $2 AND external.active
         AND combination.entity_id = $3 AND combination.ledger_id = $4
       FOR UPDATE OF external`,
      [input.principal.organizationId, input.externalAccountId, input.legalEntityId,
        input.ledgerId, input.cashAccountCombinationId],
    );
    const account = valid.rows[0];
    if (!account) {
      throw new BankingServiceError("Choose an active postable non-control asset for cash, or liability for a credit-card account, in the selected company ledger.", 400, "INVALID_CASH_MAPPING");
    }

    const requestedKind = input.accountKind ?? account.account_kind;
    const expectedClass = requestedKind === "CASH" ? "ASSET" : "LIABILITY";
    if (account.account_class !== expectedClass) {
      throw new BankingServiceError("Choose an asset for a cash account or a liability for a credit-card account.", 400, "INVALID_CASH_MAPPING");
    }

    const changesKind = requestedKind !== account.account_kind;
    if (changesKind) {
      const firstMapping = account.legal_entity_id === null
        && account.ledger_id === null
        && account.cash_account_combination_id === null;
      if (account.provider !== "SIMPLEFIN" || !firstMapping) {
        throw new BankingServiceError(
          "The banking account type can only be selected during the first mapping of an unmapped SimpleFIN account.",
          409,
          "ACCOUNT_KIND_CHANGE_NOT_ALLOWED",
        );
      }
      const history = await client.query<{ unsafe_history: boolean }>(
        `SELECT (
           EXISTS (
             SELECT 1 FROM bank_reconciliation_sessions reconciliation
             WHERE reconciliation.organization_id = $1
               AND reconciliation.external_account_id = $2
           ) OR EXISTS (
             SELECT 1 FROM bank_statement_imports statement_import
             WHERE statement_import.organization_id = $1
               AND statement_import.external_account_id = $2
           )
         ) AS unsafe_history`,
        [input.principal.organizationId, input.externalAccountId],
      );
      if (history.rows[0]?.unsafe_history !== false) {
        throw new BankingServiceError(
          "The banking account type cannot change after statement or reconciliation history exists.",
          409,
          "ACCOUNT_KIND_CHANGE_NOT_ALLOWED",
        );
      }
    }

    const updated = await client.query<{ id: string }>(
      `UPDATE bank_external_accounts external SET
         account_kind = $6,
         legal_entity_id = $3, ledger_id = $4, cash_account_combination_id = $5
       WHERE external.organization_id = $1 AND external.id = $2 AND external.active
         AND external.account_kind = $7
         AND (
           $6::text = $7::text
           OR (
             external.legal_entity_id IS NULL
             AND external.ledger_id IS NULL
             AND external.cash_account_combination_id IS NULL
             AND EXISTS (
               SELECT 1 FROM bank_connections connection
               WHERE connection.organization_id = external.organization_id
                 AND connection.id = external.connection_id
                 AND connection.provider = 'SIMPLEFIN'
             )
             AND NOT EXISTS (
               SELECT 1 FROM bank_reconciliation_sessions reconciliation
               WHERE reconciliation.organization_id = external.organization_id
                 AND reconciliation.external_account_id = external.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM bank_statement_imports statement_import
               WHERE statement_import.organization_id = external.organization_id
                 AND statement_import.external_account_id = external.id
             )
           )
         )
       RETURNING external.id`,
      [input.principal.organizationId, input.externalAccountId, input.legalEntityId,
        input.ledgerId, input.cashAccountCombinationId, requestedKind, account.account_kind],
    );
    if (!updated.rows[0]) {
      throw new BankingServiceError(
        "The banking account changed while it was being mapped. Reload and review it before trying again.",
        409,
        "BANK_ACCOUNT_MAPPING_CHANGED",
      );
    }
    return { accountId: input.externalAccountId, mapped: true };
  });
}

export async function createBankReconciliation(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  externalAccountId: string;
  statementStartOn: string;
  statementEndOn: string;
  openingBalance: string;
  closingBalance: string;
  idempotencyKey: string;
}>): Promise<Readonly<{ reconciliationId: string; idempotentReplay: boolean }>> {
  assertBankingSession(input.principal);
  const openingBalance = decimalSchema.parse(input.openingBalance);
  const closingBalance = decimalSchema.parse(input.closingBalance);
  return withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.prepareBankReconciliation,
    reason: "Create a formal draft bank reconciliation period",
  }, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:bank-reconciliation-chain:' || $1::text || ':' || $2::text, 0))",
      [input.principal.organizationId, input.externalAccountId],
    );
    const external = await client.query<{
      legal_entity_id: string; ledger_id: string; cash_account_combination_id: string; currency_code: string;
    }>(
      `SELECT legal_entity_id, ledger_id, cash_account_combination_id, currency_code
       FROM bank_external_accounts
       WHERE organization_id = $1 AND id = $2 AND active
         AND legal_entity_id IS NOT NULL AND ledger_id IS NOT NULL
         AND cash_account_combination_id IS NOT NULL
       FOR UPDATE`,
      [input.principal.organizationId, input.externalAccountId],
    );
    if (!external.rows[0]) throw new BankingServiceError("Map the bank account before reconciling it.", 400, "ACCOUNT_NOT_MAPPED");
    const key = await loadActiveOrganizationKey(client, input.principal.organizationId);
    try {
      const commandHash = blindDigest(JSON.stringify({
        externalAccountId: input.externalAccountId,
        statementStartOn: input.statementStartOn,
        statementEndOn: input.statementEndOn,
        openingBalance,
        closingBalance,
      }), key.dek, input.principal.organizationId, "bank.reconciliation-command");
      const replay = await client.query<{ id: string; command_hash: string }>(
        `SELECT id, command_hash FROM bank_reconciliation_sessions
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [input.principal.organizationId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].command_hash !== commandHash) throw new BankingServiceError("The reconciliation idempotency key conflicts with another request.", 409, "IDEMPOTENCY_CONFLICT");
        return { reconciliationId: replay.rows[0].id, idempotentReplay: true };
      }
      const overlap = await client.query(
        `SELECT 1 FROM bank_reconciliation_sessions
         WHERE organization_id = $1 AND external_account_id = $2
           AND status <> 'VOIDED'
           AND statement_start_on <= $4::date AND statement_end_on >= $3::date`,
        [input.principal.organizationId, input.externalAccountId, input.statementStartOn, input.statementEndOn],
      );
      if (overlap.rows[0]) throw new BankingServiceError("This statement range overlaps another reconciliation.", 409, "RECONCILIATION_OVERLAP");
      const previous = await client.query<{
        status: string; adjacent: boolean; closing_balance: string;
      }>(
        `SELECT status, statement_end_on + 1 = $3::date AS adjacent,
           closing_balance::text
         FROM bank_reconciliation_sessions
         WHERE organization_id = $1 AND external_account_id = $2
           AND status <> 'VOIDED' AND statement_end_on < $3::date
         ORDER BY statement_end_on DESC, created_at DESC LIMIT 1`,
        [input.principal.organizationId, input.externalAccountId, input.statementStartOn],
      );
      const predecessor = previous.rows[0];
      if (predecessor?.status !== undefined && predecessor.status !== "FINALIZED") {
        throw new BankingServiceError("Finalize the preceding reconciliation before starting its successor.", 409, "PREVIOUS_RECONCILIATION_NOT_FINALIZED");
      }
      if (predecessor && !predecessor.adjacent) {
        throw new BankingServiceError("The next reconciliation must begin on the day after the preceding finalized statement.", 409, "RECONCILIATION_PERIOD_GAP");
      }
      if (predecessor && !new Decimal(predecessor.closing_balance).equals(openingBalance)) {
        throw new BankingServiceError("The opening balance must equal the preceding finalized closing balance.", 409, "OPENING_BALANCE_DISCONTINUITY");
      }
      const future = await client.query(
        `SELECT 1 FROM bank_reconciliation_sessions
         WHERE organization_id = $1 AND external_account_id = $2
           AND status <> 'VOIDED' AND statement_start_on > $3::date
         LIMIT 1`,
        [input.principal.organizationId, input.externalAccountId, input.statementEndOn],
      );
      if (future.rows[0]) {
        throw new BankingServiceError("Create reconciliation periods in chronological order.", 409, "RECONCILIATION_OUT_OF_ORDER");
      }
      const reconciliationId = randomUUID();
      await client.query(
        `INSERT INTO bank_reconciliation_sessions(
           id, organization_id, external_account_id, legal_entity_id, ledger_id,
           cash_account_combination_id, statement_start_on, statement_end_on,
           opening_balance, closing_balance, currency_code, status, version,
           idempotency_key, command_hash, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT',1,$12,$13,$14)`,
        [reconciliationId, input.principal.organizationId, input.externalAccountId,
          external.rows[0].legal_entity_id, external.rows[0].ledger_id,
          external.rows[0].cash_account_combination_id, input.statementStartOn,
          input.statementEndOn, openingBalance, closingBalance,
          external.rows[0].currency_code, input.idempotencyKey, commandHash,
          input.principal.userId],
      );
      return { reconciliationId, idempotentReplay: false };
    } finally {
      key.dek.fill(0);
    }
  });
}

export async function createBankRule(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  name: string;
  priority: number;
  state: "DRAFT" | "ACTIVE";
  condition: BankRuleCondition;
  action: BankRuleAction;
  idempotencyKey: string;
}>): Promise<Readonly<{ ruleId: string; idempotentReplay: boolean }>> {
  assertBankingSession(input.principal);
  const condition = bankRuleConditionSchema.parse(input.condition);
  const action = bankRuleActionSchema.parse(input.action);
  return withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.manageBankRules,
    reason: "Create an encrypted categorization rule that can produce manual-review suggestions only",
  }, async (client) => {
    if (condition.externalAccountId) {
      const account = await client.query(
        "SELECT 1 FROM bank_external_accounts WHERE organization_id = $1 AND id = $2 AND active",
        [input.principal.organizationId, condition.externalAccountId],
      );
      if (!account.rows[0]) throw new BankingServiceError("The rule bank account is not active in this organization.", 400, "INVALID_RULE_ACCOUNT");
    }
    if (action.targetAccountCombinationId) {
      if (!condition.externalAccountId) {
        throw new BankingServiceError("Choose one mapped bank account before assigning a suggested ledger account.", 400, "RULE_TARGET_REQUIRES_BANK_SCOPE");
      }
      const target = await client.query(
        `SELECT 1
         FROM bank_external_accounts external
         JOIN account_combinations combination
           ON combination.organization_id = external.organization_id
          AND combination.id = $3 AND combination.active
          AND combination.entity_id = external.legal_entity_id
          AND combination.ledger_id = external.ledger_id
         JOIN legal_entities entity
           ON entity.organization_id = combination.organization_id
          AND entity.id = combination.entity_id AND entity.active
         JOIN ledgers ledger
           ON ledger.organization_id = combination.organization_id
          AND ledger.id = combination.ledger_id AND ledger.active
         JOIN gl_accounts account
           ON account.organization_id = combination.organization_id
          AND account.ledger_id = combination.ledger_id
          AND account.id = combination.account_id
          AND account.active AND account.postable AND account.control_kind = 'NONE'
         WHERE external.organization_id = $1 AND external.id = $2 AND external.active
           AND external.legal_entity_id IS NOT NULL AND external.ledger_id IS NOT NULL`,
        [input.principal.organizationId, condition.externalAccountId, action.targetAccountCombinationId],
      );
      if (!target.rows[0]) throw new BankingServiceError("Choose an active postable non-control account in the mapped bank account's company ledger.", 400, "INVALID_RULE_TARGET");
    }
    const key = await loadActiveOrganizationKey(client, input.principal.organizationId);
    try {
      const commandHash = blindDigest(JSON.stringify({
        name: input.name, priority: input.priority, state: input.state, condition, action,
      }), key.dek, input.principal.organizationId, "bank.rule-command");
      const replay = await client.query<{ id: string; command_hash: string }>(
        "SELECT id, command_hash FROM bank_rules WHERE organization_id = $1 AND idempotency_key = $2",
        [input.principal.organizationId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].command_hash !== commandHash) throw new BankingServiceError("The rule idempotency key conflicts with another request.", 409, "IDEMPOTENCY_CONFLICT");
        return { ruleId: replay.rows[0].id, idempotentReplay: true };
      }
      const ruleId = randomUUID();
      const conditionCiphertext = encryptedValue({
        plaintext: JSON.stringify(condition), organizationId: input.principal.organizationId,
        table: "bank_rules", column: "condition_ciphertext", recordId: ruleId,
        keyVersion: key.keyVersion, dek: key.dek,
      });
      const actionCiphertext = encryptedValue({
        plaintext: JSON.stringify(action), organizationId: input.principal.organizationId,
        table: "bank_rules", column: "action_ciphertext", recordId: ruleId,
        keyVersion: key.keyVersion, dek: key.dek,
      });
      await client.query(
        `INSERT INTO bank_rules(
           id, organization_id, name, priority, state, condition_ciphertext,
           action_ciphertext, key_version, version, supersedes_rule_id,
           idempotency_key, command_hash, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,NULL,$9,$10,$11)`,
        [ruleId, input.principal.organizationId, input.name, input.priority, input.state,
          conditionCiphertext, actionCiphertext, key.keyVersion, input.idempotencyKey,
          commandHash, input.principal.userId],
      );
      return { ruleId, idempotentReplay: false };
    } finally {
      key.dek.fill(0);
    }
  });
}

export async function versionBankRuleState(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  ruleId: string;
  state: "ACTIVE" | "INACTIVE";
  idempotencyKey: string;
}>): Promise<Readonly<{ ruleId: string; version: number; idempotentReplay: boolean }>> {
  assertBankingSession(input.principal);
  return withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.manageBankRules,
    reason: `Create an immutable ${input.state.toLowerCase()} version of a bank rule`,
  }, async (client) => {
    const key = await loadActiveOrganizationKey(client, input.principal.organizationId);
    try {
      const commandHash = blindDigest(JSON.stringify({
        ruleId: input.ruleId,
        state: input.state,
      }), key.dek, input.principal.organizationId, "bank.rule-version-command");
      const replay = await client.query<{ id: string; version: number; command_hash: string }>(
        "SELECT id, version, command_hash FROM bank_rules WHERE organization_id = $1 AND idempotency_key = $2",
        [input.principal.organizationId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].command_hash !== commandHash) {
          throw new BankingServiceError("The rule-version idempotency key conflicts with another request.", 409, "IDEMPOTENCY_CONFLICT");
        }
        return { ruleId: replay.rows[0].id, version: replay.rows[0].version, idempotentReplay: true };
      }

      const current = await client.query<{
        id: string; name: string; priority: number; state: string; condition_ciphertext: string;
        action_ciphertext: string; key_version: number; version: number;
      }>(
        `SELECT rule.id, rule.name, rule.priority, rule.state, rule.condition_ciphertext,
           rule.action_ciphertext, rule.key_version, rule.version
         FROM bank_rules rule
         WHERE rule.organization_id = $1 AND rule.id = $2
         FOR UPDATE`,
        [input.principal.organizationId, input.ruleId],
      );
      const selected = current.rows[0];
      if (!selected) {
        throw new BankingServiceError("The bank rule was not found.", 404, "RULE_NOT_FOUND");
      }
      const successor = await client.query(
        "SELECT 1 FROM bank_rules WHERE organization_id = $1 AND supersedes_rule_id = $2",
        [input.principal.organizationId, selected.id],
      );
      if (successor.rows[0]) throw new BankingServiceError("Choose the latest immutable version of this bank rule.", 409, "RULE_VERSION_NOT_CURRENT");
      if (selected.state === input.state) {
        throw new BankingServiceError(`The latest rule version is already ${input.state.toLowerCase()}.`, 409, "RULE_STATE_UNCHANGED");
      }
      if (selected.key_version !== key.keyVersion) {
        throw new BankingServiceError("Re-encrypt this rule with the active organization key before changing its state.", 409, "RULE_REENCRYPTION_REQUIRED");
      }
      const condition = decryptField(parseEncryptedField(selected.condition_ciphertext), key.dek, {
        organizationId: input.principal.organizationId,
        table: "bank_rules",
        column: "condition_ciphertext",
        recordId: selected.id,
        keyVersion: selected.key_version,
      });
      const action = decryptField(parseEncryptedField(selected.action_ciphertext), key.dek, {
        organizationId: input.principal.organizationId,
        table: "bank_rules",
        column: "action_ciphertext",
        recordId: selected.id,
        keyVersion: selected.key_version,
      });
      bankRuleConditionSchema.parse(JSON.parse(condition));
      bankRuleActionSchema.parse(JSON.parse(action));

      const ruleId = randomUUID();
      const conditionCiphertext = encryptedValue({
        plaintext: condition,
        organizationId: input.principal.organizationId,
        table: "bank_rules",
        column: "condition_ciphertext",
        recordId: ruleId,
        keyVersion: key.keyVersion,
        dek: key.dek,
      });
      const actionCiphertext = encryptedValue({
        plaintext: action,
        organizationId: input.principal.organizationId,
        table: "bank_rules",
        column: "action_ciphertext",
        recordId: ruleId,
        keyVersion: key.keyVersion,
        dek: key.dek,
      });
      const version = selected.version + 1;
      await client.query(
        `INSERT INTO bank_rules(
           id, organization_id, name, priority, state, condition_ciphertext,
           action_ciphertext, key_version, version, supersedes_rule_id,
           idempotency_key, command_hash, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [ruleId, input.principal.organizationId, selected.name, selected.priority,
          input.state, conditionCiphertext, actionCiphertext, key.keyVersion,
          version, selected.id, input.idempotencyKey, commandHash, input.principal.userId],
      );
      return { ruleId, version, idempotentReplay: false };
    } finally {
      key.dek.fill(0);
    }
  });
}

export type BankReconciliationProof = Readonly<{
  statementMovement: string;
  observationTotal: string;
  ledgerTotal: string;
  statementToBankDifference: string;
  unexplainedDifference: string;
  unmatchedObservationCount: number;
  unmatchedLedgerLineCount: number;
  activeMatchCount: number;
  matchHash: string;
}>;

type ReconciliationIdentity = Readonly<{
  id: string;
  status: "DRAFT" | "SUBMITTED" | "REVIEWED" | "FINALIZED" | "VOIDED";
  external_account_id: string;
  cash_account_combination_id: string;
  currency_code: string;
  statement_start_on: string;
  statement_end_on: string;
  opening_balance: string;
  closing_balance: string;
}>;

async function lockReconciliation(
  client: PoolClient,
  organizationId: string,
  reconciliationId: string,
): Promise<ReconciliationIdentity> {
  const result = await client.query<ReconciliationIdentity>(
    `SELECT id, status, external_account_id, cash_account_combination_id,
       currency_code, statement_start_on::text, statement_end_on::text,
       opening_balance::text, closing_balance::text
     FROM bank_reconciliation_sessions
     WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
    [organizationId, reconciliationId],
  );
  if (!result.rows[0]) throw new BankingServiceError("The reconciliation was not found.", 404, "RECONCILIATION_NOT_FOUND");
  return result.rows[0];
}

async function reconciliationProof(
  client: PoolClient,
  organizationId: string,
  session: ReconciliationIdentity,
): Promise<BankReconciliationProof> {
  const totals = await client.query<{
    observation_total: string; ledger_total: string; unmatched_observation_count: number;
    unmatched_ledger_line_count: number; active_match_count: number;
  }>(
    `WITH latest_observation AS (
       SELECT DISTINCT ON (observation.id)
         version.id, version.amount, version.status, version.posted_on, version.currency_code
       FROM bank_observations observation
       JOIN bank_observation_versions version
         ON version.organization_id = observation.organization_id
        AND version.observation_id = observation.id
       WHERE observation.organization_id = $1
         AND observation.external_account_id = $2
       ORDER BY observation.id, version.version_number DESC
     ), in_period_observation AS (
       SELECT id, amount, status
       FROM latest_observation
       WHERE posted_on BETWEEN $4::date AND $5::date
         AND currency_code = $6
     ), active_allocation AS (
       SELECT allocation.id, allocation.observation_version_id,
         allocation.journal_line_id, allocation.allocated_amount,
         observation.id AS current_observation_id,
         observation.amount AS observation_amount,
         observation.status AS observation_status,
         journal.id AS posted_journal_id,
         line.debit_transaction - line.credit_transaction AS journal_amount
       FROM bank_match_allocations allocation
       LEFT JOIN bank_match_allocation_voids void
         ON void.organization_id = allocation.organization_id AND void.allocation_id = allocation.id
       LEFT JOIN in_period_observation observation
         ON observation.id = allocation.observation_version_id
       LEFT JOIN journal_lines line
         ON line.organization_id = allocation.organization_id
        AND line.id = allocation.journal_line_id
        AND line.account_combination_id = $7
        AND line.transaction_currency = $6
       LEFT JOIN journal_entries journal
         ON journal.organization_id = line.organization_id
        AND journal.id = line.journal_entry_id
        AND journal.status = 'POSTED'
        AND journal.accounting_date BETWEEN $4::date AND $5::date
       WHERE allocation.organization_id = $1
         AND allocation.reconciliation_session_id = $3
         AND void.id IS NULL
     ), observation_allocated AS (
       SELECT allocation.observation_version_id, sum(allocation.allocated_amount) AS allocated
       FROM active_allocation allocation
       GROUP BY allocation.observation_version_id
     )
     SELECT
       coalesce((SELECT sum(amount) FROM in_period_observation WHERE status = 'POSTED'), 0)::text AS observation_total,
       coalesce((SELECT sum(CASE WHEN allocation.journal_amount > 0
           THEN allocation.allocated_amount ELSE -allocation.allocated_amount END)
         FROM active_allocation allocation
         WHERE allocation.current_observation_id IS NOT NULL
           AND allocation.observation_status = 'POSTED'
           AND allocation.posted_journal_id IS NOT NULL
           AND allocation.journal_amount <> 0
           AND sign(allocation.observation_amount) = sign(allocation.journal_amount)), 0)::text AS ledger_total,
       (SELECT count(*)::int FROM in_period_observation observation
         LEFT JOIN observation_allocated allocated ON allocated.observation_version_id = observation.id
         WHERE observation.status = 'POSTED'
           AND abs(observation.amount) <> coalesce(allocated.allocated, 0)) AS unmatched_observation_count,
       (SELECT count(*)::int FROM active_allocation allocation
         WHERE allocation.current_observation_id IS NULL
           OR allocation.observation_status <> 'POSTED'
           OR allocation.posted_journal_id IS NULL
           OR allocation.journal_amount = 0
           OR sign(allocation.observation_amount) <> sign(allocation.journal_amount)) AS unmatched_ledger_line_count,
       (SELECT count(*)::int FROM active_allocation) AS active_match_count`,
    [organizationId, session.external_account_id, session.id, session.statement_start_on,
      session.statement_end_on, session.currency_code, session.cash_account_combination_id],
  );
  const row = totals.rows[0];
  if (!row) throw new Error("The reconciliation proof query returned no result");
  const statementMovement = new Decimal(session.closing_balance).minus(session.opening_balance);
  const observationTotal = new Decimal(row.observation_total);
  const ledgerTotal = new Decimal(row.ledger_total);
  const matches = await client.query<{
    id: string; observation_version_id: string; journal_line_id: string; allocated_amount: string;
  }>(
    `SELECT allocation.id, allocation.observation_version_id, allocation.journal_line_id,
       allocation.allocated_amount::text
     FROM bank_match_allocations allocation
     LEFT JOIN bank_match_allocation_voids void
       ON void.organization_id = allocation.organization_id AND void.allocation_id = allocation.id
     WHERE allocation.organization_id = $1
       AND allocation.reconciliation_session_id = $2 AND void.id IS NULL
     ORDER BY allocation.id`,
    [organizationId, session.id],
  );
  const matchHash = createHash("sha256").update(JSON.stringify(matches.rows), "utf8").digest("hex");
  return {
    statementMovement: statementMovement.toFixed(9),
    observationTotal: observationTotal.toFixed(9),
    ledgerTotal: ledgerTotal.toFixed(9),
    statementToBankDifference: statementMovement.minus(observationTotal).toFixed(9),
    unexplainedDifference: statementMovement.minus(ledgerTotal).toFixed(9),
    unmatchedObservationCount: row.unmatched_observation_count,
    unmatchedLedgerLineCount: row.unmatched_ledger_line_count,
    activeMatchCount: row.active_match_count,
    matchHash,
  };
}

async function lockBankMatchIdentities(
  client: PoolClient,
  observationVersionId: string,
  journalLineId: string,
): Promise<void> {
  const keys = await client.query<{ lock_key: string }>(
    `SELECT selected.lock_key::text AS lock_key
     FROM (VALUES
       (hashtextextended('business-finlynq:bank-observation:' || $1::text, 0)),
       (hashtextextended('business-finlynq:bank-journal-line:' || $2::text, 0))
     ) selected(lock_key)
     GROUP BY selected.lock_key
     ORDER BY selected.lock_key`,
    [observationVersionId, journalLineId],
  );
  for (const row of keys.rows) {
    // Separate lock statements ensure a waiter receives a fresh READ COMMITTED
    // snapshot before it computes the global allocation totals below.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [row.lock_key]);
  }
}

function assertBalancedProof(proof: BankReconciliationProof): void {
  if (
    !new Decimal(proof.statementToBankDifference).isZero() ||
    !new Decimal(proof.unexplainedDifference).isZero() ||
    proof.unmatchedObservationCount !== 0 ||
    proof.unmatchedLedgerLineCount !== 0
  ) {
    throw new BankingServiceError(
      "The reconciliation cannot advance until statement movement, bank observations, mapped cash lines, and active allocations agree exactly.",
      409,
      "RECONCILIATION_NOT_BALANCED",
    );
  }
}

export async function createBankMatchAllocation(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  reconciliationId: string;
  observationVersionId: string;
  journalLineId: string;
  allocatedAmount: string;
  idempotencyKey: string;
}>): Promise<Readonly<{ allocationId: string; idempotentReplay: boolean }>> {
  assertBankingSession(input.principal);
  const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
  const requestedAmount = matchAllocationAmountSchema.parse(input.allocatedAmount);
  const amount = new Decimal(requestedAmount);
  if (!amount.isPositive() || amount.decimalPlaces() > 9 || amount.greaterThan("99999999999999999999999999999")) {
    throw new BankingServiceError("Enter a positive exact allocation amount within the supported accounting range.", 400, "INVALID_MATCH_AMOUNT");
  }
  const allocatedAmount = amount.toFixed(Math.min(amount.decimalPlaces(), 9));
  const fingerprintPayload = {
    reconciliationId: input.reconciliationId,
    observationVersionId: input.observationVersionId,
    journalLineId: input.journalLineId,
    allocatedAmount,
  };
  const commandFingerprints = {
    current: createCommandFingerprint(
      "banking.reconciliation.match.allocation",
      fingerprintPayload,
      bankMatchAllocationFingerprintVersion,
    ),
    legacy: createCommandFingerprint(
      "banking.reconciliation.match.allocation",
      { ...fingerprintPayload, allocatedAmount: requestedAmount },
      "v1",
    ),
  };
  const commandHash = commandFingerprints.current;
  return withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.prepareBankReconciliation,
    reason: "Allocate a bank observation to a posted mapped cash journal line",
  }, async (client) => {
    const session = await lockReconciliation(client, input.principal.organizationId, input.reconciliationId);
    const existing = await client.query<{ id: string; command_hash: string }>(
      `SELECT id, command_hash
       FROM bank_match_allocations
       WHERE organization_id = $1 AND reconciliation_session_id = $2 AND idempotency_key = $3
       FOR SHARE`,
      [input.principal.organizationId, session.id, idempotencyKey],
    );
    if (existing.rows[0]) {
      if (!matchesStoredCommandFingerprint(
        existing.rows[0].command_hash,
        commandFingerprints,
      )) {
        throw new BankingServiceError("The match idempotency key was already used for a different allocation.", 409, "IDEMPOTENCY_CONFLICT");
      }
      return { allocationId: existing.rows[0].id, idempotentReplay: true };
    }
    if (session.status !== "DRAFT") throw new BankingServiceError("Matches can change only while the reconciliation is a draft.", 409, "RECONCILIATION_LOCKED");
    await lockBankEvidence(client, input.principal.organizationId, session.external_account_id);
    await lockBankMatchIdentities(client, input.observationVersionId, input.journalLineId);
    const pair = await client.query<{
      observation_amount: string; line_amount: string; observation_allocated: string; line_allocated: string;
    }>(
      `WITH selected_observation AS (
         SELECT version.id, version.amount
         FROM bank_observation_versions version
         JOIN bank_observations observation
           ON observation.organization_id = version.organization_id
          AND observation.id = version.observation_id
         WHERE version.organization_id = $1 AND version.id = $2
           AND observation.external_account_id = $3
           AND version.status = 'POSTED'
           AND version.posted_on BETWEEN $4::date AND $5::date
           AND version.currency_code = $6
           AND NOT EXISTS (
             SELECT 1 FROM bank_observation_versions newer
             WHERE newer.organization_id = version.organization_id
               AND newer.observation_id = version.observation_id
               AND newer.version_number > version.version_number
           )
       ), selected_line AS (
         SELECT line.id,
           line.debit_transaction - line.credit_transaction AS amount
         FROM journal_lines line
         JOIN journal_entries journal
           ON journal.organization_id = line.organization_id
          AND journal.id = line.journal_entry_id AND journal.status = 'POSTED'
         WHERE line.organization_id = $1 AND line.id = $7
           AND line.account_combination_id = $8
           AND line.transaction_currency = $6
           AND journal.accounting_date BETWEEN $4::date AND $5::date
       )
       SELECT observation.amount::text AS observation_amount, line.amount::text AS line_amount,
         coalesce((SELECT sum(allocation.allocated_amount)
           FROM bank_match_allocations allocation
           JOIN bank_reconciliation_sessions allocated_session
             ON allocated_session.organization_id = allocation.organization_id
            AND allocated_session.id = allocation.reconciliation_session_id
            AND allocated_session.status <> 'VOIDED'
           LEFT JOIN bank_match_allocation_voids void
             ON void.organization_id = allocation.organization_id AND void.allocation_id = allocation.id
           WHERE allocation.organization_id = $1
             AND allocation.observation_version_id = observation.id AND void.id IS NULL), 0)::text AS observation_allocated,
         coalesce((SELECT sum(allocation.allocated_amount)
           FROM bank_match_allocations allocation
           JOIN bank_reconciliation_sessions allocated_session
             ON allocated_session.organization_id = allocation.organization_id
            AND allocated_session.id = allocation.reconciliation_session_id
            AND allocated_session.status <> 'VOIDED'
           LEFT JOIN bank_match_allocation_voids void
             ON void.organization_id = allocation.organization_id AND void.allocation_id = allocation.id
           WHERE allocation.organization_id = $1
             AND allocation.journal_line_id = line.id AND void.id IS NULL), 0)::text AS line_allocated
       FROM selected_observation observation CROSS JOIN selected_line line`,
      [input.principal.organizationId, input.observationVersionId,
        session.external_account_id, session.statement_start_on, session.statement_end_on,
        session.currency_code, input.journalLineId, session.cash_account_combination_id],
    );
    const selected = pair.rows[0];
    if (!selected) throw new BankingServiceError("Choose a current bank observation and posted cash line inside this statement range.", 400, "INVALID_MATCH_PAIR");
    const observationAmount = new Decimal(selected.observation_amount);
    const lineAmount = new Decimal(selected.line_amount);
    if (observationAmount.isPositive() !== lineAmount.isPositive()) {
      throw new BankingServiceError("The bank observation and cash line must have the same inflow or outflow direction.", 400, "MATCH_DIRECTION_MISMATCH");
    }
    const observationRemaining = observationAmount.abs().minus(selected.observation_allocated);
    const lineRemaining = lineAmount.abs().minus(selected.line_allocated);
    if (amount.greaterThan(observationRemaining) || amount.greaterThan(lineRemaining)) {
      throw new BankingServiceError("The allocation exceeds the remaining observation or journal-line amount.", 409, "MATCH_OVERALLOCATION");
    }
    const allocationId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO bank_match_allocations(
         id, organization_id, reconciliation_session_id, observation_version_id,
         journal_line_id, match_kind, allocated_amount, idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$3,$4,$5,'MANUAL',$6,$7,$8,$9)
       ON CONFLICT (organization_id, reconciliation_session_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [allocationId, input.principal.organizationId, session.id, input.observationVersionId,
        input.journalLineId, allocatedAmount, idempotencyKey, commandHash, input.principal.userId],
    );
    if (!inserted.rows[0]) {
      const conflict = await client.query<{ id: string; command_hash: string }>(
        `SELECT id, command_hash FROM bank_match_allocations
         WHERE organization_id = $1 AND reconciliation_session_id = $2 AND idempotency_key = $3
         FOR SHARE`,
        [input.principal.organizationId, session.id, idempotencyKey],
      );
      if (conflict.rows[0]) {
        if (matchesStoredCommandFingerprint(
          conflict.rows[0].command_hash,
          commandFingerprints,
        )) {
          return { allocationId: conflict.rows[0].id, idempotentReplay: true };
        }
        throw new BankingServiceError("The match idempotency key was already used for a different allocation.", 409, "IDEMPOTENCY_CONFLICT");
      }
      throw new BankingServiceError("The match allocation conflicted with another request. Retry with the same idempotency key.", 409, "MATCH_CONFLICT");
    }
    return { allocationId: inserted.rows[0].id, idempotentReplay: false };
  });
}

export async function voidBankMatchAllocation(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  reconciliationId: string;
  allocationId: string;
  reason: string;
}>): Promise<Readonly<{ voidId: string }>> {
  assertBankingSession(input.principal);
  return withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.prepareBankReconciliation,
    reason: input.reason,
  }, async (client) => {
    const session = await lockReconciliation(client, input.principal.organizationId, input.reconciliationId);
    if (session.status !== "DRAFT") throw new BankingServiceError("Matches can be voided only while the reconciliation is a draft.", 409, "RECONCILIATION_LOCKED");
    const allocation = await client.query(
      `SELECT 1 FROM bank_match_allocations allocation
       LEFT JOIN bank_match_allocation_voids void
         ON void.organization_id = allocation.organization_id AND void.allocation_id = allocation.id
       WHERE allocation.organization_id = $1 AND allocation.id = $2
         AND allocation.reconciliation_session_id = $3 AND void.id IS NULL`,
      [input.principal.organizationId, input.allocationId, session.id],
    );
    if (!allocation.rows[0]) throw new BankingServiceError("The active match allocation was not found.", 404, "MATCH_NOT_FOUND");
    const voidId = randomUUID();
    await client.query(
      `INSERT INTO bank_match_allocation_voids(
         id, organization_id, allocation_id, reason, created_by
       ) VALUES ($1,$2,$3,$4,$5)`,
      [voidId, input.principal.organizationId, input.allocationId, input.reason, input.principal.userId],
    );
    return { voidId };
  });
}

export async function transitionBankReconciliation(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  reconciliationId: string;
} & (
  { action: "SUBMIT" | "REVIEW" | "FINALIZE" }
  | { action: "VOID"; reason: string }
)>): Promise<Readonly<{ reconciliationId: string; status: string; proof: BankReconciliationProof }>> {
  assertBankingSession(input.principal);
  if ((input.action === "REVIEW" || input.action === "FINALIZE" || input.action === "VOID") && input.principal.sessionMode === "real" && !hasRecentStepUp(input.principal)) {
    throw new BankingServiceError("Verify your authenticator before reviewing, finalizing, or voiding a bank reconciliation.", 428, "MFA_STEP_UP_REQUIRED");
  }
  const voidReason = input.action === "VOID" ? input.reason.trim() : "";
  if (input.action === "VOID" && (voidReason.length < 8 || voidReason.length > 500)) {
    throw new BankingServiceError("Enter a permanent void reason between 8 and 500 characters.", 400, "INVALID_VOID_REASON");
  }
  return withAuthorizedBankingWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: input.action === "VOID"
      ? null
      : input.action === "REVIEW" || input.action === "FINALIZE"
        ? PERMISSIONS.reviewBankReconciliation
        : PERMISSIONS.prepareBankReconciliation,
    reason: `${input.action.toLowerCase()} a balanced bank reconciliation`,
  }, async (client) => {
    const session = await lockReconciliation(client, input.principal.organizationId, input.reconciliationId);
    if (input.action === "VOID") {
      const requiredPermission = session.status === "REVIEWED"
        ? PERMISSIONS.reviewBankReconciliation
        : PERMISSIONS.prepareBankReconciliation;
      const allowed = await actorHasActivePermission(client, {
        organizationId: input.principal.organizationId,
        actorId: input.principal.userId,
        permission: requiredPermission,
      });
      if (!allowed) {
        throw new BankingServiceError(
          session.status === "REVIEWED"
            ? "Review permission is required to void a reviewed reconciliation."
            : "Preparation permission is required to void this reconciliation.",
          403,
          "RECONCILIATION_VOID_PERMISSION_REQUIRED",
        );
      }
    }
    await lockBankEvidence(client, input.principal.organizationId, session.external_account_id);
    const proof = await reconciliationProof(client, input.principal.organizationId, session);
    if (input.action === "VOID") {
      if (session.status === "FINALIZED") {
        throw new BankingServiceError("A finalized reconciliation cannot be voided; preserve it and prepare a separately evidenced correction.", 409, "FINALIZED_RECONCILIATION_IMMUTABLE");
      }
      if (session.status === "VOIDED") {
        throw new BankingServiceError("The reconciliation is already voided.", 409, "RECONCILIATION_ALREADY_VOIDED");
      }
      const voidId = randomUUID();
      await client.query(
        `INSERT INTO bank_reconciliation_voids(
           id, organization_id, reconciliation_session_id, reason, created_by
         ) VALUES ($1,$2,$3,$4,$5)`,
        [voidId, input.principal.organizationId, session.id, voidReason, input.principal.userId],
      );
      await client.query(
        `UPDATE bank_reconciliation_sessions SET status = 'VOIDED'
         WHERE organization_id = $1 AND id = $2`,
        [input.principal.organizationId, session.id],
      );
      return { reconciliationId: session.id, status: "VOIDED", proof };
    }
    assertBalancedProof(proof);
    if (input.action === "SUBMIT") {
      if (session.status !== "DRAFT") throw new BankingServiceError("Only a draft reconciliation can be submitted.", 409, "INVALID_RECONCILIATION_STATE");
      await client.query(
        `UPDATE bank_reconciliation_sessions SET status = 'SUBMITTED', submitted_by = $3, submitted_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [input.principal.organizationId, session.id, input.principal.userId],
      );
      return { reconciliationId: session.id, status: "SUBMITTED", proof };
    }
    if (input.action === "REVIEW") {
      if (session.status !== "SUBMITTED") throw new BankingServiceError("Only a submitted reconciliation can be reviewed.", 409, "INVALID_RECONCILIATION_STATE");
      await client.query(
        `UPDATE bank_reconciliation_sessions SET status = 'REVIEWED', reviewed_by = $3, reviewed_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [input.principal.organizationId, session.id, input.principal.userId],
      );
      return { reconciliationId: session.id, status: "REVIEWED", proof };
    }
    if (session.status !== "REVIEWED") throw new BankingServiceError("Only a reviewed reconciliation can be finalized.", 409, "INVALID_RECONCILIATION_STATE");
    await client.query(
      `UPDATE bank_reconciliation_sessions SET
         status = 'FINALIZED', finalized_by = $3, finalized_at = now(),
         finalized_observation_total = $4, finalized_ledger_total = $5,
         finalized_unexplained_difference = $6, finalized_match_hash = $7
       WHERE organization_id = $1 AND id = $2`,
      [input.principal.organizationId, session.id, input.principal.userId,
        proof.observationTotal, proof.ledgerTotal, proof.unexplainedDifference, proof.matchHash],
    );
    return { reconciliationId: session.id, status: "FINALIZED", proof };
  });
}
