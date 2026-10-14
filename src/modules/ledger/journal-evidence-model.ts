import { z } from "zod";

const contentHash = z.string().regex(/^[a-f0-9]{64}$/);
const documentAmount = z.string().regex(/^-?\d{1,14}(?:\.\d{1,9})?$/);

export const postedJournalEvidenceTargetSchema = z.object({
  journalId: z.uuid(),
  expectedContentHash: contentHash,
  expectedEvidenceRevision: z.number().int().min(0),
}).strict();

export const postedJournalEvidenceMetadataSchema = z.object({
  documentDate: z.iso.date(),
  reference: z.string().trim().min(1).max(100),
  currency: z.string().regex(/^[A-Z]{3}$/),
  total: documentAmount,
}).strict();

export const postedJournalEvidenceLinkSchema = z.object({
  assetId: z.uuid(),
  inboxItemId: z.uuid().optional(),
  targets: z.array(postedJournalEvidenceTargetSchema).min(1).max(20)
    .refine((targets) => new Set(targets.map((target) => target.journalId)).size === targets.length,
      "Each posted journal may appear only once"),
  metadata: postedJournalEvidenceMetadataSchema,
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const listPostedJournalEvidenceSchema = z.object({ journalId: z.uuid() }).strict();
export const downloadPostedJournalEvidenceSchema = z.object({ journalId: z.uuid(), assetId: z.uuid() }).strict();

export type PostedJournalEvidenceLinkInput = z.infer<typeof postedJournalEvidenceLinkSchema>;
