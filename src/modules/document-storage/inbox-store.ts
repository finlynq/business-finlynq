import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { TenantTransactionContext } from "@/db/transaction";
import { activeKeyVersion, decryptStorageValue, encryptStorageValue, loadConnection, type ConnectionRow } from "./store";
import { filingMetadataSchema, inboxStatusSchema } from "./model";
import { StorageError, type CloudFile } from "./provider";
import { supportedCloudFile } from "./evidence";

export type InboxRow = {
  id: string; organization_id: string; connection_id: string; owner_module: "payables" | "receivables";
  provider_file_id: string; content_version: string; metadata_ciphertext: string; key_version: number;
  mime_type: string; byte_size: string | number; sha256: string | null; status: z.infer<typeof inboxStatusSchema>;
  claim_id: string | null; claimed_by: string | null; claimed_session_id: string | null; lease_until: Date | null;
  asset_id: string | null; source_document_id: string | null; completion_hash: string | null; business_key: string | null;
  processing_ciphertext: string | null; created_at: Date; updated_at: Date;
};
export const processingSchema = z.object({ metadata: filingMetadataSchema.optional(), name: z.string().optional(),
  folders: z.array(z.string()).optional(), destinationId: z.string().optional(), reason: z.string().optional() });
export type Processing = z.infer<typeof processingSchema>;
export async function itemProcessing(client: PoolClient, row: InboxRow): Promise<Processing> {
  return row.processing_ciphertext ? processingSchema.parse(await decryptStorageValue(client, row, "document_inbox_items", "processing_ciphertext", row.processing_ciphertext)) : {};
}
export async function itemMetadata(client: PoolClient, row: InboxRow) {
  const metadata = z.object({ name: z.string(), reason: z.string().optional() }).parse(await decryptStorageValue(client, row, "document_inbox_items", "metadata_ciphertext", row.metadata_ciphertext));
  const processing = await itemProcessing(client, row);
  return { id: row.id, connectionId: row.connection_id, module: row.owner_module, filename: metadata.name,
    mimeType: row.mime_type, byteSize: Number(row.byte_size), status: row.status, sha256: row.sha256,
    leaseUntil: row.lease_until?.toISOString() ?? null, assetId: row.asset_id, sourceDocumentId: row.source_document_id,
    canonicalName: processing.name ?? null, filingMetadata: processing.metadata ?? null, reason: processing.reason ?? metadata.reason ?? null,
    createdAt: row.created_at.toISOString() };
}
export async function loadInboxItem(client: PoolClient, context: TenantTransactionContext, itemId: string, access: "read" | "manage" = "manage") {
  const initial = (await client.query<InboxRow>("SELECT * FROM document_inbox_items WHERE organization_id=$1 AND id=$2", [context.organizationId, z.uuid().parse(itemId)])).rows[0];
  if (!initial) throw new StorageError("STORAGE_ITEM_MISSING", "This inbox item is unavailable.");
  // All workflows acquire connection then item locks, including sync and filing.
  const connection = await loadConnection(client, context, initial.connection_id, access);
  const row = (await client.query<InboxRow>("SELECT * FROM document_inbox_items WHERE organization_id=$1 AND id=$2 FOR UPDATE", [context.organizationId, itemId])).rows[0];
  return { row, connection };
}
export function assertClaim(row: InboxRow, context: TenantTransactionContext, claimId: string) {
  if (row.status !== "CLAIMED" || row.claim_id !== claimId || row.claimed_by !== context.actorId || row.claimed_session_id !== context.sessionId || !row.lease_until || row.lease_until.getTime() <= Date.now()) {
    throw new StorageError("STORAGE_CLAIM_EXPIRED", "Claim or renew this document before processing it. Another client may have claimed it.");
  }
}
export async function discoverFile(client: PoolClient, context: TenantTransactionContext, connection: ConnectionRow, file: CloudFile) {
  if (file.folder) return null;
  const existing = (await client.query<InboxRow>("SELECT * FROM document_inbox_items WHERE organization_id=$1 AND connection_id=$2 AND provider_file_id=$3 FOR UPDATE", [context.organizationId, connection.id, file.id])).rows[0];
  if (existing && (existing.content_version === file.version || existing.completion_hash)) return existing;
  const scope = existing ?? { id: randomUUID(), organization_id: context.organizationId, key_version: await activeKeyVersion(client, context.organizationId) };
  const supported = supportedCloudFile(file);
  const metadata = await encryptStorageValue(client, scope, "document_inbox_items", "metadata_ciphertext", { name: file.name,
    ...(!supported ? { reason: "Use a PDF, PNG, or JPEG of up to 2 MiB. This file has not been ingested." } : {}) });
  if (existing) {
    return (await client.query<InboxRow>(`UPDATE document_inbox_items SET content_version=$3,metadata_ciphertext=$4,mime_type=$5,byte_size=$6,status=$7,
      sha256=NULL,claim_id=NULL,claimed_by=NULL,claimed_session_id=NULL,lease_until=NULL,processing_ciphertext=NULL WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [context.organizationId, existing.id, file.version, metadata, file.mimeType, file.size, supported ? "PENDING" : "NEEDS_REVIEW"])).rows[0];
  }
  return (await client.query<InboxRow>(`INSERT INTO document_inbox_items(id,organization_id,connection_id,owner_module,provider_file_id,content_version,metadata_ciphertext,key_version,mime_type,byte_size,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [scope.id, context.organizationId, connection.id, connection.owner_module, file.id, file.version, metadata, scope.key_version, file.mimeType, file.size, supported ? "PENDING" : "NEEDS_REVIEW"])).rows[0];
}
