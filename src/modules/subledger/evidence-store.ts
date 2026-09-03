import "server-only";

import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { loadOrganizationKeyVersion } from "@/security/organization-key-store";
import { decryptField, parseEncryptedField } from "@/security/organization-encryption";
import type { SubledgerOwnerModule } from "./document-model";
import type { DocumentEvidenceMetadata, EvidenceMetadata, EvidenceReference } from "./evidence-model";

export type EvidenceRow = {
  id: string; organization_id: string; owner_module: SubledgerOwnerModule;
  filename_ciphertext: string; content_ciphertext?: string; key_version: number;
  mime_type: string; byte_size: number; sha256: string; uploaded_by: string;
  created_at: Date | string; scanner_version: string; scanned_at: Date | string;
  command_hash: string;
};
export const EVIDENCE_METADATA_COLUMNS = `id, organization_id, owner_module, filename_ciphertext,
  key_version, mime_type, byte_size, sha256, uploaded_by, created_at, scanner_version, scanned_at, command_hash`;
export function evidenceEncryptionContext(row: Pick<EvidenceRow, "id" | "organization_id" | "key_version">, column: string) {
  return { organizationId: row.organization_id, table: "document_evidence_assets", column,
    recordId: row.id, keyVersion: row.key_version };
}
export async function evidenceMetadata(client: PoolClient, row: EvidenceRow): Promise<EvidenceMetadata> {
  const key = await loadOrganizationKeyVersion(client, row.organization_id, row.key_version);
  try {
    return {
      assetId: row.id,
      filename: decryptField(parseEncryptedField(row.filename_ciphertext), key.dek,
        evidenceEncryptionContext(row, "filename_ciphertext")),
      mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256,
      uploadedBy: row.uploaded_by, uploadedAt: new Date(row.created_at).toISOString(),
      scannerVersion: row.scanner_version, scannedAt: new Date(row.scanned_at).toISOString(),
    };
  } finally { key.dek.fill(0); }
}

export async function loadDocumentEvidence(client: PoolClient, input: {
  organizationId: string; ownerModule: SubledgerOwnerModule;
  id: string; sourceNumber: string; version: number; evidence?: readonly EvidenceReference[];
}): Promise<readonly DocumentEvidenceMetadata[]> {
  if (!input.evidence?.length) return [];
  const result = await client.query<EvidenceRow>(
    `SELECT ${EVIDENCE_METADATA_COLUMNS} FROM document_evidence_assets
     WHERE organization_id = $1 AND owner_module = $2 AND id = ANY($3::uuid[])`,
    [input.organizationId, input.ownerModule, input.evidence.map((ref) => ref.assetId)],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const attachments: DocumentEvidenceMetadata[] = [];
  for (const ref of input.evidence) {
    const row = byId.get(ref.assetId);
    if (!row) throw new Error("Document evidence is unavailable");
    attachments.push({ ...await evidenceMetadata(client, row), ...ref,
      sourceDocumentId: input.id, sourceNumber: input.sourceNumber, sourceVersion: input.version,
      downloadUrl: `/api/document-evidence/${row.id}?sourceDocumentId=${input.id}` });
  }
  return attachments;
}

export async function decryptEvidenceContent(client: PoolClient, row: EvidenceRow): Promise<Buffer> {
  if (!row.content_ciphertext) throw new Error("Evidence content is unavailable");
  const key = await loadOrganizationKeyVersion(client, row.organization_id, row.key_version);
  try {
    const bytes = Buffer.from(decryptField(parseEncryptedField(row.content_ciphertext), key.dek,
      evidenceEncryptionContext(row, "content_ciphertext")), "base64");
    if (bytes.length !== row.byte_size || createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
      bytes.fill(0);
      throw new Error("Evidence integrity check failed");
    }
    return bytes;
  } finally { key.dek.fill(0); }
}
