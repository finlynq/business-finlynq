import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { loadActiveOrganizationKey, loadOrganizationKeyVersion } from "@/security/organization-key-store";
import { decryptField, encryptField, parseEncryptedField, serializeEncryptedField } from "@/security/organization-encryption";
import { assertPermission, permissionForOwner } from "@/modules/subledger/ar-ap-access";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";
import { CloudDrive, credentialSchema, exchangeStorageToken, locationSchema, StorageError, type StorageCredentials, type StorageLocation } from "./provider";
import type { StorageProvider } from "./model";

export type ConnectionRow = {
  id: string; organization_id: string; legal_entity_id: string; owner_module: "payables" | "receivables";
  provider: StorageProvider; label: string; config_ciphertext: string | null; credentials_ciphertext: string | null;
  key_version: number; active: boolean; created_by: string; last_synced_at: Date | null; sync_cursor: string | null;
  oauth_state_hash: string | null;
};
export function realStorageContext(context: TenantTransactionContext) {
  if (context.sessionMode === "demo" || /demo/i.test(context.authMethod) || !context.sessionId) throw new StorageError("STORAGE_REAL_ACCOUNT", "Cloud storage requires a signed-in real account.");
}
export async function assertStorageWrite(client: PoolClient, context: TenantTransactionContext) {
  realStorageContext(context); assertTenantWritesEnabled(context); await assertWritableOrganization(client, context);
}
type EncryptedRow = { id: string; organization_id: string; key_version: number };
function scope(row: EncryptedRow, table: string, column: string) {
  return { organizationId: row.organization_id, table, column, recordId: row.id, keyVersion: row.key_version };
}
export async function encryptStorageValue(client: PoolClient, row: EncryptedRow, table: string, column: string, value: unknown) {
  const key = await loadOrganizationKeyVersion(client, row.organization_id, row.key_version);
  try { return serializeEncryptedField(encryptField(JSON.stringify(value), key.dek, scope(row, table, column))); }
  finally { key.dek.fill(0); }
}
export async function decryptStorageValue(client: PoolClient, row: EncryptedRow, table: string, column: string, value: string): Promise<unknown> {
  const key = await loadOrganizationKeyVersion(client, row.organization_id, row.key_version);
  try { return JSON.parse(decryptField(parseEncryptedField(value), key.dek, scope(row, table, column))); }
  finally { key.dek.fill(0); }
}
export async function activeKeyVersion(client: PoolClient, organizationId: string) {
  const key = await loadActiveOrganizationKey(client, organizationId);
  try { return key.keyVersion; } finally { key.dek.fill(0); }
}
export async function loadConnection(
  client: PoolClient,
  context: TenantTransactionContext,
  connectionId: string,
  access: "read" | "manage" | "admin" | "banking",
  requireActive = true,
  lock: "update" | "none" = "update",
): Promise<ConnectionRow> {
  realStorageContext(context);
  const row = (await client.query<ConnectionRow>(
    `SELECT * FROM document_storage_connections
     WHERE organization_id=$1 AND id=$2${lock === "update" ? " FOR UPDATE" : ""}`,
    [context.organizationId, connectionId],
  )).rows[0];
  if (!row || (requireActive && !row.active)) throw new StorageError("STORAGE_DISCONNECTED", "The storage connection is unavailable. Reconnect it in Document storage.");
  await assertPermission(client, context,
    access === "admin"
      ? PERMISSIONS.manageOrganizationSettings
      : access === "banking"
        ? PERMISSIONS.readBanking
        : permissionForOwner(row.owner_module, access));
  return row;
}
export async function connectionLocation(client: PoolClient, row: ConnectionRow) {
  if (!row.config_ciphertext) throw new StorageError("STORAGE_DISCONNECTED", "Complete the storage connection first.");
  return locationSchema.parse(await decryptStorageValue(client, row, "document_storage_connections", "config_ciphertext", row.config_ciphertext));
}
function isDatabaseLockContention(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "55P03");
}

const credentialRefreshLeaseSchema = z.object({
  id: z.uuid(),
  expiresAt: z.number().int().positive(),
}).strict();
const storedCredentialSchema = credentialSchema.extend({
  refreshLease: credentialRefreshLeaseSchema.optional(),
});
type StoredCredentials = z.infer<typeof storedCredentialSchema>;
export type PreparedDriveAccess = Readonly<{
  connection: ConnectionRow;
  location: StorageLocation;
  credentials: StoredCredentials;
  authorizationAccess: "read" | "banking";
}>;

const CREDENTIAL_REFRESH_THRESHOLD_MILLISECONDS = 60_000;
const CREDENTIAL_REFRESH_LEASE_MILLISECONDS = 30_000;
const credentialRefreshes = new Map<string, Promise<{ drive: CloudDrive; location: StorageLocation }>>();

function credentialsNeedRefresh(credentials: StorageCredentials): boolean {
  return credentials.expiresAt < Date.now() + CREDENTIAL_REFRESH_THRESHOLD_MILLISECONDS;
}

function unleasedCredentials(credentials: StorageCredentials): StorageCredentials {
  return {
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
  };
}

function retryableCredentialRefresh(): StorageError {
  return new StorageError(
    "STORAGE_RETRYABLE",
    "Cloud evidence authorization is being renewed. Retry after 1 second.",
    1,
  );
}

function credentialRefreshContext(
  context: TenantTransactionContext,
  phase: "claim" | "finish" | "abandon",
  leaseId: string,
): TenantTransactionContext {
  const suffix = ":storage-credential-" + phase + ":" + leaseId;
  return {
    ...context,
    requestId: context.requestId.slice(0, 200 - suffix.length) + suffix,
  };
}

async function lockConnectionForCredentialRefresh(client: PoolClient, row: ConnectionRow): Promise<ConnectionRow> {
  try {
    await client.query("SET LOCAL lock_timeout = '500ms'");
    const latest = (await client.query<ConnectionRow>(
      `SELECT * FROM document_storage_connections
       WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [row.organization_id, row.id],
    )).rows[0];
    if (!latest?.active) {
      throw new StorageError("STORAGE_DISCONNECTED", "The storage connection is unavailable. Reconnect it in Document storage.");
    }
    return latest;
  } catch (error) {
    if (isDatabaseLockContention(error)) {
      throw new StorageError(
        "STORAGE_RETRYABLE",
        "Cloud evidence access is temporarily busy. Retry after 1 second.",
        1,
      );
    }
    throw error;
  }
}

export async function prepareConnectedDrive(
  client: PoolClient,
  row: ConnectionRow,
  authorizationAccess: PreparedDriveAccess["authorizationAccess"] = "read",
): Promise<PreparedDriveAccess> {
  const location = await connectionLocation(client, row);
  if (!row.credentials_ciphertext) throw new StorageError("STORAGE_DISCONNECTED", "Reconnect the storage account.");
  const credentials = storedCredentialSchema.parse(await decryptStorageValue(
    client,
    row,
    "document_storage_connections",
    "credentials_ciphertext",
    row.credentials_ciphertext,
  ));
  return { connection: row, location, credentials, authorizationAccess };
}

function driveAccess(access: PreparedDriveAccess, credentials: StorageCredentials = access.credentials) {
  return {
    drive: new CloudDrive(access.connection.provider, credentials.accessToken, access.location.driveId),
    location: access.location,
  };
}

function assertSameStorageConnection(expected: ConnectionRow, actual: ConnectionRow): void {
  if (actual.provider !== expected.provider || actual.owner_module !== expected.owner_module) {
    throw new StorageError("STORAGE_DISCONNECTED", "The storage connection changed. Retry after reconnecting it.");
  }
}

type CredentialRefreshClaim =
  | Readonly<{ kind: "ready"; access: PreparedDriveAccess }>
  | Readonly<{
      kind: "claimed";
      connection: ConnectionRow;
      credentials: StorageCredentials;
      leaseId: string;
    }>;

async function claimCredentialRefresh(
  context: TenantTransactionContext,
  prepared: PreparedDriveAccess,
): Promise<CredentialRefreshClaim> {
  const leaseId = randomUUID();
  return withTenantTransaction(credentialRefreshContext(context, "claim", leaseId), async (client) => {
    const authorized = await loadConnection(client, context, prepared.connection.id, prepared.authorizationAccess, true, "none");
    assertSameStorageConnection(prepared.connection, authorized);
    const latest = await lockConnectionForCredentialRefresh(client, authorized);
    assertSameStorageConnection(prepared.connection, latest);
    const current = await prepareConnectedDrive(client, latest, prepared.authorizationAccess);
    if (!credentialsNeedRefresh(current.credentials)) return { kind: "ready", access: current };
    if (current.credentials.refreshLease?.expiresAt && current.credentials.refreshLease.expiresAt > Date.now()) {
      throw retryableCredentialRefresh();
    }

    const credentials = unleasedCredentials(current.credentials);
    const leased = {
      ...credentials,
      refreshLease: { id: leaseId, expiresAt: Date.now() + CREDENTIAL_REFRESH_LEASE_MILLISECONDS },
    } satisfies StoredCredentials;
    const ciphertext = await encryptStorageValue(
      client,
      latest,
      "document_storage_connections",
      "credentials_ciphertext",
      leased,
    );
    await client.query(
      "UPDATE document_storage_connections SET credentials_ciphertext=$3 WHERE organization_id=$1 AND id=$2 AND active=true",
      [latest.organization_id, latest.id, ciphertext],
    );
    return { kind: "claimed", connection: latest, credentials, leaseId };
  });
}

async function finishCredentialRefresh(
  context: TenantTransactionContext,
  prepared: PreparedDriveAccess,
  leaseId: string,
  refreshed: StorageCredentials,
) {
  return withTenantTransaction(credentialRefreshContext(context, "finish", leaseId), async (client) => {
    const authorized = await loadConnection(client, context, prepared.connection.id, prepared.authorizationAccess, true, "none");
    assertSameStorageConnection(prepared.connection, authorized);
    const latest = await lockConnectionForCredentialRefresh(client, authorized);
    assertSameStorageConnection(prepared.connection, latest);
    const current = await prepareConnectedDrive(client, latest, prepared.authorizationAccess);
    if (current.credentials.refreshLease?.id !== leaseId) {
      if (!credentialsNeedRefresh(current.credentials)) return driveAccess(current);
      throw retryableCredentialRefresh();
    }
    const ciphertext = await encryptStorageValue(
      client,
      latest,
      "document_storage_connections",
      "credentials_ciphertext",
      unleasedCredentials(refreshed),
    );
    await client.query(
      "UPDATE document_storage_connections SET credentials_ciphertext=$3 WHERE organization_id=$1 AND id=$2 AND active=true",
      [latest.organization_id, latest.id, ciphertext],
    );
    return {
      drive: new CloudDrive(latest.provider, refreshed.accessToken, current.location.driveId),
      location: current.location,
    };
  });
}

async function abandonCredentialRefresh(
  context: TenantTransactionContext,
  prepared: PreparedDriveAccess,
  leaseId: string,
  credentials: StorageCredentials,
): Promise<void> {
  await withTenantTransaction(credentialRefreshContext(context, "abandon", leaseId), async (client) => {
    const authorized = await loadConnection(client, context, prepared.connection.id, prepared.authorizationAccess, false, "none");
    if (!authorized.active) return;
    assertSameStorageConnection(prepared.connection, authorized);
    const latest = await lockConnectionForCredentialRefresh(client, authorized);
    const current = await prepareConnectedDrive(client, latest, prepared.authorizationAccess);
    if (current.credentials.refreshLease?.id !== leaseId) return;
    const ciphertext = await encryptStorageValue(
      client,
      latest,
      "document_storage_connections",
      "credentials_ciphertext",
      unleasedCredentials(credentials),
    );
    await client.query(
      "UPDATE document_storage_connections SET credentials_ciphertext=$3 WHERE organization_id=$1 AND id=$2 AND active=true",
      [latest.organization_id, latest.id, ciphertext],
    );
  });
}

async function refreshPreparedDrive(
  context: TenantTransactionContext,
  prepared: PreparedDriveAccess,
) {
  const claim = await claimCredentialRefresh(context, prepared);
  if (claim.kind === "ready") return driveAccess(claim.access);
  try {
    // The encrypted lease is durable, but the provider call deliberately runs
    // after its claiming transaction committed and without a connection-row lock.
    const refreshed = await exchangeStorageToken(claim.connection.provider, {
      refreshToken: claim.credentials.refreshToken,
    });
    return await finishCredentialRefresh(context, prepared, claim.leaseId, refreshed);
  } catch (error) {
    await abandonCredentialRefresh(
      context,
      prepared,
      claim.leaseId,
      claim.credentials,
    ).catch(() => undefined);
    throw error;
  }
}

export async function resolvePreparedDrive(
  context: TenantTransactionContext,
  prepared: PreparedDriveAccess,
): Promise<{ drive: CloudDrive; location: StorageLocation }> {
  if (!credentialsNeedRefresh(prepared.credentials)) return driveAccess(prepared);
  const key = createHash("sha256")
    .update(`${prepared.connection.organization_id}:${prepared.connection.id}`)
    .digest("hex");
  const existing = credentialRefreshes.get(key);
  if (existing) return existing;
  const refresh = refreshPreparedDrive(context, prepared);
  credentialRefreshes.set(key, refresh);
  try {
    return await refresh;
  } finally {
    if (credentialRefreshes.get(key) === refresh) credentialRefreshes.delete(key);
  }
}

export async function connectedDrive(
  client: PoolClient,
  row: ConnectionRow,
): Promise<{ drive: CloudDrive; location: StorageLocation }> {
  const prepared = await prepareConnectedDrive(client, row);
  let credentials: StorageCredentials = prepared.credentials;
  if (credentialsNeedRefresh(credentials)) {
    if (prepared.credentials.refreshLease?.expiresAt && prepared.credentials.refreshLease.expiresAt > Date.now()) {
      throw retryableCredentialRefresh();
    }
    credentials = await exchangeStorageToken(row.provider, { refreshToken: credentials.refreshToken });
    const ciphertext = await encryptStorageValue(client, row, "document_storage_connections", "credentials_ciphertext", credentials);
    await client.query("UPDATE document_storage_connections SET credentials_ciphertext=$3 WHERE organization_id=$1 AND id=$2", [row.organization_id, row.id, ciphertext]);
  }
  return driveAccess(prepared, credentials);
}
