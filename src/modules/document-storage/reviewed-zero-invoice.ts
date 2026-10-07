import "server-only";
import type { PoolClient } from "pg";
import type { z } from "zod";
import type { TenantTransactionContext } from "@/db/transaction";
import { exact } from "@/kernel/money";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { acquireDocumentIdentityLock } from "@/modules/subledger/ar-ap-idempotency";
import { DOCUMENT_KIND_POLICY } from "@/modules/subledger/document-model";
import type { completeInboxSchema } from "./model";
import { StorageError } from "./provider";

type Command = z.infer<typeof completeInboxSchema>;
export async function reviewZeroInvoice(client: PoolClient, context: TenantTransactionContext, entityId: string, command: Command) {
  if (command.action.type !== "REVIEWED_NO_ACCOUNTING") return null;
  if (command.metadata.documentType !== "PURCHASE_INVOICE" || !command.metadata.reference
    || !command.metadata.currency || command.metadata.total === undefined || !exact(command.metadata.total).isZero()
    || command.reason.trim().length < 8) {
    throw new StorageError("STORAGE_ZERO_INVOICE_REVIEW", "Reviewed no-new-accounting filing requires the original purchase invoice type, reference, date, currency, verified zero total, and a review reason of at least eight characters. Nonzero invoices must use their accounting workflow.");
  }
  const related = command.action.relatedEvidence;
  if (related?.type === "SOURCE_DOCUMENT") {
    const identity = (await client.query<{ source_number: string }>(
      "SELECT source_number FROM source_documents WHERE organization_id=$1 AND id=$2 AND legal_entity_id=$3 AND source_type=$4",
      [context.organizationId, related.sourceDocumentId, entityId, DOCUMENT_KIND_POLICY.SUPPLIER_BILL.sourceType],
    )).rows[0];
    if (identity) await acquireDocumentIdentityLock(client, context.organizationId, DOCUMENT_KIND_POLICY.SUPPLIER_BILL.sourceType, identity.source_number);
    const result = await client.query(
      `SELECT 1 FROM source_documents document
       WHERE document.organization_id=$1 AND document.id=$2 AND document.legal_entity_id=$3
         AND document.source_type=$4 AND document.version=$5 AND document.content_hash=$6
         AND document.status IN ('DRAFT','POSTED')
         AND NOT EXISTS (SELECT 1 FROM source_documents newer WHERE newer.organization_id=$1
           AND newer.source_type=document.source_type AND newer.source_number=document.source_number
           AND newer.version>document.version)`,
      [context.organizationId, related.sourceDocumentId, entityId, DOCUMENT_KIND_POLICY.SUPPLIER_BILL.sourceType, related.expectedVersion, related.expectedContentHash],
    );
    if (!result.rows[0]) throw new StorageError("STORAGE_RELATED_EVIDENCE_STALE", "Choose the exact current supplier purchase version in the same company. This is a supporting link, not a receipt or a second payable.");
  } else if (related?.type === "JOURNAL") {
    await assertActorHasActivePermission(client, { organizationId: context.organizationId, actorId: context.actorId, permission: PERMISSIONS.readMcpLedger });
    const result = await client.query("SELECT 1 FROM journal_entries WHERE organization_id=$1 AND id=$2 AND legal_entity_id=$3 AND status='POSTED' AND content_hash=$4", [context.organizationId, related.journalId, entityId, related.expectedContentHash]);
    if (!result.rows[0]) throw new StorageError("STORAGE_RELATED_EVIDENCE_STALE", "Choose the exact posted journal in the same company. Refresh its content hash before attaching supporting evidence.");
  }
  return {
    treatment: command.action.treatment, reason: command.reason,
    reviewedBy: context.actorId, reviewedAt: new Date().toISOString(),
    sourceSha256: command.sha256, relatedEvidence: related ?? null,
    accountingMutation: "NONE" as const,
  };
}
