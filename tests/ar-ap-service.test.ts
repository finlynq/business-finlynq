import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const transactionMocks = vi.hoisted(() => ({
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: transactionMocks.withTenantTransaction,
}));

import {
  buildIssueJournalLines,
  recordCustomerReceiptOrSupplierPayment,
  subledgerOperationKey,
  voidIssuedBusinessDocument,
} from "@/modules/subledger/ar-ap-service";
import { buildBusinessDocumentSnapshot } from "@/modules/subledger/document-model";

const previousWritesSetting = process.env.BUSINESS_WRITES_ENABLED;
const context = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000002",
  requestId: "ar-ap-service-unit",
  authMethod: "password+mfa",
  sourceSurface: "UI" as const,
};

const settlement = {
  context,
  kind: "CUSTOMER_RECEIPT" as const,
  sourceNumber: "RCPT-1001",
  ledgerId: "10000000-0000-4000-8000-000000000003",
  legalEntityId: "10000000-0000-4000-8000-000000000004",
  partyAccountId: "10000000-0000-4000-8000-000000000005",
  controlAccountCombinationId: "10000000-0000-4000-8000-000000000006",
  periodId: "10000000-0000-4000-8000-000000000007",
  accountingDate: "2026-08-27",
  settlementDate: "2026-08-27",
  currency: "CAD",
  amount: "100.00",
  fx: {
    rate: "1",
    source: "FUNCTIONAL",
    effectiveAt: "2026-08-27T12:00:00.000Z",
    quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" as const,
  },
  bankAccountCombinationId: "10000000-0000-4000-8000-000000000008",
  realizedFxGainAccountCombinationId: "10000000-0000-4000-8000-000000000009",
  realizedFxLossAccountCombinationId: "10000000-0000-4000-8000-000000000010",
  description: "Customer receipt",
  allocations: [{
    openItemId: "10000000-0000-4000-8000-000000000011",
    transactionAmount: "100.00",
  }],
  idempotencyKey: "receipt-request-1",
};

function washingtonDocument(kind: "SALES_INVOICE" | "SUPPLIER_BILL") {
  return buildBusinessDocumentSnapshot({
    kind,
    sourceNumber: kind === "SALES_INVOICE" ? "INV-WA-1001" : "BILL-WA-1001",
    ledgerId: settlement.ledgerId,
    legalEntityId: settlement.legalEntityId,
    partyAccountId: settlement.partyAccountId,
    controlAccountCombinationId: settlement.controlAccountCombinationId,
    taxAccountCombinationId: settlement.realizedFxLossAccountCombinationId,
    documentDate: "2026-08-27",
    accountingDate: "2026-08-27",
    periodId: settlement.periodId,
    dueOn: "2026-09-26",
    currency: "USD",
    fx: {
      rate: "1",
      source: "FUNCTIONAL",
      effectiveAt: "2026-08-27T12:00:00.000Z",
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
    },
    description: "Washington taxable services",
    lines: [{
      description: "Washington taxable services",
      accountCombinationId: settlement.realizedFxGainAccountCombinationId,
      netAmount: "100.00",
      tax: {
        packKey: "us.wa.sales-use",
        category: "STANDARD",
        destinationCountry: "US",
        destinationRegion: "WA",
        destinationCity: "Seattle",
        locationCode: "1726",
      },
    }],
  }, "USD");
}

beforeEach(() => {
  process.env.BUSINESS_WRITES_ENABLED = "true";
  transactionMocks.withTenantTransaction.mockReset();
});

afterAll(() => {
  if (previousWritesSetting === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousWritesSetting;
});

describe("AR/AP service command boundary", () => {
  it("namespaces otherwise identical idempotency keys across AR and AP", () => {
    expect(subledgerOperationKey("receivables", "issue", "same-client-key")).not.toBe(
      subledgerOperationKey("payables", "issue", "same-client-key"),
    );
  });

  it("posts seller-collected sales tax to AR gross and buyer-remitted use tax outside AP gross", () => {
    const taxSnapshotId = "10000000-0000-4000-8000-000000000012";
    const sale = washingtonDocument("SALES_INVOICE");
    const purchase = washingtonDocument("SUPPLIER_BILL");
    const saleLines = buildIssueJournalLines(sale, settlement.allocations[0].openItemId, new Map([[1, taxSnapshotId]]));
    const purchaseLines = buildIssueJournalLines(purchase, settlement.allocations[0].openItemId, new Map([[1, taxSnapshotId]]));

    expect(sale.grossTotal).toBe("110.55");
    expect(saleLines.find((line) => line.partyAccountId)?.debitTransaction).toBe("110.55");
    expect(purchase.grossTotal).toBe("100.00");
    expect(purchaseLines.find((line) => line.partyAccountId)?.creditTransaction).toBe("100.00");
    expect(purchaseLines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountCombinationId: settlement.realizedFxGainAccountCombinationId,
        debitTransaction: "110.55",
        creditTransaction: "0",
      }),
      expect.objectContaining({
        accountCombinationId: settlement.realizedFxLossAccountCombinationId,
        debitTransaction: "0",
        creditTransaction: "10.55",
        taxSnapshotId,
      }),
    ]));
  });

  it("rejects a settlement that is not exactly allocated before opening a transaction", async () => {
    await expect(recordCustomerReceiptOrSupplierPayment({
      ...settlement,
      allocations: [{ ...settlement.allocations[0], transactionAmount: "99.99" }],
    })).rejects.toThrow("fully allocated");
    expect(transactionMocks.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("rejects transaction-currency fractions beyond configured precision before persistence", async () => {
    await expect(recordCustomerReceiptOrSupplierPayment({
      ...settlement,
      amount: "100.001",
      allocations: [{ ...settlement.allocations[0], transactionAmount: "100.001" }],
    })).rejects.toThrow("exceeds CAD precision");
    expect(transactionMocks.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("binds a business-document void reason to the audit transaction context", async () => {
    await expect(voidIssuedBusinessDocument({
      context: { ...context, reason: "A different reason" },
      kind: "SALES_INVOICE",
      sourceNumber: "INV-1001",
      expectedVersion: 2,
      periodId: settlement.periodId,
      accountingDate: "2026-08-27",
      reason: "Customer contract was cancelled",
      description: "Void invoice INV-1001",
      idempotencyKey: "invoice-void-1",
    })).rejects.toThrow("bound to the transaction audit context");
    expect(transactionMocks.withTenantTransaction).not.toHaveBeenCalled();
  });
});
