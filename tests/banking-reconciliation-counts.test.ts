import { describe, expect, it } from "vitest";
import { unmatchedReconciliationLedgerLines } from "@/modules/banking/banking-workspace";

describe("banking reconciliation unmatched ledger-line population", () => {
  it("uses the same non-zero remaining population for detail and count", () => {
    const rows = [
      { id: "zero", amount: "100.000000000", allocated: "100.000000000" },
      { id: "one", amount: "543.600000000", allocated: "0.000000000" },
      { id: "partial-debit", amount: "250.000000000", allocated: "100.000000000" },
      { id: "partial-credit", amount: "-80.000000000", allocated: "20.000000000" },
      { id: "credit-closed", amount: "-40.000000000", allocated: "40.000000000" },
    ];

    const unmatched = unmatchedReconciliationLedgerLines(rows);

    expect(unmatched.map((row) => row.id)).toEqual(["one", "partial-debit", "partial-credit"]);
    expect(unmatched).toHaveLength(3);
    expect(unmatchedReconciliationLedgerLines([])).toHaveLength(0);
  });
});
