import { describe, expect, it } from "vitest";
import {
  interpretBankAccountLine,
  paginateReconciliationRows,
} from "@/modules/banking/banking-workspace";

describe("bank reconciliation workspace contracts", () => {
  it.each([
    ["ASSET", "125.00", "0", "125.000000000", "INCREASE", "cash deposit"],
    ["ASSET", "0", "40.00", "-40.000000000", "DECREASE", "cash withdrawal"],
    ["LIABILITY", "0", "85.00", "85.000000000", "INCREASE", "card purchase"],
    ["LIABILITY", "85.00", "0", "-85.000000000", "DECREASE", "card payment or refund"],
  ] as const)("interprets %s account signs", (accountClass, debitAmount, creditAmount, amount, effect, _label) => {
    void _label;
    expect(interpretBankAccountLine({ accountClass, debitAmount, creditAmount })).toEqual({
      signedComparisonAmount: amount,
      accountEffect: effect,
    });
  });

  it("returns stable non-overlapping cursor pages without hiding a row", () => {
    const allRows = Array.from({ length: 121 }, (_, index) => ({ id: `row-${String(index).padStart(3, "0")}` }));
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = paginateReconciliationRows({
        rows: allRows,
        kind: "bank",
        after,
        pageSize: 25,
        snapshotKey: "reconciliation-v4-bank-rows",
        id: (row) => row.id,
      });
      seen.push(...page.rows.map((row) => row.id));
      after = page.nextCursor ?? undefined;
    } while (after);
    expect(seen).toEqual(allRows.map((row) => row.id));
    expect(new Set(seen).size).toBe(allRows.length);
  });

  it("fails closed for a cursor from the other pane", () => {
    const books = paginateReconciliationRows({
      rows: [{ id: "line-1" }, { id: "line-2" }],
      kind: "books",
      pageSize: 1,
      snapshotKey: "reconciliation-v1-books-rows",
      id: (row) => row.id,
    });
    expect(() => paginateReconciliationRows({
      rows: [{ id: "bank-1" }],
      kind: "bank",
      after: books.nextCursor ?? undefined,
      pageSize: 1,
      snapshotKey: "reconciliation-v1-bank-rows",
      id: (row) => row.id,
    })).toThrow(/cursor/i);
  });

  it("fails closed when the reconciliation population changes between pages", () => {
    const first = paginateReconciliationRows({
      rows: [{ id: "bank-1" }, { id: "bank-2" }],
      kind: "bank",
      pageSize: 1,
      snapshotKey: "reconciliation-v1-bank-rows",
      id: (row) => row.id,
    });
    expect(() => paginateReconciliationRows({
      rows: [{ id: "bank-1" }, { id: "bank-2" }, { id: "bank-3" }],
      kind: "bank",
      after: first.nextCursor ?? undefined,
      pageSize: 1,
      snapshotKey: "reconciliation-v2-bank-rows",
      id: (row) => row.id,
    })).toThrow(/cursor/i);
  });
});
