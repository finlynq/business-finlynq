import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import { encryptField, serializeEncryptedField } from "@/security/organization-encryption";
import { scanEvidence } from "@/security/evidence-scanner";
import { downloadCloudEvidence } from "@/modules/document-storage/evidence";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";
import { assertPermission, permissionForOwner, withoutContext } from "./ar-ap-access";
import { acquireDocumentIdentityLock, acquireIdempotencyLock, assertIdempotentSource,
  currentSourceDocument, findSourceByIdempotency } from "./ar-ap-idempotency";
import { appendSourceDocument, recordFromRow } from "./ar-ap-persistence";
import { businessDocumentSnapshotSchema, canonicalHash, DOCUMENT_KIND_POLICY } from "./document-model";
import { attachEvidenceSchema, detachEvidenceSchema, evidenceReferencesSchema, uploadEvidenceSchema } from "./evidence-model";
import { decodeEvidence } from "./evidence-content";
import { decryptEvidenceContent, EVIDENCE_METADATA_COLUMNS, evidenceEncryptionContext,
  evidenceMetadata, loadDocumentEvidence, type EvidenceRow } from "./evidence-store";

type Context = { context: TenantTransactionContext };
export async function uploadDocumentEvidence(unparsed: Context & z.input<typeof uploadEvidenceSchema>) {
  assertTenantWritesEnabled(unparsed.context);
  const command = uploadEvidenceSchema.parse(withoutContext(unparsed));
  const hash = canonicalHash({ operation: "evidence-upload", command });
  const key = `evidence-upload:${canonicalHash(command.idempotencyKey)}`;
  const authorizeAndReplay = async () => withTenantTransaction(unparsed.context, async (client) => {
    await assertWritableOrganization(client, unparsed.context);
    await assertPermission(client, unparsed.context, permissionForOwner(command.module, "manage"));
    const found = await client.query<EvidenceRow>(
      `SELECT ${EVIDENCE_METADATA_COLUMNS} FROM document_evidence_assets
       WHERE organization_id = $1 AND idempotency_key = $2`, [unparsed.context.organizationId, key]);
    if (!found.rows[0]) return null;
    if (found.rows[0].command_hash !== hash) throw new Error("Evidence idempotency key was used for different content");
    return { asset: await evidenceMetadata(client, found.rows[0]), idempotentReplay: true };
  });
  const replay = await authorizeAndReplay();
  if (replay) return replay;
  const bytes = decodeEvidence(command);
  try {
    const scan = await scanEvidence(bytes);
    return await withTenantTransaction(unparsed.context, async (client) => {
      // Scanning happens outside the transaction; reauthorize immediately before storage.
      await assertWritableOrganization(client, unparsed.context);
      await assertPermission(client, unparsed.context, permissionForOwner(command.module, "manage"));
      await acquireIdempotencyLock(client, unparsed.context.organizationId, key);
      const found = await client.query<EvidenceRow>(
        `SELECT ${EVIDENCE_METADATA_COLUMNS} FROM document_evidence_assets
         WHERE organization_id = $1 AND idempotency_key = $2`, [unparsed.context.organizationId, key]);
      if (found.rows[0]) {
        if (found.rows[0].command_hash !== hash) throw new Error("Evidence idempotency key was used for different content");
        return { asset: await evidenceMetadata(client, found.rows[0]), idempotentReplay: true };
      }
      const encryption = await loadActiveOrganizationKey(client, unparsed.context.organizationId);
      try {
        const id = randomUUID();
        const scope = { id, organization_id: unparsed.context.organizationId, key_version: encryption.keyVersion };
        const filename = serializeEncryptedField(encryptField(command.filename, encryption.dek,
          evidenceEncryptionContext(scope, "filename_ciphertext")));
        const content = serializeEncryptedField(encryptField(command.contentBase64, encryption.dek,
          evidenceEncryptionContext(scope, "content_ciphertext")));
        const result = await client.query<EvidenceRow>(
          `INSERT INTO document_evidence_assets (
             id, organization_id, owner_module, filename_ciphertext, content_ciphertext, key_version,
             mime_type, byte_size, sha256, scanner_version, scanned_at, uploaded_by, idempotency_key, command_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING ${EVIDENCE_METADATA_COLUMNS}`,
          [id, scope.organization_id, command.module, filename, content, scope.key_version,
            command.mimeType, command.byteSize, command.sha256, scan.version, scan.scannedAt,
            unparsed.context.actorId, key, hash]);
        return { asset: await evidenceMetadata(client, result.rows[0]), idempotentReplay: false };
      } finally { encryption.dek.fill(0); }
    });
  } finally { bytes.fill(0); }
}

async function changeEvidence(
  unparsed: Context & (z.input<typeof attachEvidenceSchema> | z.input<typeof detachEvidenceSchema>),
  operation: "attach" | "detach",
) {
  return withTenantTransaction(unparsed.context, (client) => changeEvidenceInTransaction(client, unparsed, operation));
}
export async function changeEvidenceInTransaction(
  client: PoolClient,
  unparsed: Context & (z.input<typeof attachEvidenceSchema> | z.input<typeof detachEvidenceSchema>),
  operation: "attach" | "detach",
) {
  assertTenantWritesEnabled(unparsed.context);
  const command = operation === "attach"
    ? attachEvidenceSchema.parse(withoutContext(unparsed))
    : detachEvidenceSchema.parse(withoutContext(unparsed));
  const policy = DOCUMENT_KIND_POLICY[command.kind];
  const hash = canonicalHash({ operation: `evidence-${operation}`, command });
  const key = `evidence-${operation}:${canonicalHash(command.idempotencyKey)}`;
  await assertWritableOrganization(client, unparsed.context);
  await assertPermission(client, unparsed.context, permissionForOwner(policy.ownerModule, "manage"));
  await acquireIdempotencyLock(client, unparsed.context.organizationId, key);
  const replay = await findSourceByIdempotency(client, unparsed.context.organizationId, key);
  if (replay) {
    assertIdempotentSource(replay, { current: hash, legacy: hash }, "DRAFT");
    return { document: recordFromRow(replay), idempotentReplay: true };
  }
  await acquireDocumentIdentityLock(client, unparsed.context.organizationId, policy.sourceType, command.sourceNumber);
  const current = await currentSourceDocument(client, unparsed.context.organizationId, policy.sourceType, command.sourceNumber, true);
  if (!current || current.status !== "DRAFT" || current.version !== command.expectedVersion) {
    throw new Error("Evidence changes require the exact current DRAFT version");
  }
  const snapshot = businessDocumentSnapshotSchema.parse(current.snapshot);
  const refs = snapshot.evidence ?? [];
  const existing = refs.find((ref) => ref.assetId === command.assetId);
  if (operation === "attach") {
    const asset = await client.query<{ id: string }>(
      "SELECT id FROM document_evidence_assets WHERE organization_id = $1 AND owner_module = $2 AND id = $3",
      [unparsed.context.organizationId, policy.ownerModule, command.assetId]);
    if (!asset.rows[0]) throw new Error("Evidence asset is unavailable for this document");
    if (existing) throw new Error("Evidence is already attached; reuse the original idempotency key");
  } else if (!existing) throw new Error("Evidence is not attached to this document version");
  const evidence = evidenceReferencesSchema.parse(operation === "attach"
    ? [...refs, { assetId: command.assetId, purpose: "purpose" in command ? command.purpose : undefined }]
    : refs.filter((ref) => ref.assetId !== command.assetId));
  const row = await appendSourceDocument(client, {
    context: { ...unparsed.context, reason: command.reason }, ownerModule: policy.ownerModule,
    sourceType: policy.sourceType, sourceNumber: command.sourceNumber, legalEntityId: current.legal_entity_id,
    version: current.version + 1, status: "DRAFT", snapshot: { ...snapshot, evidence },
    idempotencyKey: key, commandHash: hash, supersedesSourceDocumentId: current.id,
  });
  return { document: recordFromRow(row), idempotentReplay: false };
}
export const attachDocumentEvidence = (command: Context & z.input<typeof attachEvidenceSchema>) => changeEvidence(command, "attach");
export const detachDocumentEvidence = (command: Context & z.input<typeof detachEvidenceSchema>) => changeEvidence(command, "detach");

export async function downloadDocumentEvidence(command: Context & { assetId: string; sourceDocumentId: string }) {
  const assetId = z.uuid().parse(command.assetId);
  const sourceDocumentId = z.uuid().parse(command.sourceDocumentId);
  return withTenantTransaction(command.context, async (client) => {
    const result = await client.query<EvidenceRow>(
      `SELECT ${EVIDENCE_METADATA_COLUMNS}, content_ciphertext FROM document_evidence_assets
       WHERE organization_id = $1 AND id = $2`, [command.context.organizationId, assetId]);
    const row = result.rows[0];
    if (!row) throw new Error("Evidence is unavailable");
    await assertPermission(client, command.context, permissionForOwner(row.owner_module, "read"));
    // Recheck the exact immutable source version, including historical versions.
    const source = await client.query<{ id: string; source_number: string; version: number; snapshot: unknown }>(
      "SELECT id, source_number, version, snapshot FROM source_documents WHERE organization_id = $1 AND owner_module = $2 AND id = $3",
      [command.context.organizationId, row.owner_module, sourceDocumentId]);
    const document = source.rows[0];
    const snapshot = document ? businessDocumentSnapshotSchema.parse(document.snapshot) : null;
    if (!snapshot?.evidence?.some((ref) => ref.assetId === assetId)) throw new Error("Evidence is unavailable for this source version");
    const metadata = await loadDocumentEvidence(client, {
      organizationId: command.context.organizationId, ownerModule: row.owner_module,
      id: document.id, sourceNumber: document.source_number, version: document.version,
      evidence: snapshot.evidence.filter((ref) => ref.assetId === assetId),
    });
    return { metadata: metadata[0], bytes: row.storage_backend === "CLOUD"
      ? await downloadCloudEvidence(client, command.context, row) : await decryptEvidenceContent(client, row) };
  });
}
