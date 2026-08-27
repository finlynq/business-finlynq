import { describe, expect, it } from "vitest";
import {
  assertSnapshotTaxDecisionsCurrent,
  buildBusinessDocumentSnapshot,
  canonicalHash,
  sourceContentHash,
} from "@/modules/subledger/document-model";

const ids = {
  ledger: "10000000-0000-4000-8000-000000000001",
  entity: "10000000-0000-4000-8000-000000000002",
  partyAccount: "10000000-0000-4000-8000-000000000003",
  control: "10000000-0000-4000-8000-000000000004",
  tax: "10000000-0000-4000-8000-000000000005",
  revenue: "10000000-0000-4000-8000-000000000006",
  expense: "10000000-0000-4000-8000-000000000007",
  period: "10000000-0000-4000-8000-000000000008",
};

function baseDocument() {
  return {
    kind: "SALES_INVOICE" as const,
    sourceNumber: "inv-1001",
    ledgerId: ids.ledger,
    legalEntityId: ids.entity,
    partyAccountId: ids.partyAccount,
    controlAccountCombinationId: ids.control,
    taxAccountCombinationId: ids.tax,
    documentDate: "2026-08-27",
    accountingDate: "2026-08-27",
    periodId: ids.period,
    dueOn: "2026-09-26",
    currency: "CAD",
    fx: {
      rate: "1",
      source: "FUNCTIONAL",
      effectiveAt: "2026-08-27T12:00:00.000Z",
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" as const,
    },
    description: "Consulting services",
    lines: [{
      description: "Implementation services",
      accountCombinationId: ids.revenue,
      netAmount: "100.00",
      tax: {
        packKey: "ca.on.hst",
        category: "STANDARD" as const,
        destinationCountry: "CA" as const,
        destinationRegion: "ON",
        registrationId: "registration-reference-1",
      },
    }],
  };
}

describe("AR/AP immutable source snapshots", () => {
  it("builds an exact Ontario sales-invoice tax and FX snapshot", () => {
    const snapshot = buildBusinessDocumentSnapshot(baseDocument(), "CAD");

    expect(snapshot.sourceNumber).toBe("INV-1001");
    expect(snapshot.ownerModule).toBe("receivables");
    expect(snapshot.subtotal).toBe("100.00");
    expect(snapshot.taxTotal).toBe("13.00");
    expect(snapshot.grossTotal).toBe("113.00");
    expect(snapshot.grossFunctional).toBe("113.00");
    expect(snapshot.lines[0]?.taxDecision).toMatchObject({
      status: "APPLIED",
      packKey: "ca.on.hst",
      totalTax: "13.00",
    });
    expect(() => assertSnapshotTaxDecisionsCurrent(snapshot)).not.toThrow();
  });

  it("separates recoverable and nonrecoverable purchase tax deterministically", () => {
    const input = baseDocument();
    const snapshot = buildBusinessDocumentSnapshot({
      ...input,
      kind: "SUPPLIER_BILL",
      sourceNumber: "bill-1001",
      description: "Professional services bill",
      lines: [{
        ...input.lines[0],
        accountCombinationId: ids.expense,
        tax: {
          ...input.lines[0].tax,
          recoverablePercent: "50",
        },
      }],
    }, "CAD");

    expect(snapshot.ownerModule).toBe("payables");
    expect(snapshot.taxTotal).toBe("13.00");
    expect(snapshot.lines[0]?.taxDecision.components).toEqual([
      expect.objectContaining({ treatment: "RECOVERABLE", amount: "6.50" }),
      expect.objectContaining({ treatment: "NONRECOVERABLE", amount: "6.50" }),
    ]);
  });

  it("excludes Washington consumer use tax from the supplier open-item gross", () => {
    const input = baseDocument();
    const snapshot = buildBusinessDocumentSnapshot({
      ...input,
      kind: "SUPPLIER_BILL",
      sourceNumber: "bill-wa-1001",
      currency: "USD",
      description: "Washington services bill",
      lines: [{
        ...input.lines[0],
        accountCombinationId: ids.expense,
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

    expect(snapshot.taxTotal).toBe("10.55");
    expect(snapshot.grossTotal).toBe("100.00");
    expect(snapshot.grossFunctional).toBe("100.00");
    expect(snapshot.lines[0]?.taxDecision.components.every(
      (component) => component.treatment === "SELF_ASSESSED_PAYABLE",
    )).toBe(true);
  });

  it("blocks issuing a draft whose deterministic tax pack requires review", () => {
    const input = baseDocument();
    const snapshot = buildBusinessDocumentSnapshot({
      ...input,
      lines: [{
        ...input.lines[0],
        tax: { ...input.lines[0].tax, registrationId: undefined },
      }],
    }, "CAD");

    expect(snapshot.lines[0]?.taxDecision.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(() => assertSnapshotTaxDecisionsCurrent(snapshot)).toThrow("manual review");
  });

  it("uses canonical hashes independent of object key insertion order", () => {
    expect(canonicalHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
    const snapshot = buildBusinessDocumentSnapshot(baseDocument(), "CAD");
    expect(sourceContentHash(snapshot)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects non-quantized source amounts before persistence", () => {
    const input = baseDocument();
    expect(() => buildBusinessDocumentSnapshot({
      ...input,
      lines: [{ ...input.lines[0], netAmount: "100.001" }],
    }, "CAD")).toThrow("exceeds CAD precision");
  });

  it("rejects zero source amounts and zero FX rates", () => {
    const input = baseDocument();
    expect(() => buildBusinessDocumentSnapshot({
      ...input,
      lines: [{ ...input.lines[0], netAmount: "0.00" }],
    }, "CAD")).toThrow();
    expect(() => buildBusinessDocumentSnapshot({
      ...input,
      fx: { ...input.fx, rate: "0" },
    }, "CAD")).toThrow();
  });
});
