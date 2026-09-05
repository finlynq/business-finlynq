import { describe, expect, it } from "vitest";
import { previewBankStatementExtraction } from "@/modules/banking/statement-import-model";

const base = {
  extractionVersion: "finlynq.statement.v1" as const,
  institution: "Example Bank",
  maskedAccount: "•••• 1234",
  accountKind: "CASH" as const,
  currency: "CAD",
  statementStartOn: "2026-08-01",
  statementEndOn: "2026-08-31",
  balanceConvention: "SIGNED_ACCOUNT_BALANCE" as const,
  openingBalance: "100.00",
  closingBalance: "127.50",
  namedBalances: [{ name: "Available balance", amount: "120.00" }],
  pageCount: 3,
  rows: [
    { rowNumber: 1, postedOn: "2026-08-02", direction: "INCREASE" as const, sourceKind: "DEPOSIT" as const, amount: "50.00", payee: "Client" },
    { rowNumber: 2, postedOn: "2026-08-03", direction: "DECREASE" as const, sourceKind: "WITHDRAWAL" as const, amount: "20.00", description: "Purchase" },
    { rowNumber: 3, postedOn: "2026-08-04", direction: "DECREASE" as const, sourceKind: "FEE" as const, amount: "2.50", description: "Monthly fee" },
  ],
};

describe("bank statement extraction preview", () => {
  it("normalizes exact cash signs and produces a stable reviewed preview", () => {
    const first = previewBankStatementExtraction(base);
    const second = previewBankStatementExtraction(structuredClone(base));

    expect(first.readyToImport).toBe(true);
    expect(first.rows.map((row) => row.amount)).toEqual(["50.000000000", "-20.000000000", "-2.500000000"]);
    expect(first.statementMovement).toBe("27.500000000");
    expect(first.transactionTotal).toBe("27.500000000");
    expect(first.namedBalances).toEqual([{ name: "Available balance", amount: "120.000000000" }]);
    expect(second.previewHash).toBe(first.previewHash);
    expect(second.rows.map((row) => row.fingerprint)).toEqual(first.rows.map((row) => row.fingerprint));
  });

  it("normalizes credit-card charges, payments, interest, and credit balances", () => {
    const preview = previewBankStatementExtraction({
      ...base,
      accountKind: "CREDIT_CARD",
      balanceConvention: "POSITIVE_AMOUNT_OWED",
      openingBalance: "100.00",
      closingBalance: "-10.00",
      namedBalances: [{ name: "Statement balance", amount: "-10.00" }],
      rows: [
        { rowNumber: 1, postedOn: "2026-08-02", direction: "DECREASE", sourceKind: "PURCHASE", amount: "25.00", payee: "Shop" },
        { rowNumber: 2, postedOn: "2026-08-03", direction: "DECREASE", sourceKind: "INTEREST", amount: "5.00" },
        { rowNumber: 3, postedOn: "2026-08-04", direction: "INCREASE", sourceKind: "PAYMENT", amount: "140.00" },
      ],
    });

    expect(preview.openingBalance).toBe("-100.000000000");
    expect(preview.closingBalance).toBe("10.000000000");
    expect(preview.rows.map((row) => row.amount)).toEqual(["-25.000000000", "-5.000000000", "140.000000000"]);
    expect(preview.readyToImport).toBe(true);
  });

  it("retains foreign transaction facts and gives identical rows distinct stable occurrences", () => {
    const preview = previewBankStatementExtraction({
      ...base,
      openingBalance: "100.00",
      closingBalance: "80.00",
      rows: [
        { rowNumber: 20, postedOn: "2026-08-10", direction: "DECREASE", sourceKind: "WITHDRAWAL", amount: "10.00", payee: "Café", originalAmount: "6.75", originalCurrency: "EUR" },
        { rowNumber: 21, postedOn: "2026-08-10", direction: "DECREASE", sourceKind: "WITHDRAWAL", amount: "10.00", payee: "Café", originalAmount: "6.75", originalCurrency: "EUR" },
      ],
    });

    expect(preview.readyToImport).toBe(true);
    expect(preview.rows[0]?.originalCurrency).toBe("EUR");
    expect(preview.rows[0]?.fingerprint).not.toBe(preview.rows[1]?.fingerprint);
    expect(previewBankStatementExtraction(structuredClone({ ...base, openingBalance: "100.00", closingBalance: "80.00", rows: [
      { rowNumber: 20, postedOn: "2026-08-10", direction: "DECREASE", sourceKind: "WITHDRAWAL", amount: "10.00", payee: "Café", originalAmount: "6.75", originalCurrency: "EUR" },
      { rowNumber: 21, postedOn: "2026-08-10", direction: "DECREASE", sourceKind: "WITHDRAWAL", amount: "10.00", payee: "Café", originalAmount: "6.75", originalCurrency: "EUR" },
    ] })).rows.map((row) => row.fingerprint)).toEqual(preview.rows.map((row) => row.fingerprint));
  });

  it("keeps row deduplication stable when only the descriptive source kind changes", () => {
    const withdrawal = previewBankStatementExtraction({
      ...base,
      openingBalance: "100.00",
      closingBalance: "90.00",
      rows: [
        { rowNumber: 1, postedOn: "2026-08-15", direction: "DECREASE", sourceKind: "WITHDRAWAL", amount: "10.00", reference: "BANK-42" },
      ],
    });
    const payment = previewBankStatementExtraction({
      ...base,
      openingBalance: "100.00",
      closingBalance: "90.00",
      rows: [
        { rowNumber: 1, postedOn: "2026-08-15", direction: "DECREASE", sourceKind: "PAYMENT", amount: "10.00", reference: "BANK-42" },
      ],
    });

    expect(withdrawal.rows[0]?.fingerprint).toBe(payment.rows[0]?.fingerprint);
    expect(withdrawal.previewHash).not.toBe(payment.previewHash);
  });

  it("blocks mismatched totals, duplicate row numbers, and out-of-period rows", () => {
    const preview = previewBankStatementExtraction({
      ...base,
      rows: [
        { rowNumber: 1, postedOn: "2026-07-31", direction: "INCREASE", sourceKind: "DEPOSIT", amount: "1.00" },
        { rowNumber: 1, postedOn: "2026-08-02", direction: "INCREASE", sourceKind: "DEPOSIT", amount: "1.00" },
      ],
    });

    expect(preview.readyToImport).toBe(false);
    expect(preview.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "ROW_OUTSIDE_PERIOD", "DUPLICATE_ROW_NUMBER", "STATEMENT_MOVEMENT_MISMATCH",
    ]));
  });

  it("uses explicit economic direction when a cash statement labels an outgoing row as a payment", () => {
    const preview = previewBankStatementExtraction({
      ...base,
      openingBalance: "100.00",
      closingBalance: "75.00",
      rows: [
        { rowNumber: 1, postedOn: "2026-08-15", direction: "DECREASE", sourceKind: "PAYMENT", amount: "25.00" },
      ],
    });

    expect(preview.rows[0]).toMatchObject({
      direction: "DECREASE",
      sourceKind: "PAYMENT",
      amount: "-25.000000000",
    });
    expect(preview.readyToImport).toBe(true);
  });

  it("records exclusions but requires included rows to prove the balance movement", () => {
    const preview = previewBankStatementExtraction({
      ...base,
      rows: [
        ...base.rows,
        { rowNumber: 4, postedOn: "2026-08-31", direction: "INCREASE", sourceKind: "DEPOSIT", amount: "999.00", excluded: true, exclusionReason: "Page total, not a transaction" },
      ],
    });

    expect(preview.readyToImport).toBe(true);
    expect(preview.excludedRowCount).toBe(1);
    expect(preview.transactionTotal).toBe("27.500000000");
  });
});
