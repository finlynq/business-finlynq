import { describe, expect, it } from "vitest";
import {
  buildBusinessDocumentSnapshot,
  createBusinessDocumentSchema,
} from "@/modules/subledger/document-model";
import { buildIssueJournalLines } from "@/modules/subledger/journal-line-builders";
import { subledgerCommandFingerprints } from "@/modules/subledger/ar-ap-idempotency";
import {
  BusinessDocumentValidationError,
  safeSubledgerValidationDetails,
} from "@/modules/subledger/validation-errors";

const id = (value: number) =>
  "91000000-0000-4000-8000-" + String(value).padStart(12, "0");

function supplierBill() {
  return {
    kind: "SUPPLIER_BILL" as const,
    sourceNumber: "BILL-ADJUSTMENT-1",
    ledgerId: id(1),
    legalEntityId: id(2),
    partyAccountId: id(3),
    controlAccountCombinationId: id(4),
    taxAccountCombinationId: id(5),
    documentDate: "2026-08-31",
    accountingDate: "2026-08-31",
    periodId: id(6),
    dueOn: "2026-09-30",
    currency: "CAD",
    fx: {
      rate: "1",
      source: "FUNCTIONAL",
      effectiveAt: "2026-08-31T12:00:00.000Z",
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" as const,
    },
    description: "Subscription charge and unused-time credit",
    lines: [
      {
        description: "Subscription",
        accountCombinationId: id(7),
        netAmount: "200.00",
        lineType: "STANDARD" as const,
        tax: {
          packKey: "ca.on.hst",
          category: "STANDARD" as const,
          destinationCountry: "CA",
          destinationRegion: "ON",
          registrationId: id(20),
          recoverablePercent: "100",
          evidenceReference: "invoice-line-1",
        },
      },
      {
        description: "Unused-time proration credit",
        accountCombinationId: id(7),
        netAmount: "-21.75",
        lineType: "ADJUSTMENT" as const,
        tax: {
          packKey: "ca.on.hst",
          category: "STANDARD" as const,
          destinationCountry: "CA",
          destinationRegion: "ON",
          registrationId: id(20),
          recoverablePercent: "100",
          evidenceReference: "invoice-line-2",
        },
      },
    ],
  };
}

describe("signed supplier-bill adjustments", () => {
  it("preserves line semantics and reverses line-level tax with exact rounding", () => {
    const snapshot = buildBusinessDocumentSnapshot(supplierBill(), "CAD");

    expect(snapshot).toMatchObject({
      subtotal: "178.25",
      taxTotal: "23.17",
      grossTotal: "201.42",
      grossFunctional: "201.42",
    });
    expect(snapshot.lines[1]).toMatchObject({
      lineType: "ADJUSTMENT",
      netAmount: "-21.75",
      tax: { evidenceReference: "invoice-line-2" },
      taxDecision: {
        totalTax: "-2.83",
        components: [
          expect.objectContaining({
            treatment: "RECOVERABLE",
            amount: "-2.83",
          }),
        ],
      },
    });

    const lines = buildIssueJournalLines(
      snapshot,
      id(30),
      new Map([[1, id(31)], [2, id(32)]]),
    );
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountCombinationId: id(4),
        creditTransaction: "201.42",
      }),
      expect.objectContaining({
        accountCombinationId: id(7),
        debitTransaction: "200.00",
      }),
      expect.objectContaining({
        accountCombinationId: id(5),
        debitTransaction: "26.00",
        taxSnapshotId: id(31),
      }),
      expect.objectContaining({
        accountCombinationId: id(7),
        creditTransaction: "21.75",
      }),
      expect.objectContaining({
        accountCombinationId: id(5),
        creditTransaction: "2.83",
        taxSnapshotId: id(32),
      }),
    ]));
    const debit = lines.reduce((sum, line) => sum + Number(line.debitFunctional), 0);
    const credit = lines.reduce((sum, line) => sum + Number(line.creditFunctional), 0);
    expect(debit).toBe(credit);
  });

  it("retains signed adjustment direction in a foreign-currency bill", () => {
    const input = supplierBill();
    const snapshot = buildBusinessDocumentSnapshot({
      ...input,
      currency: "USD",
      fx: {
        ...input.fx,
        rate: "1.35",
        source: "CLIENT_APPROVED_RATE",
      },
    }, "CAD");
    const lines = buildIssueJournalLines(
      snapshot,
      id(40),
      new Map([[1, id(41)], [2, id(42)]]),
    );

    expect(snapshot.grossTotal).toBe("201.42");
    expect(snapshot.grossFunctional).toBe("271.92");
    expect(lines.find((line) =>
      line.accountCombinationId === id(7) && line.creditTransaction === "21.75"))
      .toMatchObject({ creditFunctional: "29.36", fxRate: "1.35" });
    expect(lines.reduce((sum, line) => sum + Number(line.debitFunctional), 0))
      .toBe(lines.reduce((sum, line) => sum + Number(line.creditFunctional), 0));
  });

  it("keeps an out-of-scope discount separate from taxable charges", () => {
    const input = supplierBill();
    const snapshot = buildBusinessDocumentSnapshot({
      ...input,
      lines: [
        input.lines[0],
        {
          ...input.lines[1],
          netAmount: "-10.00",
          tax: {
            ...input.lines[1].tax,
            category: "OUT_OF_SCOPE" as const,
          },
        },
      ],
    }, "CAD");

    expect(snapshot).toMatchObject({
      subtotal: "190.00",
      taxTotal: "26.00",
      grossTotal: "216.00",
    });
    expect(snapshot.lines[1]?.taxDecision).toMatchObject({
      status: "OUT_OF_SCOPE",
      totalTax: "0.00",
      components: [],
    });
  });

  it("requires explicit adjustment semantics on the offending negative line", () => {
    const input = supplierBill();
    let failure: unknown;
    try {
      buildBusinessDocumentSnapshot({
        ...input,
        lines: input.lines.map((line, index) =>
          index === 1 ? { ...line, lineType: "STANDARD" as const } : line),
      }, "CAD");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BusinessDocumentValidationError);
    expect(safeSubledgerValidationDetails(failure)).toMatchObject({
      code: "SIGNED_LINE_REQUIRES_ADJUSTMENT",
      lineNumber: 2,
      remediation: expect.stringContaining("ADJUSTMENT"),
    });
  });

  it("rejects zero-gross and net-credit documents without coercing them into bills", () => {
    const input = supplierBill();
    const matchingCredit = {
      ...input.lines[1],
      netAmount: "-200.00",
    };
    expect(() => buildBusinessDocumentSnapshot({
      ...input,
      lines: [input.lines[0], matchingCredit],
    }, "CAD")).toThrowError(expect.objectContaining({
      code: "ZERO_GROSS_UNSUPPORTED",
    }));

    expect(() => buildBusinessDocumentSnapshot({
      ...input,
      lines: [{
        ...input.lines[0],
        netAmount: "10.00",
      }, {
        ...input.lines[1],
        netAmount: "-20.00",
      }],
    }, "CAD")).toThrowError(expect.objectContaining({
      code: "SUPPLIER_CREDIT_NOTE_REQUIRED",
    }));
  });

  it("keeps sales-invoice lines positive and rejects a negative adjustment by line", () => {
    const input = supplierBill();
    expect(() => buildBusinessDocumentSnapshot({
      ...input,
      kind: "SALES_INVOICE",
      sourceNumber: "INV-NEGATIVE",
      lines: [input.lines[1]],
    }, "CAD")).toThrowError(expect.objectContaining({
      code: "NEGATIVE_SALES_LINE_UNSUPPORTED",
      lineNumber: 1,
    }));
  });

  it("fingerprints signed semantics for exact idempotent retries", () => {
    const command = createBusinessDocumentSchema.parse({
      ...supplierBill(),
      idempotencyKey: "signed-retry",
    });
    const repeated = createBusinessDocumentSchema.parse({
      ...supplierBill(),
      idempotencyKey: "signed-retry",
    });
    const changed = createBusinessDocumentSchema.parse({
      ...supplierBill(),
      lines: supplierBill().lines.map((line, index) =>
        index === 1 ? { ...line, lineType: "STANDARD" as const } : line),
      idempotencyKey: "signed-retry",
    });

    expect(subledgerCommandFingerprints("payables", "draft-create", repeated))
      .toEqual(subledgerCommandFingerprints("payables", "draft-create", command));
    expect(subledgerCommandFingerprints("payables", "draft-create", changed))
      .not.toEqual(subledgerCommandFingerprints("payables", "draft-create", command));
  });

  it("preserves legacy command fingerprints by not defaulting an omitted lineType", () => {
    const input = supplierBill();
    const { lineType: _lineType, ...legacyLine } = input.lines[0];
    void _lineType;
    const parsed = createBusinessDocumentSchema.parse({
      ...input,
      lines: [legacyLine],
      idempotencyKey: "legacy-retry",
    });
    expect(parsed.lines[0]).not.toHaveProperty("lineType");
  });
});
