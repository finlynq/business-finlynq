import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { renderInvoicePdf } from "@/modules/email/invoice-pdf";
import { attachmentSafety, evaluateBookingPolicy, groupAccountingAttachments } from "@/modules/email/policy";
import { ResendOutboundProvider } from "@/modules/email/provider";
import { verifySvixWebhook, WebhookSignatureError } from "@/modules/email/signature";
import type { InvoiceRenderFacts } from "@/modules/email/model";

const ids = {
  supplier: "10000000-0000-4000-8000-000000000001",
  entity: "10000000-0000-4000-8000-000000000002",
  period: "10000000-0000-4000-8000-000000000003",
};

const facts = {
  documentType: "INVOICE" as const,
  supplierPartyAccountId: ids.supplier,
  legalEntityId: ids.entity,
  sourceNumber: "BILL-100",
  documentDate: "2026-09-18",
  dueDate: "2026-10-18",
  currency: "CAD",
  total: "113.00",
  taxTotal: "13.00",
  periodId: ids.period,
  confidence: 0.99,
  duplicateStatus: "CLEAR" as const,
  evidenceRelationship: "INVOICE" as const,
};

const rule = {
  id: "10000000-0000-4000-8000-000000000004",
  version: 2,
  name: "Trusted supplier",
  priority: 10,
  mode: "AUTO_POST" as const,
  conditions: { senderDomain: "supplier.example", minimumConfidence: 0.95, requireDkimPass: true },
  action: { expenseAccountCombinationId: "10000000-0000-4000-8000-000000000005" },
};

function signature(rawBody: string, messageId: string, timestamp: number, secret: string) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const digest = createHmac("sha256", key).update(`${messageId}.${timestamp}.${rawBody}`).digest("base64");
  key.fill(0);
  return `v1,${digest}`;
}

describe("accounting email automation", () => {
  it("verifies the exact raw webhook body and rejects stale or modified requests", () => {
    const secret = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
    const rawBody = '{"type":"email.received","data":{"email_id":"mail-1"}}';
    const now = Date.parse("2026-09-19T00:00:00Z");
    const timestamp = Math.floor(now / 1000);
    const input = {
      rawBody,
      messageId: "msg_1",
      timestamp: String(timestamp),
      signature: signature(rawBody, "msg_1", timestamp, secret),
      secret,
      now,
    };
    expect(() => verifySvixWebhook(input)).not.toThrow();
    expect(() => verifySvixWebhook({ ...input, rawBody: `${rawBody} ` })).toThrow(WebhookSignatureError);
    expect(() => verifySvixWebhook({ ...input, now: now + 301_000 })).toThrow(WebhookSignatureError);
  });

  it("quarantines unsafe attachments and groups one invoice with related receipts", () => {
    const pdf = Buffer.from("%PDF-1.7\nsynthetic");
    expect(attachmentSafety({ filename: "invoice.pdf", mimeType: "application/pdf", bytes: pdf, messageAttachmentCount: 2 })).toEqual({ allowed: true });
    expect(attachmentSafety({ filename: "invoice.pdf", mimeType: "application/pdf", bytes: Buffer.from("not-pdf"), messageAttachmentCount: 1 })).toMatchObject({ allowed: false, code: "ATTACHMENT_CORRUPT" });
    expect(groupAccountingAttachments([
      { id: "invoice", filename: "invoice.pdf", mimeType: "application/pdf" },
      { id: "receipt", filename: "payment-receipt.pdf", mimeType: "application/pdf" },
    ])).toEqual([{ primary: expect.objectContaining({ id: "invoice" }), supporting: [expect.objectContaining({ id: "receipt" })] }]);
  });

  it("requires complete facts, a trusted rule, and tenant policy before auto-posting", () => {
    const senderAuth = { dkim: "PASS", spf: "PASS", dmarc: "PASS" };
    expect(evaluateBookingPolicy({ facts, sender: "billing@supplier.example", senderAuth, rules: [rule], tenantAllowsAutoPost: true })).toMatchObject({ outcome: "AUTO_POST", ruleVersion: 2 });
    expect(evaluateBookingPolicy({ facts, sender: "billing@supplier.example", senderAuth, rules: [rule], tenantAllowsAutoPost: false })).toMatchObject({ outcome: "CREATE_DRAFT" });
    expect(evaluateBookingPolicy({ facts: { ...facts, evidenceRelationship: "AMBIGUOUS" }, sender: "billing@supplier.example", senderAuth, rules: [rule], tenantAllowsAutoPost: true })).toMatchObject({ outcome: "REVIEW" });
    expect(evaluateBookingPolicy({ facts, sender: "billing@supplier.example", senderAuth: { ...senderAuth, dkim: "NOT_PASS" }, rules: [rule], tenantAllowsAutoPost: true })).toMatchObject({ outcome: "REVIEW" });
    expect(evaluateBookingPolicy({ facts, sender: "attacker@example.net", senderAuth, rules: [rule], tenantAllowsAutoPost: true })).toMatchObject({ outcome: "REVIEW" });
  });

  it("renders byte-identical multi-page PDFs with preview markers, totals, and page numbers", () => {
    const renderFacts: InvoiceRenderFacts = {
      organizationName: "FinLynQ Test", legalEntityName: "FinLynQ Canada Inc.",
      legalEntityAddress: ["1 Test Street", "Toronto, ON M5V 1A1", "CA"],
      taxRegistrations: ["GST/HST: 123456789RT0001"], customerName: "Example Customer",
      customerAddress: ["2 Customer Road"], invoiceNumber: "INV-100", invoiceDate: "2026-09-19",
      dueDate: "2026-10-19", currency: "CAD", preview: true,
      lines: Array.from({ length: 60 }, (_, index) => ({
        description: `Line ${index + 1}`, quantity: "1", unitPrice: "1.00",
        netAmount: "1.00", taxAmount: "0.13", grossAmount: "1.13",
      })),
      netTotal: "60.00", taxTotal: "7.80", grossTotal: "67.80",
      paymentInstructions: ["Pay by EFT to the selected immutable profile"],
    };
    const first = renderInvoicePdf(renderFacts);
    const second = renderInvoicePdf(renderFacts);
    expect(first.equals(second)).toBe(true);
    const text = first.toString("latin1");
    expect(text).toContain("PREVIEW - NOT ISSUED");
    expect(text).toContain("Amount due: CAD 67.80");
    expect(text).toContain("Page 1 of 2");
    expect(text).toContain("Page 2 of 2");
  });

  it("sends the exact PDF with a provider idempotency key", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: "provider-message-1" }));
    const provider = new ResendOutboundProvider("re_test", fetcher as typeof fetch);
    await expect(provider.send({
      from: "billing@mail.dev.example.com", to: ["customer@example.com"], cc: [],
      subject: "Invoice INV-100", text: "Attached", filename: "INV-100.pdf",
      pdf: Buffer.from("%PDF-1.7"), idempotencyKey: "invoice-delivery:stable",
    })).resolves.toEqual({ providerMessageId: "provider-message-1" });
    expect(fetcher).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ "Idempotency-Key": "invoice-delivery:stable" }),
    }));
  });
});
