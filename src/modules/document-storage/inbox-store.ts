import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { TenantTransactionContext } from "@/db/transaction";
import { activeKeyVersion, decryptStorageValue, encryptStorageValue, loadConnection, type ConnectionRow } from "./store";
import { filingMetadataSchema, inboxStatusSchema } from "./model";
import { StorageError, type CloudFile } from "./provider";
import { classifyInboxFile } from "./file-types";

export type InboxRow = {
  id: string; organization_id: string; connection_id: string; owner_module: "payables" | "receivables";
  provider_file_id: string; content_version: string; metadata_ciphertext: string; key_version: number;
  mime_type: string; byte_size: string | number; sha256: string | null; status: z.infer<typeof inboxStatusSchema>;
  claim_id: string | null; claimed_by: string | null; claimed_session_id: string | null; lease_until: Date | null;
  asset_id: string | null; source_document_id: string | null; completion_hash: string | null; business_key: string | null;
  processing_ciphertext: string | null; upload_key: string | null; upload_hash: string | null; created_at: Date; updated_at: Date;
};
const statementTransferCandidateSchema = z.object({
  sourceObservationVersionId: z.uuid(),
  counterpartObservationVersionId: z.uuid(),
  sourceAccountId: z.uuid(),
  counterpartAccountId: z.uuid(),
  postedOn: z.iso.date(),
  amount: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,9})?$/),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  instruction: z.string().min(1).max(500),
}).strict();

export const statementCompletionSchema = z.object({
  statementImportId: z.uuid(),
  externalAccountId: z.uuid(),
  reconciliationId: z.uuid().nullable(),
  evidenceAssetId: z.uuid(),
  reconciliationReused: z.boolean().optional(),
  importedRowCount: z.number().int().min(0).max(1_000),
  duplicateRowCount: z.number().int().min(0).max(1_000),
  excludedRowCount: z.number().int().min(0).max(1_000),
  idempotentReplay: z.boolean(),
  duplicateSource: z.boolean(),
  transferCandidates: z.array(statementTransferCandidateSchema).max(50),
  instruction: z.string().min(1).max(1_000),
}).strict();
export type StatementCompletion = z.infer<typeof statementCompletionSchema>;

export const processingSchema = z.object({
  metadata: filingMetadataSchema.optional(),
  name: z.string().optional(),
  folders: z.array(z.string()).optional(),
  destinationId: z.string().optional(),
  reason: z.string().optional(),
  statementImport: statementCompletionSchema.optional(),
});
export type Processing = z.infer<typeof processingSchema>;
export async function itemProcessing(client: PoolClient, row: InboxRow): Promise<Processing> {
  return row.processing_ciphertext ? processingSchema.parse(await decryptStorageValue(client, row, "document_inbox_items", "processing_ciphertext", row.processing_ciphertext)) : {};
}

const sourceMetadataSchema = z.object({
  name: z.string().min(1).max(1000),
  sourcePath: z.string().min(1).max(2000).optional(),
  sourceFolderId: z.string().min(1).max(512).optional(),
  sourceDepth: z.number().int().min(0).max(16).optional(),
  reason: z.string().max(500).optional(),
  errorCode: z.string().regex(/^STORAGE_[A-Z0-9_]+$/).optional(),
  routingTarget: z.literal("BANKING_IMPORT_REVIEW").optional(),
}).strict();
export type InboxSourceMetadata = z.infer<typeof sourceMetadataSchema>;

export async function itemSourceMetadata(client: PoolClient, row: InboxRow): Promise<InboxSourceMetadata> {
  return sourceMetadataSchema.parse(await decryptStorageValue(client, row, "document_inbox_items", "metadata_ciphertext", row.metadata_ciphertext));
}
export async function itemMetadata(client: PoolClient, row: InboxRow) {
  const metadata = await itemSourceMetadata(client, row);
  const processing = await itemProcessing(client, row);
  return { id: row.id, connectionId: row.connection_id, module: row.owner_module, filename: metadata.name,
    sourcePath: metadata.sourcePath ?? metadata.name, mimeType: row.mime_type, byteSize: Number(row.byte_size), status: row.status, sha256: row.sha256,
    leaseUntil: row.lease_until?.toISOString() ?? null, assetId: row.asset_id, sourceDocumentId: row.source_document_id,
    canonicalName: processing.name ?? null, filingMetadata: processing.metadata ?? null, reason: processing.reason ?? metadata.reason ?? null,
    errorCode: metadata.errorCode ?? null, routingTarget: metadata.routingTarget ?? null,
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

export type DiscoveryOutcome = "discovered" | "unchanged" | "unsupported";
export async function discoverFile(client: PoolClient, context: TenantTransactionContext, connection: ConnectionRow, file: CloudFile,
  source: { sourcePath: string; sourceFolderId: string; sourceDepth: number } = { sourcePath: file.name, sourceFolderId: file.parentId, sourceDepth: 0 },
): Promise<{ row: InboxRow | null; outcome: DiscoveryOutcome }> {
  if (file.folder || file.shortcut) return { row: null, outcome: "unchanged" };
  const existing = (await client.query<InboxRow>("SELECT * FROM document_inbox_items WHERE organization_id=$1 AND connection_id=$2 AND provider_file_id=$3 FOR UPDATE", [context.organizationId, connection.id, file.id])).rows[0];
  const support = classifyInboxFile(file);
  if (existing?.completion_hash) return { row: existing, outcome: support.supported ? "unchanged" : "unsupported" };

  const routingTarget = support.supported && ["CSV", "TSV", "TEXT", "XLS", "XLSX"].includes(support.format)
    ? "BANKING_IMPORT_REVIEW" as const : undefined;
  const nextMetadata = sourceMetadataSchema.parse({
    name: file.name,
    ...source,
    ...(!support.supported ? { reason: support.reason, errorCode: support.code } : {}),
    ...(routingTarget ? { routingTarget } : {}),
  });
  if (existing) {
    const previous = await itemSourceMetadata(client, existing);
    const preserveUploadedName = Boolean(existing.upload_key);
    const comparable = preserveUploadedName
      ? { ...nextMetadata, name: previous.name, sourcePath: previous.sourcePath ?? previous.name }
      : nextMetadata;
    if (existing.content_version === file.version
      && existing.mime_type === (support.supported ? support.canonicalMimeType : file.mimeType)
      && Number(existing.byte_size) === file.size
      && JSON.stringify(previous) === JSON.stringify(comparable)) {
      return { row: existing, outcome: support.supported ? "unchanged" : "unsupported" };
    }
    const metadata = await encryptStorageValue(client, existing, "document_inbox_items", "metadata_ciphertext", comparable);
    const row = (await client.query<InboxRow>(`UPDATE document_inbox_items SET content_version=$3,metadata_ciphertext=$4,mime_type=$5,byte_size=$6,status=$7,
      sha256=NULL,claim_id=NULL,claimed_by=NULL,claimed_session_id=NULL,lease_until=NULL,processing_ciphertext=NULL WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [context.organizationId, existing.id, file.version, metadata, support.supported ? support.canonicalMimeType : file.mimeType, file.size, support.supported ? "PENDING" : "NEEDS_REVIEW"])).rows[0];
    return { row, outcome: support.supported ? "discovered" : "unsupported" };
  }

  const scope = { id: randomUUID(), organization_id: context.organizationId, key_version: await activeKeyVersion(client, context.organizationId) };
  const metadata = await encryptStorageValue(client, scope, "document_inbox_items", "metadata_ciphertext", nextMetadata);
  const row = (await client.query<InboxRow>(`INSERT INTO document_inbox_items(id,organization_id,connection_id,owner_module,provider_file_id,content_version,metadata_ciphertext,key_version,mime_type,byte_size,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [scope.id, context.organizationId, connection.id, connection.owner_module, file.id, file.version, metadata, scope.key_version,
      support.supported ? support.canonicalMimeType : file.mimeType, file.size, support.supported ? "PENDING" : "NEEDS_REVIEW"])).rows[0];
  return { row, outcome: support.supported ? "discovered" : "unsupported" };
}
