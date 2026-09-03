import { z } from "zod";

export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
export const evidenceReferenceSchema = z.object({
  assetId: z.uuid(),
  purpose: z.enum(["INVOICE", "RECEIPT", "SUPPORTING"]),
}).strict();
export const evidenceReferencesSchema = z.array(evidenceReferenceSchema).max(20)
  .refine((refs) => new Set(refs.map((ref) => ref.assetId)).size === refs.length,
    "An evidence asset can only be linked once per version");
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export const uploadEvidenceSchema = z.object({
  module: z.enum(["receivables", "payables"]),
  filename: z.string().trim().min(1).max(180)
    .refine((value) => !/[\\/\x00-\x1f\x7f]/.test(value) && value !== "." && value !== "..", "Invalid filename"),
  mimeType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  byteSize: z.number().int().positive().max(MAX_EVIDENCE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBase64: z.string().min(4).max(4 * Math.ceil(MAX_EVIDENCE_BYTES / 3))
    .regex(/^[A-Za-z0-9+/]*={0,2}$/).refine((value) => value.length % 4 === 0, "Invalid base64 length"),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();
const linkFields = {
  kind: z.enum(["SALES_INVOICE", "SUPPLIER_BILL"]),
  sourceNumber: z.string().trim().toUpperCase().min(1).max(50).regex(/^[A-Z0-9][A-Z0-9._/-]*$/),
  expectedVersion: z.number().int().positive(),
  assetId: z.uuid(),
  idempotencyKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(5).max(500),
};
export const attachEvidenceSchema = z.object({
  ...linkFields, purpose: evidenceReferenceSchema.shape.purpose,
}).strict();
export const detachEvidenceSchema = z.object(linkFields).strict();
export type EvidenceMetadata = Readonly<{
  assetId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  uploadedBy: string;
  uploadedAt: string;
  scannerVersion: string;
  scannedAt: string;
}>;
export type DocumentEvidenceMetadata = EvidenceMetadata & EvidenceReference & Readonly<{
  sourceDocumentId: string;
  sourceNumber: string;
  sourceVersion: number;
  downloadUrl: string;
}>;
