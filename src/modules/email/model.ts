import { z } from "zod";
import { createBusinessDocumentSchema } from "@/modules/subledger/document-model";

export const emailAddressSchema = z.string().trim().min(3).max(320).transform((value, context) => {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  const at = normalized.lastIndexOf("@");
  if (at < 1 || at === normalized.length - 1 || normalized.includes("\r") || normalized.includes("\n")) {
    context.addIssue({ code: "custom", message: "A complete email address is required" });
    return z.NEVER;
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
      || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
    context.addIssue({ code: "custom", message: "A valid email address is required" });
    return z.NEVER;
  }
  return `${local}@${domain}`;
});

export function normalizeEmailAddress(value: string): string {
  return emailAddressSchema.parse(value);
}

export const aliasStatusSchema = z.enum(["ACTIVE", "DISABLED", "RETIRED"]);
export const emailPurposeSchema = z.enum(["PAYABLES", "RECEIVABLES", "GENERAL"]);
export const createEmailAliasSchema = z.object({
  label: z.string().trim().min(1).max(100),
  legalEntityId: z.uuid().optional(),
  connectionId: z.uuid().optional(),
  purpose: emailPurposeSchema.default("PAYABLES"),
  hourlyLimit: z.number().int().min(1).max(500).default(25),
  maxPayloadBytes: z.number().int().min(1024).max(25 * 1024 * 1024).default(10 * 1024 * 1024),
  idempotencyKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(5).max(500),
}).strict();
export const updateEmailAliasSchema = z.object({
  aliasId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  label: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  legalEntityId: z.uuid().nullable().optional(),
  connectionId: z.uuid().nullable().optional(),
  purpose: emailPurposeSchema.optional(),
  hourlyLimit: z.number().int().min(1).max(500).optional(),
  maxPayloadBytes: z.number().int().min(1024).max(25 * 1024 * 1024).optional(),
  reason: z.string().trim().min(5).max(500),
}).strict();
export const rotateEmailAliasSchema = z.object({
  aliasId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const provisionPersonalEmailAliasSchema = z.object({
  membershipId: z.uuid(),
  connectionId: z.uuid().optional(),
  reason: z.string().trim().min(5).max(500),
}).strict();
export const configurePersonalEmailAliasSchema = z.object({
  membershipId: z.uuid(),
  aliasId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  connectionId: z.uuid().nullable(),
  reason: z.string().trim().min(5).max(500),
}).strict();
export const rotatePersonalEmailAliasSchema = z.object({
  membershipId: z.uuid(),
  aliasId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const bookingModeSchema = z.enum(["REVIEW_ONLY", "CREATE_DRAFT", "AUTO_POST"]);
export const emailBookingConditionSchema = z.object({
  sender: emailAddressSchema.optional(),
  senderDomain: z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/).optional(),
  supplierPartyAccountId: z.uuid().optional(),
  legalEntityId: z.uuid().optional(),
  documentType: z.enum(["INVOICE", "CREDIT_NOTE"]).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  amountCeiling: z.string().regex(/^\d{1,14}(?:\.\d{1,6})?$/).optional(),
  minimumConfidence: z.number().min(0).max(1).default(0.95),
  requireDkimPass: z.boolean().default(false),
  requireSpfPass: z.boolean().default(false),
  requireDmarcPass: z.boolean().default(false),
}).strict();
export const emailBookingActionSchema = z.object({
  expenseAccountCombinationId: z.uuid(),
  taxCode: z.string().trim().min(1).max(50).optional(),
  apControlAccountId: z.uuid().optional(),
}).strict();
export const upsertEmailBookingRuleSchema = z.object({
  ruleId: z.uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(100),
  priority: z.number().int().min(1).max(10_000).default(100),
  active: z.boolean().default(true),
  mode: bookingModeSchema,
  conditions: emailBookingConditionSchema,
  action: emailBookingActionSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(5).max(500),
}).strict();

const paymentDetailFields = {
  beneficiaryName: z.string().trim().min(1).max(200),
  bankName: z.string().trim().max(200).optional(),
  bankAddress: z.string().trim().max(500).optional(),
  institutionNumber: z.string().trim().regex(/^\d{3}$/).optional(),
  transitNumber: z.string().trim().regex(/^\d{5}$/).optional(),
  accountNumber: z.string().trim().regex(/^[A-Z0-9 -]{3,34}$/i).optional(),
  routingNumber: z.string().trim().regex(/^\d{9}$/).optional(),
  swiftBic: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}(?:[A-Z0-9]{3})?$/).optional(),
  iban: z.string().trim().transform((value) => value.replace(/\s+/g, "").toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/)).optional(),
  remittanceEmail: emailAddressSchema.optional(),
  instructions: z.string().trim().max(1000).optional(),
  acceptedMethods: z.array(z.enum(["EFT", "ACH", "WIRE", "INTERAC", "CHEQUE", "CARD"])).min(1).max(6),
  paymentReferenceWording: z.string().trim().min(1).max(200),
};
export const paymentInstructionDetailsSchema = z.object(paymentDetailFields).strict();
export const savePaymentProfileSchema = z.object({
  profileId: z.uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
  legalEntityId: z.uuid(),
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  name: z.string().trim().min(1).max(100),
  isDefault: z.boolean().default(false),
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().nullable().optional(),
  details: paymentInstructionDetailsSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(5).max(500),
}).strict().refine((value) => !value.effectiveTo || value.effectiveTo >= value.effectiveFrom, {
  message: "Payment profile end date must not precede its start date",
  path: ["effectiveTo"],
});
export const retirePaymentProfileSchema = z.object({
  profileId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const customerDeliveryPreferenceSchema = z.object({
  partyAccountId: z.uuid(),
  expectedVersion: z.number().int().nonnegative().optional(),
  billingRecipients: z.array(emailAddressSchema).min(1).max(10),
  ccRecipients: z.array(emailAddressSchema).max(10).default([]),
  preferredLanguage: z.string().trim().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default("en"),
  templateKey: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/).default("invoice-default"),
  deliveryMethod: z.enum(["EMAIL", "MANUAL"]).default("EMAIL"),
  autoSendOnIssue: z.boolean().default(false),
  paymentProfileId: z.uuid().nullable().optional(),
  purchaseOrderRequired: z.boolean().default(false),
  remittanceContact: emailAddressSchema.optional(),
  reenableSuppressedRecipients: z.literal(true).optional(),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const emailDeliverySettingsSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  outboundEnabled: z.boolean(),
  autoSendEnabled: z.boolean(),
  transientRetentionDays: z.number().int().min(1).max(365),
  quarantineRetentionDays: z.number().int().min(1).max(365),
  operationRetentionDays: z.number().int().min(7).max(2555),
  reason: z.string().trim().min(5).max(500),
}).strict().refine((value) => value.outboundEnabled || !value.autoSendEnabled, {
  message: "Automatic delivery requires outbound delivery to be enabled",
  path: ["autoSendEnabled"],
});

export const inboundAttachmentSchema = z.object({
  id: z.string().trim().min(1).max(500),
  filename: z.string().trim().min(1).max(180),
  mimeType: z.string().trim().min(1).max(200),
  content: z.instanceof(Buffer).nullable(),
  declaredSize: z.number().int().min(1).max(25 * 1024 * 1024).optional(),
}).strict();
export const inboundProviderMessageSchema = z.object({
  provider: z.literal("SELF_SMTP"),
  eventId: z.string().trim().min(1).max(500),
  messageId: z.string().trim().min(1).max(500),
  from: emailAddressSchema,
  to: z.array(emailAddressSchema).min(1).max(100),
  cc: z.array(emailAddressSchema).max(100).default([]),
  subject: z.string().max(1000).default(""),
  text: z.string().max(1_000_000).optional(),
  html: z.string().max(2_000_000).optional(),
  receivedAt: z.iso.datetime({ offset: true }),
  senderAuth: z.record(z.string(), z.unknown()).default({}),
  attachments: z.array(inboundAttachmentSchema).max(50),
  attachmentOverflow: z.boolean().default(false),
}).strict();
export type InboundProviderMessage = z.infer<typeof inboundProviderMessageSchema>;

export const extractedInvoiceFactsSchema = z.object({
  documentType: z.enum(["INVOICE", "CREDIT_NOTE", "RECEIPT", "STATEMENT", "OTHER"]),
  supplierPartyAccountId: z.uuid().optional(),
  legalEntityId: z.uuid().optional(),
  sourceNumber: z.string().trim().min(1).max(100).optional(),
  documentDate: z.iso.date().optional(),
  dueDate: z.iso.date().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  total: z.string().regex(/^-?\d{1,14}(?:\.\d{1,6})?$/).optional(),
  taxTotal: z.string().regex(/^-?\d{1,14}(?:\.\d{1,6})?$/).optional(),
  periodId: z.uuid().optional(),
  confidence: z.number().min(0).max(1),
  duplicateStatus: z.enum(["CLEAR", "POSSIBLE", "CONFIRMED"]).default("CLEAR"),
  evidenceRelationship: z.enum(["INVOICE", "RECEIPT", "SUPPORTING", "AMBIGUOUS"]),
}).strict();

export const processEmailPayableSchema = z.object({
  inboxItemId: z.uuid(),
  claimId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  facts: extractedInvoiceFactsSchema,
  draft: createBusinessDocumentSchema.omit({ idempotencyKey: true, kind: true }).optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const invoiceRenderFactsSchema = z.object({
  organizationName: z.string().min(1).max(200),
  legalEntityName: z.string().min(1).max(200),
  legalEntityAddress: z.array(z.string().min(1).max(200)).max(6).default([]),
  taxRegistrations: z.array(z.string().min(1).max(200)).max(10).default([]),
  customerName: z.string().min(1).max(200),
  customerAddress: z.array(z.string().min(1).max(200)).max(6).default([]),
  invoiceNumber: z.string().min(1).max(100),
  invoiceDate: z.iso.date(),
  dueDate: z.iso.date().optional(),
  terms: z.string().max(500).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  purchaseOrder: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  remittanceContact: z.string().max(320).optional(),
  lines: z.array(z.object({
    description: z.string().min(1).max(1000),
    quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
    unitPrice: z.string().regex(/^-?\d+(?:\.\d{1,6})?$/),
    netAmount: z.string().regex(/^-?\d+(?:\.\d{1,6})?$/),
    taxAmount: z.string().regex(/^-?\d+(?:\.\d{1,6})?$/),
    grossAmount: z.string().regex(/^-?\d+(?:\.\d{1,6})?$/),
  }).strict()).min(1).max(500),
  netTotal: z.string(),
  taxTotal: z.string(),
  grossTotal: z.string(),
  paymentInstructions: z.array(z.string().min(1).max(500)).max(20).default([]),
  preview: z.boolean(),
}).strict();
export type InvoiceRenderFacts = z.infer<typeof invoiceRenderFactsSchema>;

export const generateInvoicePdfSchema = z.object({
  sourceDocumentId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  paymentInstructionProfileId: z.uuid().optional(),
  preview: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();
export const sendInvoiceSchema = z.object({
  sourceDocumentId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  pdfArtifactId: z.uuid(),
  recipients: z.array(emailAddressSchema).min(1).max(10),
  ccRecipients: z.array(emailAddressSchema).max(10).default([]),
  subject: z.string().trim().min(1).max(300),
  message: z.string().trim().min(1).max(5000),
  idempotencyKey: z.string().trim().min(1).max(200),
  manualResend: z.boolean().default(false),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const retryEmailOperationSchema = z.object({
  kind: z.enum(["INBOUND_MESSAGE", "ATTACHMENT", "DELIVERY"]),
  id: z.uuid(),
  reason: z.string().trim().min(5).max(500),
}).strict();
export const clearEmailQuarantineSchema = z.object({
  attachmentId: z.uuid(),
  confirmedSafeAfterReview: z.literal(true),
  reason: z.string().trim().min(10).max(500),
}).strict();
