import { z } from "zod";
import { bankStatementExtractionSchema, bankStatementMappingSchema } from "@/modules/banking/statement-import-model";
import { createBusinessDocumentSchema } from "@/modules/subledger/document-model";
import { uploadEvidenceSchema } from "@/modules/subledger/evidence-model";
import { inboxUploadMimeTypeSchema } from "./file-types";

export const providerSchema = z.enum(["GOOGLE_DRIVE", "ONEDRIVE"]);
export type StorageProvider = z.infer<typeof providerSchema>;
export const moduleSchema = z.enum(["payables", "receivables"]);
export const inboxStatusSchema = z.enum(["PENDING", "CLAIMED", "NEEDS_REVIEW", "READY_TO_FILE", "FILED", "FILING_FAILED"]);
export const connectStorageSchema = z.object({
  provider: providerSchema, legalEntityId: z.uuid(), module: moduleSchema,
  label: z.string().trim().min(1).max(100), connectionId: z.uuid().optional(),
  sharedWithOrganization: z.literal(true),
  accessAcknowledged: z.literal(true),
}).strict();
export const syncInboxSchema = z.object({ connectionId: z.uuid(), restart: z.boolean().default(false) }).strict();
export const uploadInboxSchema = uploadEvidenceSchema.omit({ module: true, mimeType: true }).extend({
  connectionId: z.uuid(),
  mimeType: inboxUploadMimeTypeSchema,
}).strict();
export const listInboxSchema = z.object({
  connectionId: z.uuid().optional(), status: inboxStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).default(30), before: z.uuid().optional(),
}).strict();
export const claimInboxSchema = z.object({ itemId: z.uuid(), claimId: z.uuid() }).strict();
export const readInboxSchema = claimInboxSchema.extend({ page: z.number().int().min(1).max(100).default(1) });
export const filingMetadataSchema = z.object({
  documentType: z.enum(["PURCHASE_INVOICE", "SALES_INVOICE", "RECEIPT", "STATEMENT", "CREDIT_NOTE", "OTHER"]),
  documentDate: z.iso.date(), counterparty: z.string().trim().min(1).max(160),
  reference: z.string().trim().min(1).max(100).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  total: z.string().regex(/^-?\d{1,14}(?:\.\d{1,6})?$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.total && !value.currency) {
    context.addIssue({ code: "custom", message: "Currency is required when a total is provided", path: ["currency"] });
  }
  if (value.documentType !== "STATEMENT" && Boolean(value.currency) !== Boolean(value.total)) {
    context.addIssue({ code: "custom", message: "Currency and total must be provided together", path: ["currency"] });
  }
});
export const completeInboxSchema = claimInboxSchema.extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/), metadata: filingMetadataSchema,
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("CREATE_DRAFT"), draft: createBusinessDocumentSchema.omit({ idempotencyKey: true }) }).strict(),
    z.object({ type: z.literal("LINK_DRAFT"), kind: z.enum(["SALES_INVOICE", "SUPPLIER_BILL"]),
      sourceNumber: z.string().trim().min(1).max(50), expectedVersion: z.number().int().positive(),
      purpose: z.enum(["INVOICE", "RECEIPT", "SUPPORTING"]) }).strict(),
    z.object({
      type: z.literal("IMPORT_STATEMENT"),
      extraction: bankStatementExtractionSchema,
      mapping: bankStatementMappingSchema,
      previewHash: z.string().regex(/^[a-f0-9]{64}$/),
      confirmed: z.literal(true),
    }).strict(),
    z.object({ type: z.literal("ARCHIVE_ONLY") }).strict(),
  ]), reason: z.string().trim().min(5).max(500),
}).strict();
export const reviewInboxSchema = claimInboxSchema.extend({ reason: z.string().trim().min(5).max(500) });
export const retryFilingSchema = z.object({ itemId: z.uuid() }).strict();
export type FilingMetadata = z.infer<typeof filingMetadataSchema>;
const folders: Record<FilingMetadata["documentType"], string> = {
  PURCHASE_INVOICE: "Purchase Invoices", SALES_INVOICE: "Sales Invoices", RECEIPT: "Receipts",
  STATEMENT: "Statements", CREDIT_NOTE: "Credit Notes", OTHER: "Other",
};
export function safeFilenamePart(value: string, length: number): string {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, length).replace(/[.-]+$/g, "") || "Document";
}
export function archiveName(metadata: FilingMetadata, itemId: string, mimeType: string) {
  const parsed = filingMetadataSchema.parse(metadata);
  const extension = {
    "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg",
    "text/csv": "csv", "text/tab-separated-values": "tsv", "text/plain": "txt",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  }[mimeType];
  if (!extension) throw new Error("Unsupported document format");
  const parts = [parsed.documentDate, safeFilenamePart(parsed.counterparty, 45)];
  if (parsed.reference) parts.push(safeFilenamePart(parsed.reference, 35));
  if (parsed.currency) parts.push(parsed.total ? `${parsed.currency}-${parsed.total}` : parsed.currency);
  parts.push(`FLQ-${z.uuid().parse(itemId)}`);
  return { name: `${parts.join("__")}.${extension}`, folders: [parsed.documentDate.slice(0, 4), parsed.documentDate.slice(5, 7), folders[parsed.documentType]] };
}
