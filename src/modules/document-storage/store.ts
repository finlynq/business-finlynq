import "server-only";
import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import { loadActiveOrganizationKey, loadOrganizationKeyVersion } from "@/security/organization-key-store";
import { decryptField, encryptField, parseEncryptedField, serializeEncryptedField } from "@/security/organization-encryption";
import { assertPermission, permissionForOwner } from "@/modules/subledger/ar-ap-access";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";
import { CloudDrive, credentialSchema, exchangeStorageToken, locationSchema, StorageError, type StorageLocation } from "./provider";
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
export async function loadConnection(client: PoolClient, context: TenantTransactionContext, connectionId: string, access: "read" | "manage" | "admin", requireActive = true): Promise<ConnectionRow> {
  realStorageContext(context);
  const row = (await client.query<ConnectionRow>("SELECT * FROM document_storage_connections WHERE organization_id=$1 AND id=$2 FOR UPDATE", [context.organizationId, connectionId])).rows[0];
  if (!row || (requireActive && !row.active)) throw new StorageError("STORAGE_DISCONNECTED", "The storage connection is unavailable. Reconnect it in Document storage.");
  await assertPermission(client, context, access === "admin" ? PERMISSIONS.manageOrganizationSettings : permissionForOwner(row.owner_module, access));
  return row;
}
export async function connectionLocation(client: PoolClient, row: ConnectionRow) {
  if (!row.config_ciphertext) throw new StorageError("STORAGE_DISCONNECTED", "Complete the storage connection first.");
  return locationSchema.parse(await decryptStorageValue(client, row, "document_storage_connections", "config_ciphertext", row.config_ciphertext));
}
export async function connectedDrive(client: PoolClient, row: ConnectionRow): Promise<{ drive: CloudDrive; location: StorageLocation }> {
  const location = await connectionLocation(client, row);
  if (!row.credentials_ciphertext) throw new StorageError("STORAGE_DISCONNECTED", "Reconnect the storage account.");
  let credentials = credentialSchema.parse(await decryptStorageValue(client, row, "document_storage_connections", "credentials_ciphertext", row.credentials_ciphertext));
  if (credentials.expiresAt < Date.now() + 60000) {
    credentials = await exchangeStorageToken(row.provider, { refreshToken: credentials.refreshToken });
    const ciphertext = await encryptStorageValue(client, row, "document_storage_connections", "credentials_ciphertext", credentials);
    await client.query("UPDATE document_storage_connections SET credentials_ciphertext=$3 WHERE organization_id=$1 AND id=$2", [row.organization_id, row.id, ciphertext]);
  }
  return { drive: new CloudDrive(row.provider, credentials.accessToken, location.driveId), location };
}
