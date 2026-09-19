import "server-only";
import type { PoolClient } from "pg";
import { loadActiveOrganizationKey, loadOrganizationKeyVersion } from "@/security/organization-key-store";
import { decryptField, encryptField, parseEncryptedField, serializeEncryptedField } from "@/security/organization-encryption";

export type EmailEncryptedRow = Readonly<{
  id: string;
  organization_id: string;
  key_version: number;
}>;

function encryptionContext(row: EmailEncryptedRow, table: string, column: string) {
  return {
    organizationId: row.organization_id,
    table,
    column,
    recordId: row.id,
    keyVersion: row.key_version,
  };
}

export async function activeEmailKeyVersion(client: PoolClient, organizationId: string): Promise<number> {
  const key = await loadActiveOrganizationKey(client, organizationId);
  try { return key.keyVersion; } finally { key.dek.fill(0); }
}

export async function encryptEmailValue(
  client: PoolClient,
  row: EmailEncryptedRow,
  table: string,
  column: string,
  value: unknown,
): Promise<string> {
  const key = await loadOrganizationKeyVersion(client, row.organization_id, row.key_version);
  try {
    return serializeEncryptedField(encryptField(JSON.stringify(value), key.dek, encryptionContext(row, table, column)));
  } finally { key.dek.fill(0); }
}

export async function decryptEmailValue(
  client: PoolClient,
  row: EmailEncryptedRow,
  table: string,
  column: string,
  ciphertext: string,
): Promise<unknown> {
  const key = await loadOrganizationKeyVersion(client, row.organization_id, row.key_version);
  try {
    return JSON.parse(decryptField(parseEncryptedField(ciphertext), key.dek, encryptionContext(row, table, column)));
  } finally { key.dek.fill(0); }
}
