import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import { encryptField, serializeEncryptedField } from "@/security/organization-encryption";
import { scanEvidence } from "@/security/evidence-scanner";
import { decodeEvidence } from "@/modules/subledger/evidence-content";
import { MAX_EVIDENCE_BYTES, uploadEvidenceSchema } from "@/modules/subledger/evidence-model";
import type { EvidenceRow } from "@/modules/subledger/evidence-store";
import { connectedDrive, loadConnection, type ConnectionRow } from "./store";
import { CloudDrive, StorageError, type CloudFile } from "./provider";
import { assertStoredFile } from "./boundaries";

export function supportedCloudFile(file: CloudFile) {
  return !file.folder && file.size > 0 && file.size <= MAX_EVIDENCE_BYTES && uploadEvidenceSchema.shape.mimeType.safeParse(file.mimeType).success;
}
export async function validatedCloudBytes(drive: CloudDrive, file: CloudFile) {
  if (!supportedCloudFile(file)) throw new StorageError("STORAGE_UNSUPPORTED_FILE", "Use a PDF, PNG, or JPEG of up to 2 MiB.");
  const bytes = await drive.download(file.id);
  try {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const verified = decodeEvidence({ module: "payables", filename: file.name, mimeType: uploadEvidenceSchema.shape.mimeType.parse(file.mimeType),
      byteSize: file.size, sha256, contentBase64: bytes.toString("base64"), idempotencyKey: "cloud-validation" });
    verified.fill(0);
    const scan = await scanEvidence(bytes);
    const latest = await drive.file(file.id);
    if (latest.id !== file.id || latest.parentId !== file.parentId || latest.mimeType !== file.mimeType || latest.version !== file.version || latest.size !== file.size) throw new StorageError("STORAGE_CONTENT_CHANGED", "The document changed or moved during processing. Sync and read it again.");
    return { bytes, sha256, scan, file: latest };
  } catch (error) { bytes.fill(0); throw error; }
}
export async function insertCloudEvidence(client: PoolClient, context: TenantTransactionContext, connection: ConnectionRow,
  itemId: string, file: CloudFile, sha256: string, scan: { version: string; scannedAt: string }, commandHash: string) {
  const key = await loadActiveOrganizationKey(client, context.organizationId);
  const assetId = randomUUID();
  try {
    const filename = serializeEncryptedField(encryptField(file.name, key.dek, { organizationId: context.organizationId, table: "document_evidence_assets", column: "filename_ciphertext", recordId: assetId, keyVersion: key.keyVersion }));
    await client.query(`INSERT INTO document_evidence_assets
      (id,organization_id,owner_module,filename_ciphertext,storage_backend,storage_connection_id,provider_file_id,key_version,mime_type,byte_size,sha256,scanner_version,scanned_at,uploaded_by,idempotency_key,command_hash)
      VALUES ($1,$2,$3,$4,'CLOUD',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [assetId, context.organizationId, connection.owner_module, filename, connection.id, file.id, key.keyVersion,
      file.mimeType, file.size, sha256, scan.version, scan.scannedAt, context.actorId, `cloud-inbox:${itemId}`, commandHash]);
    return assetId;
  } finally { key.dek.fill(0); }
}
export async function downloadCloudEvidence(client: PoolClient, context: TenantTransactionContext, row: EvidenceRow) {
  if (!row.storage_connection_id || !row.provider_file_id) throw new Error("External evidence reference is missing");
  const connection = await loadConnection(client, context, row.storage_connection_id, "read");
  if (connection.owner_module !== row.owner_module) throw new Error("Evidence storage module does not match");
  const { drive, location } = await connectedDrive(client, connection);
  const file = await drive.file(row.provider_file_id);
  await assertStoredFile(drive, location, file);
  const bytes = await drive.download(row.provider_file_id);
  try {
    if (bytes.length !== row.byte_size || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new StorageError("STORAGE_CONTENT_CHANGED", "The stored attachment has changed in the cloud. Its original integrity could not be verified.");
    const latest = await drive.file(row.provider_file_id);
    await assertStoredFile(drive, location, latest);
    if (latest.parentId !== file.parentId || latest.version !== file.version) throw new StorageError("STORAGE_CONTENT_CHANGED", "The attachment moved or changed during download. Retry after checking it in your drive.");
    return bytes;
  } catch (error) { bytes.fill(0); throw error; }
}
