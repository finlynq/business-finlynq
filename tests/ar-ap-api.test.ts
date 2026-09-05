import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const previousBusinessWrites = process.env.BUSINESS_WRITES_ENABLED;
const previousDemoWrites = process.env.DEMO_WRITES_ENABLED;

const mocks = vi.hoisted(() => {
  const principal: SessionPrincipal = {
    sessionId: "20000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    organizationId: "20000000-0000-4000-8000-000000000003",
    membershipId: "20000000-0000-4000-8000-000000000004",
    organizationName: "Tenant",
    roleLabel: "Owner",
    displayName: "Owner",
    initials: "OW",
    sessionMode: "real",
    authMethod: "PASSWORD",
    organizationWritesEnabled: true,
    expiresAt: new Date("2026-08-27T20:00:00Z"),
    mfaVerifiedAt: null,
    stepUpExpiresAt: null,
  };
  const document = {
    id: "30000000-0000-4000-8000-000000000001",
    sourceNumber: "DOC-1001",
    status: "DRAFT",
    version: 1,
  };
  return {
    principal,
    sameOrigin: vi.fn(() => true),
    requestPrincipal: vi.fn(async (): Promise<SessionPrincipal | null> => principal),
    transactionAuthMethod: vi.fn((subject: SessionPrincipal) =>
      subject.sessionMode === "demo" ? "demo-link" : "password"),
    consumeLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    createDraft: vi.fn(async () => ({ document, idempotentReplay: false })),
    editDraft: vi.fn(async (_command: unknown) => ({ document: { ...document, version: 2 }, idempotentReplay: false })),
    issueDocument: vi.fn(async () => ({
      document: { ...document, status: "POSTED", version: 2 },
      idempotentReplay: false,
      journalId: "30000000-0000-4000-8000-000000000002",
      journalNumber: 1001,
      subledgerEventId: "30000000-0000-4000-8000-000000000003",
      openItemId: "30000000-0000-4000-8000-000000000004",
    })),
    recordSettlement: vi.fn(async () => ({
      document: { ...document, status: "POSTED" },
      idempotentReplay: false,
      journalId: "30000000-0000-4000-8000-000000000005",
      journalNumber: 1002,
      subledgerEventId: "30000000-0000-4000-8000-000000000006",
      allocationIds: ["30000000-0000-4000-8000-000000000007"],
    })),
    voidDocument: vi.fn(async () => ({
      document: { ...document, status: "VOIDED", version: 3 },
      idempotentReplay: false,
      journalId: "30000000-0000-4000-8000-000000000008",
      journalNumber: 1003,
      openItemVoidEventId: "30000000-0000-4000-8000-000000000009",
    })),
    voidSettlement: vi.fn(async () => ({
      document: { ...document, status: "VOIDED", version: 2 },
      idempotentReplay: false,
      journalId: "30000000-0000-4000-8000-000000000010",
      journalNumber: 1004,
      reversedAllocationIds: ["30000000-0000-4000-8000-000000000011"],
    })),
  };
});

vi.mock("@/modules/identity/request-security", () => ({
  validateSameOriginMutation: mocks.sameOrigin,
}));
vi.mock("@/modules/identity/session", () => ({
  requestPrincipal: mocks.requestPrincipal,
  transactionAuthMethod: mocks.transactionAuthMethod,
}));
vi.mock("@/modules/ledger/mutation-rate-limit", () => ({
  consumeLedgerMutationRateLimit: mocks.consumeLimit,
}));
vi.mock("@/modules/subledger/ar-ap-service", () => ({
  createBusinessDocumentDraft: mocks.createDraft,
  editBusinessDocumentDraft: mocks.editDraft,
  issueBusinessDocument: mocks.issueDocument,
  recordCustomerReceiptOrSupplierPayment: mocks.recordSettlement,
  voidIssuedBusinessDocument: mocks.voidDocument,
  voidSettlementAndReverseAllocations: mocks.voidSettlement,
}));

import {
  PATCH as editInvoiceDraft,
  POST as createInvoiceDraft,
} from "@/app/api/receivables/invoices/route";
import { POST as issueInvoice } from "@/app/api/receivables/invoices/issue/route";
import { POST as voidInvoice } from "@/app/api/receivables/invoices/void/route";
import { POST as recordReceipt } from "@/app/api/receivables/receipts/route";
import { POST as voidReceipt } from "@/app/api/receivables/receipts/void/route";
import {
  PATCH as editBillDraft,
  POST as createBillDraft,
} from "@/app/api/payables/bills/route";
import { POST as issueBill } from "@/app/api/payables/bills/issue/route";
import { POST as voidBill } from "@/app/api/payables/bills/void/route";
import { POST as recordPayment } from "@/app/api/payables/payments/route";
import { POST as voidPayment } from "@/app/api/payables/payments/void/route";

const ids = {
  ledgerId: "40000000-0000-4000-8000-000000000001",
  legalEntityId: "40000000-0000-4000-8000-000000000002",
  partyAccountId: "40000000-0000-4000-8000-000000000003",
  controlAccountCombinationId: "40000000-0000-4000-8000-000000000004",
  taxAccountCombinationId: "40000000-0000-4000-8000-000000000005",
  lineAccountCombinationId: "40000000-0000-4000-8000-000000000006",
  periodId: "40000000-0000-4000-8000-000000000007",
  bankAccountCombinationId: "40000000-0000-4000-8000-000000000008",
  realizedFxGainAccountCombinationId: "40000000-0000-4000-8000-000000000009",
  realizedFxLossAccountCombinationId: "40000000-0000-4000-8000-000000000010",
  openItemId: "40000000-0000-4000-8000-000000000011",
};

const invoiceBody = {
  kind: "SALES_INVOICE" as const,
  sourceNumber: "INV-1001",
  ledgerId: ids.ledgerId,
  legalEntityId: ids.legalEntityId,
  partyAccountId: ids.partyAccountId,
  controlAccountCombinationId: ids.controlAccountCombinationId,
  taxAccountCombinationId: ids.taxAccountCombinationId,
  documentDate: "2026-08-27",
  accountingDate: "2026-08-27",
  periodId: ids.periodId,
  dueOn: "2026-09-26",
  currency: "CAD",
  fx: {
    rate: "1",
    source: "functional-currency",
    effectiveAt: "2026-08-27T12:00:00.000Z",
    quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" as const,
  },
  description: "Implementation services",
  lines: [{
    description: "Configuration",
    accountCombinationId: ids.lineAccountCombinationId,
    netAmount: "100.00",
    tax: {
      packKey: "ca.on.hst",
      category: "STANDARD" as const,
      destinationCountry: "CA" as const,
      destinationRegion: "ON",
    },
  }],
  idempotencyKey: "invoice-create-1",
};

const billBody = {
  ...invoiceBody,
  kind: "SUPPLIER_BILL" as const,
  sourceNumber: "BILL-1001",
  description: "Supplier services",
  idempotencyKey: "bill-create-1",
};

const receiptBody = {
  kind: "CUSTOMER_RECEIPT" as const,
  sourceNumber: "RCPT-1001",
  ledgerId: ids.ledgerId,
  legalEntityId: ids.legalEntityId,
  partyAccountId: ids.partyAccountId,
  controlAccountCombinationId: ids.controlAccountCombinationId,
  periodId: ids.periodId,
  accountingDate: "2026-08-27",
  settlementDate: "2026-08-27",
  currency: "CAD",
  amount: "113.00",
  fx: invoiceBody.fx,
  bankAccountCombinationId: ids.bankAccountCombinationId,
  realizedFxGainAccountCombinationId: ids.realizedFxGainAccountCombinationId,
  realizedFxLossAccountCombinationId: ids.realizedFxLossAccountCombinationId,
  description: "Customer receipt",
  allocations: [{ openItemId: ids.openItemId, transactionAmount: "113.00" }],
  idempotencyKey: "receipt-create-1",
};

const paymentBody = {
  ...receiptBody,
  kind: "SUPPLIER_PAYMENT" as const,
  sourceNumber: "PAY-1001",
  description: "Supplier payment",
  idempotencyKey: "payment-create-1",
};

function request(path: string, method: "POST" | "PATCH", body: unknown, headers: HeadersInit = {}) {
  return new NextRequest(`https://business.finlynq.com${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BUSINESS_WRITES_ENABLED = "true";
  process.env.DEMO_WRITES_ENABLED = "false";
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requestPrincipal.mockResolvedValue(mocks.principal);
  mocks.consumeLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

afterAll(() => {
  if (previousBusinessWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousBusinessWrites;
  if (previousDemoWrites === undefined) delete process.env.DEMO_WRITES_ENABLED;
  else process.env.DEMO_WRITES_ENABLED = previousDemoWrites;
});

describe("AR/AP mutation routes", () => {
  it("maps every invoice and bill lifecycle command to the source-owned service", async () => {
    const responses = await Promise.all([
      createInvoiceDraft(request("/api/receivables/invoices", "POST", invoiceBody)),
      editInvoiceDraft(request("/api/receivables/invoices", "PATCH", {
        ...invoiceBody,
        expectedVersion: 1,
        idempotencyKey: "invoice-edit-1",
      })),
      issueInvoice(request("/api/receivables/invoices/issue", "POST", {
        kind: "SALES_INVOICE",
        sourceNumber: invoiceBody.sourceNumber,
        expectedVersion: 2,
        idempotencyKey: "invoice-issue-1",
      })),
      voidInvoice(request("/api/receivables/invoices/void", "POST", {
        kind: "SALES_INVOICE",
        sourceNumber: invoiceBody.sourceNumber,
        expectedVersion: 3,
        periodId: ids.periodId,
        accountingDate: "2026-08-27",
        reason: "Customer order was cancelled after posting.",
        description: "Void customer invoice",
        idempotencyKey: "invoice-void-1",
      })),
      createBillDraft(request("/api/payables/bills", "POST", billBody)),
      editBillDraft(request("/api/payables/bills", "PATCH", {
        ...billBody,
        expectedVersion: 1,
        idempotencyKey: "bill-edit-1",
      })),
      issueBill(request("/api/payables/bills/issue", "POST", {
        kind: "SUPPLIER_BILL",
        sourceNumber: billBody.sourceNumber,
        expectedVersion: 2,
        idempotencyKey: "bill-issue-1",
      })),
      voidBill(request("/api/payables/bills/void", "POST", {
        kind: "SUPPLIER_BILL",
        sourceNumber: billBody.sourceNumber,
        expectedVersion: 3,
        periodId: ids.periodId,
        accountingDate: "2026-08-27",
        reason: "Supplier bill was posted in error.",
        description: "Void supplier bill",
        idempotencyKey: "bill-void-1",
      })),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 200, 201, 201, 201, 200, 201, 201]);
    expect(mocks.createDraft).toHaveBeenCalledTimes(2);
    expect(mocks.editDraft).toHaveBeenCalledTimes(2);
    expect(mocks.issueDocument).toHaveBeenCalledTimes(2);
    expect(mocks.voidDocument).toHaveBeenCalledTimes(2);
    expect(mocks.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      kind: "SALES_INVOICE",
      context: expect.objectContaining({
        organizationId: mocks.principal.organizationId,
        actorId: mocks.principal.userId,
        sessionId: mocks.principal.sessionId,
        sourceSurface: "API",
      }),
    }));
    expect(mocks.voidDocument).toHaveBeenCalledWith(expect.objectContaining({
      kind: "SALES_INVOICE",
      context: expect.objectContaining({ reason: "Customer order was cancelled after posting." }),
    }));
  });

  it("requires edit FX mode and evidence combinations to be explicit", async () => {
    const { fx: _fx, ...invoiceWithoutFx } = invoiceBody;
    void _fx;
    const preserve = await editInvoiceDraft(request("/api/receivables/invoices", "PATCH", {
      ...invoiceWithoutFx,
      expectedVersion: 1,
      fxResolutionMode: "PRESERVE",
      idempotencyKey: "invoice-preserve-fx",
    }));
    expect(preserve.status).toBe(200);
    expect(mocks.editDraft).toHaveBeenCalledWith(expect.objectContaining({
      fxResolutionMode: "PRESERVE",
      expectedVersion: 1,
    }));
    expect(mocks.editDraft.mock.calls.at(-1)?.[0]).not.toHaveProperty("fx");

    mocks.editDraft.mockClear();
    const preserveWithEvidence = await editInvoiceDraft(request(
      "/api/receivables/invoices",
      "PATCH",
      {
        ...invoiceBody,
        expectedVersion: 1,
        fxResolutionMode: "PRESERVE",
        idempotencyKey: "invalid-preserve-with-fx",
      },
    ));
    const explicitWithoutEvidence = await editInvoiceDraft(request(
      "/api/receivables/invoices",
      "PATCH",
      {
        ...invoiceWithoutFx,
        expectedVersion: 1,
        fxResolutionMode: "EXPLICIT",
        idempotencyKey: "invalid-explicit-without-fx",
      },
    ));
    expect([preserveWithEvidence.status, explicitWithoutEvidence.status]).toEqual([400, 400]);
    expect(mocks.editDraft).not.toHaveBeenCalled();
  });

  it("maps receipts, payments, allocations, and their exact reversal commands", async () => {
    const responses = await Promise.all([
      recordReceipt(request("/api/receivables/receipts", "POST", receiptBody)),
      voidReceipt(request("/api/receivables/receipts/void", "POST", {
        kind: "CUSTOMER_RECEIPT",
        sourceNumber: receiptBody.sourceNumber,
        expectedVersion: 1,
        periodId: ids.periodId,
        accountingDate: "2026-08-27",
        reason: "Receipt was deposited against the wrong customer.",
        description: "Void customer receipt",
        idempotencyKey: "receipt-void-1",
      })),
      recordPayment(request("/api/payables/payments", "POST", paymentBody)),
      voidPayment(request("/api/payables/payments/void", "POST", {
        kind: "SUPPLIER_PAYMENT",
        sourceNumber: paymentBody.sourceNumber,
        expectedVersion: 1,
        periodId: ids.periodId,
        accountingDate: "2026-08-27",
        reason: "Payment was assigned to the wrong supplier.",
        description: "Void supplier payment",
        idempotencyKey: "payment-void-1",
      })),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201]);
    expect(mocks.recordSettlement).toHaveBeenCalledTimes(2);
    expect(mocks.voidSettlement).toHaveBeenCalledTimes(2);
    expect(mocks.recordSettlement).toHaveBeenCalledWith(expect.objectContaining({
      kind: "CUSTOMER_RECEIPT",
      allocations: [{ openItemId: ids.openItemId, transactionAmount: "113.00" }],
    }));
    expect(mocks.voidSettlement).toHaveBeenCalledWith(expect.objectContaining({
      kind: "SUPPLIER_PAYMENT",
      context: expect.objectContaining({ reason: "Payment was assigned to the wrong supplier." }),
    }));
  });

  it("allows only the explicitly enabled session mode and marks demo commands", async () => {
    const demoPrincipal: SessionPrincipal = {
      ...mocks.principal,
      sessionMode: "demo",
      authMethod: "DEMO_LINK",
    };
    mocks.requestPrincipal.mockResolvedValue(demoPrincipal);

    const disabledDemo = await createInvoiceDraft(
      request("/api/receivables/invoices", "POST", invoiceBody),
    );
    expect(disabledDemo.status).toBe(403);
    expect(mocks.createDraft).not.toHaveBeenCalled();

    process.env.DEMO_WRITES_ENABLED = "true";
    const enabledDemo = await createInvoiceDraft(
      request("/api/receivables/invoices", "POST", invoiceBody),
    );
    expect(enabledDemo.status).toBe(201);
    expect(mocks.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        authMethod: "demo-link",
        demoWriteAuthorized: true,
      }),
    }));

    vi.clearAllMocks();
    mocks.sameOrigin.mockReturnValue(true);
    mocks.consumeLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.requestPrincipal.mockResolvedValue(mocks.principal);
    process.env.BUSINESS_WRITES_ENABLED = "false";
    const disabledReal = await createInvoiceDraft(
      request("/api/receivables/invoices", "POST", invoiceBody),
    );
    expect(disabledReal.status).toBe(403);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("rejects cross-site, malformed, oversized, unknown-field, and wrong-module bodies", async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    const crossSite = await createInvoiceDraft(
      request("/api/receivables/invoices", "POST", invoiceBody, { Origin: "https://attacker.example" }),
    );
    expect(crossSite.status).toBe(403);
    expect(mocks.requestPrincipal).not.toHaveBeenCalled();

    const malformed = await createInvoiceDraft(
      request("/api/receivables/invoices", "POST", "{"),
    );
    expect(malformed.status).toBe(400);

    const oversized = await createInvoiceDraft(
      request("/api/receivables/invoices", "POST", {}, { "Content-Length": "256001" }),
    );
    expect(oversized.status).toBe(413);

    const injectedTenant = await createInvoiceDraft(
      request("/api/receivables/invoices", "POST", {
        ...invoiceBody,
        organizationId: "50000000-0000-4000-8000-000000000001",
      }),
    );
    expect(injectedTenant.status).toBe(400);

    const wrongModule = await createInvoiceDraft(
      request("/api/receivables/invoices", "POST", billBody),
    );
    expect(wrongModule.status).toBe(400);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("enforces the durable limit and never returns domain error details", async () => {
    mocks.consumeLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 37 });
    const limited = await recordReceipt(
      request("/api/receivables/receipts", "POST", receiptBody),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("37");
    expect(mocks.recordSettlement).not.toHaveBeenCalled();

    mocks.recordSettlement.mockRejectedValueOnce(new Error("private database and customer detail"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const conflict = await recordReceipt(
      request("/api/receivables/receipts", "POST", receiptBody),
    );
    consoleError.mockRestore();
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain("private database and customer detail");
  });
});
