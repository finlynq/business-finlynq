import { exact } from "@/kernel/money";
import {
  emailBookingActionSchema,
  emailBookingConditionSchema,
  extractedInvoiceFactsSchema,
  normalizeEmailAddress,
} from "./model";

export type BookingRule = Readonly<{
  id: string;
  version: number;
  name: string;
  priority: number;
  mode: "REVIEW_ONLY" | "CREATE_DRAFT" | "AUTO_POST";
  conditions: unknown;
  action: unknown;
}>;

export type BookingDecision = Readonly<{
  outcome: "REVIEW" | "CREATE_DRAFT" | "AUTO_POST";
  reason: string;
  ruleId?: string;
  ruleVersion?: number;
  action?: ReturnType<typeof emailBookingActionSchema.parse>;
}>;

function completeForAutomation(facts: ReturnType<typeof extractedInvoiceFactsSchema.parse>): string | null {
  if (facts.documentType !== "INVOICE") return "Only supplier invoices are eligible for automatic booking";
  if (!facts.supplierPartyAccountId) return "Supplier is unresolved";
  if (!facts.legalEntityId) return "Legal entity is unresolved";
  if (!facts.sourceNumber) return "Invoice reference is unresolved";
  if (!facts.documentDate || !facts.dueDate) return "Invoice dates are incomplete";
  if (!facts.currency || !facts.total || facts.taxTotal === undefined) return "Currency, tax, or total is incomplete";
  if (!facts.periodId) return "Accounting period is unresolved";
  if (facts.evidenceRelationship === "AMBIGUOUS") return "Evidence relationship is ambiguous";
  if (facts.duplicateStatus !== "CLEAR") return "Possible duplicate requires review";
  return null;
}

function conditionMatches(
  conditionValue: unknown,
  factsValue: ReturnType<typeof extractedInvoiceFactsSchema.parse>,
  sender: string,
  senderAuth: Readonly<{ dkim: string; spf: string; dmarc: string }>,
): boolean {
  const condition = emailBookingConditionSchema.parse(conditionValue);
  if (condition.sender && condition.sender !== sender) return false;
  if (condition.senderDomain && !sender.endsWith(`@${condition.senderDomain}`)) return false;
  if (condition.supplierPartyAccountId && condition.supplierPartyAccountId !== factsValue.supplierPartyAccountId) return false;
  if (condition.legalEntityId && condition.legalEntityId !== factsValue.legalEntityId) return false;
  if (condition.documentType && condition.documentType !== factsValue.documentType) return false;
  if (condition.currency && condition.currency !== factsValue.currency) return false;
  if (condition.amountCeiling && (!factsValue.total || exact(factsValue.total).abs().greaterThan(exact(condition.amountCeiling)))) return false;
  if (condition.requireDkimPass && senderAuth.dkim !== "PASS") return false;
  if (condition.requireSpfPass && senderAuth.spf !== "PASS") return false;
  if (condition.requireDmarcPass && senderAuth.dmarc !== "PASS") return false;
  return factsValue.confidence >= condition.minimumConfidence;
}

export function evaluateBookingPolicy(input: Readonly<{
  facts: unknown;
  sender: string;
  senderAuth?: Readonly<{ dkim?: string; spf?: string; dmarc?: string }>;
  rules: readonly BookingRule[];
  tenantAllowsAutoPost: boolean;
}>): BookingDecision {
  const facts = extractedInvoiceFactsSchema.parse(input.facts);
  const sender = normalizeEmailAddress(input.sender);
  const senderAuth = {
    dkim: input.senderAuth?.dkim ?? "UNKNOWN",
    spf: input.senderAuth?.spf ?? "UNKNOWN",
    dmarc: input.senderAuth?.dmarc ?? "UNKNOWN",
  };
  const incomplete = completeForAutomation(facts);
  if (incomplete) return { outcome: "REVIEW", reason: incomplete };
  const rule = [...input.rules]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .find((candidate) => conditionMatches(candidate.conditions, facts, sender, senderAuth));
  if (!rule) return { outcome: "REVIEW", reason: "No trusted booking rule matched" };
  const action = emailBookingActionSchema.parse(rule.action);
  if (rule.mode === "REVIEW_ONLY") {
    return { outcome: "REVIEW", reason: "Matching rule requires review", ruleId: rule.id, ruleVersion: rule.version };
  }
  if (rule.mode === "AUTO_POST" && !input.tenantAllowsAutoPost) {
    return { outcome: "CREATE_DRAFT", reason: "Tenant posting policy requires review", ruleId: rule.id, ruleVersion: rule.version, action };
  }
  return {
    outcome: rule.mode,
    reason: rule.mode === "AUTO_POST" ? "Trusted rule and tenant posting policy allow posting" : "Trusted rule allows draft creation",
    ruleId: rule.id,
    ruleVersion: rule.version,
    action,
  };
}

export type AttachmentCandidate = Readonly<{ id: string; filename: string; mimeType: string }>;
export function groupAccountingAttachments(attachments: readonly AttachmentCandidate[]) {
  const classified = attachments.map((attachment) => {
    const value = attachment.filename.normalize("NFKC").toLocaleLowerCase("en-US");
    const purpose = /(?:receipt|payment|proof|confirmation)/.test(value) ? "RECEIPT" as const : "INVOICE" as const;
    return { ...attachment, purpose };
  });
  const invoices = classified.filter((item) => item.purpose === "INVOICE");
  const receipts = classified.filter((item) => item.purpose === "RECEIPT");
  if (invoices.length === 1) return [{ primary: invoices[0], supporting: receipts }];
  return invoices.map((invoice) => ({ primary: invoice, supporting: [] as typeof receipts }));
}

export type AttachmentSafety = Readonly<{ allowed: true } | { allowed: false; code: string; reason: string }>;
export function attachmentSafety(input: Readonly<{
  filename: string;
  mimeType: string;
  bytes: Buffer;
  messageAttachmentCount: number;
  maximumBytes?: number;
}>): AttachmentSafety {
  if (input.messageAttachmentCount > 20) return { allowed: false, code: "TOO_MANY_ATTACHMENTS", reason: "The message contains too many attachments" };
  const maximum = input.maximumBytes ?? 2 * 1024 * 1024;
  if (input.bytes.length < 1 || input.bytes.length > maximum) return { allowed: false, code: "ATTACHMENT_SIZE", reason: "The attachment size is not supported" };
  if (input.mimeType !== "application/pdf") return { allowed: false, code: "ATTACHMENT_TYPE", reason: "Only PDF email attachments are currently supported" };
  if (!input.filename.toLocaleLowerCase("en-US").endsWith(".pdf") || !input.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    return { allowed: false, code: "ATTACHMENT_CORRUPT", reason: "The attachment does not contain a valid PDF header" };
  }
  if (input.bytes.includes(Buffer.from("/Encrypt"))) return { allowed: false, code: "ATTACHMENT_ENCRYPTED", reason: "Password-protected PDFs require review" };
  return { allowed: true };
}
