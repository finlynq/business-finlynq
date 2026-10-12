import "server-only";

import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { bankStatementExtractionSchema, bankStatementMappingSchema } from "@/modules/banking/statement-import-model";
import { importBankStatementInTransaction, normalizeStatementImportDatabaseError } from "@/modules/banking/statement-import-service";
import { downloadDocumentEvidence, reauthorizeDocumentEvidenceLinkInTransaction } from "@/modules/subledger/evidence-service";
import { assertWritableOrganization, assertTenantWritesEnabled } from "@/modules/workspace/write-policy";
import { documentPage } from "./content";
import { validateInboxDocumentBytes } from "./file-types";
import { loadInboxItem } from "./inbox-store";
import { StorageError } from "./provider";

const filedEvidenceIdentity = z.object({
  itemId: z.uuid(),
  assetId: z.uuid(),
  sourceDocumentId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const readFiledStatementSchema = filedEvidenceIdentity.extend({
  page: z.number().int().min(1).max(100).default(1),
});

export const importFiledStatementSchema = filedEvidenceIdentity.extend({
  extraction: bankStatementExtractionSchema,
  mapping: bankStatementMappingSchema,
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  reason: z.string().trim().min(10).max(500),
});

async function assertFiledStatementSource(
  context: TenantTransactionContext,
  identity: z.infer<typeof filedEvidenceIdentity>,
) {
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: PERMISSIONS.readBanking,
    });
    const { row, connection } = await loadInboxItem(client, context, identity.itemId, "read");
    if (row.status !== "FILED" || row.asset_id !== identity.assetId
      || row.source_document_id !== identity.sourceDocumentId || row.sha256 !== identity.sha256) {
      throw new StorageError("STORAGE_FILED_EVIDENCE_MISMATCH", "Choose the exact filed item, linked evidence asset, source version, and checksum.");
    }
    const source = await client.query<{ legal_entity_id: string }>(
      `SELECT legal_entity_id FROM source_documents
       WHERE organization_id=$1 AND id=$2 AND owner_module=$3`,
      [context.organizationId, identity.sourceDocumentId, connection.owner_module],
    );
    if (source.rows[0]?.legal_entity_id !== connection.legal_entity_id) {
      throw new StorageError("STORAGE_ENTITY_MISMATCH", "The filed evidence and source document must belong to the same company.");
    }
    return { legalEntityId: connection.legal_entity_id };
  });
}

function assertStatementFile(filename: string, mimeType: string, bytes: Buffer) {
  const file = validateInboxDocumentBytes(filename, mimeType, bytes);
  if (!["CSV", "TSV", "TEXT", "XLS", "XLSX"].includes(file.format)) {
    throw new StorageError("STORAGE_STATEMENT_FORMAT", "The filed evidence must be a CSV, TSV, TXT, XLS, or XLSX bank export.");
  }
  return file;
}

export async function readFiledStatement(
  context: TenantTransactionContext,
  input: z.input<typeof readFiledStatementSchema>,
) {
  const command = readFiledStatementSchema.parse(input);
  await assertFiledStatementSource(context, command);
  const result = await downloadDocumentEvidence({
    context, assetId: command.assetId, sourceDocumentId: command.sourceDocumentId,
  });
  try {
    if (result.metadata.sha256 !== command.sha256) {
      throw new StorageError("STORAGE_CONTENT_CHANGED", "The filed evidence checksum changed.");
    }
    const file = assertStatementFile(result.metadata.filename, result.metadata.mimeType, result.bytes);
    const page = await documentPage(result.bytes, result.metadata.mimeType, command.page, file.format);
    await assertFiledStatementSource(context, command);
    return {
      itemId: command.itemId, assetId: command.assetId, sourceDocumentId: command.sourceDocumentId,
      sha256: command.sha256, page: command.page, ...page,
      instruction: "Read every row page, preserve the original transaction signs and currency, then review an exact statement preview before importing this filed evidence.",
    };
  } finally {
    result.bytes.fill(0);
  }
}

export async function importFiledStatement(
  context: TenantTransactionContext,
  input: z.input<typeof importFiledStatementSchema>,
) {
  const command = importFiledStatementSchema.parse(input);
  const operationContext = { ...context, reason: command.reason };
  assertTenantWritesEnabled(operationContext);
  await assertFiledStatementSource(operationContext, command);
  const result = await downloadDocumentEvidence({
    context: operationContext, assetId: command.assetId, sourceDocumentId: command.sourceDocumentId,
  });
  try {
    if (result.metadata.sha256 !== command.sha256) {
      throw new StorageError("STORAGE_CONTENT_CHANGED", "The filed evidence checksum changed.");
    }
    assertStatementFile(result.metadata.filename, result.metadata.mimeType, result.bytes);
    return await withTenantTransaction(operationContext, async (client) => {
      await assertWritableOrganization(client, operationContext);
      const { row, connection } = await loadInboxItem(client, operationContext, command.itemId, "read");
      if (row.status !== "FILED" || row.asset_id !== command.assetId
        || row.source_document_id !== command.sourceDocumentId || row.sha256 !== command.sha256) {
        throw new StorageError("STORAGE_FILED_EVIDENCE_MISMATCH", "The filed evidence changed before import. Read it again.");
      }
      const evidence = await reauthorizeDocumentEvidenceLinkInTransaction(
        client, operationContext, command.assetId, command.sourceDocumentId,
      );
      if (evidence.sha256 !== command.sha256 || evidence.storage_connection_id !== connection.id) {
        throw new StorageError("STORAGE_FILED_EVIDENCE_MISMATCH", "The linked evidence does not match the filed source.");
      }
      return importBankStatementInTransaction(client, {
        context: operationContext,
        inboxItemId: command.itemId,
        evidenceAssetId: command.assetId,
        sourceSha256: command.sha256,
        extraction: command.extraction,
        mapping: command.mapping,
        previewHash: command.previewHash,
        expectedLegalEntityId: connection.legal_entity_id,
      });
    });
  } catch (error) {
    throw normalizeStatementImportDatabaseError(error);
  } finally {
    result.bytes.fill(0);
  }
}
