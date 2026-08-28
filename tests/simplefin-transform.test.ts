import { describe, expect, it } from "vitest";
import { normalizeSimpleFinPayload } from "@/modules/banking/simplefin-transform";

describe("SimpleFIN exact transform", () => {
  it("keeps canonical money as exact decimal strings, rejects excess precision, and marks pending evidence", () => {
    const normalized = normalizeSimpleFinPayload({
      accounts: [{
        id: "bank-1",
        name: "Operating",
        currency: "usd",
        balance: "0",
        "available-balance": "999999999999.010000000",
        "balance-date": 1_787_846_400,
        transactions: [{
          id: "txn-1",
          posted: 1_787_846_400,
          amount: "1.234567891",
          description: "Pending card authorization",
          payee: "Example merchant",
        }],
      }],
    });
    expect(normalized.accounts[0]).toMatchObject({
      currencyCode: "USD",
      balance: "0",
      availableBalance: "999999999999.01",
      transactions: [{ amount: "1.234567891", status: "PENDING" }],
    });
  });

  it("preserves opaque provider identifiers exactly and rejects collisions caused by normalization or truncation", () => {
    const compatibility = "account-Ａ";
    const ascii = "account-A";
    const longPrefix = "x".repeat(500);
    const result = normalizeSimpleFinPayload({ accounts: [
      { id: compatibility, name: "Compatibility", currency: "USD", transactions: [] },
      { id: ascii, name: "ASCII", currency: "USD", transactions: [] },
      { id: `${longPrefix}1`, name: "Too long one", currency: "USD", transactions: [] },
      { id: `${longPrefix}2`, name: "Too long two", currency: "USD", transactions: [] },
      { id: "control\u0000id", name: "Control", currency: "USD", transactions: [] },
    ] });

    expect(result.accounts.map((account) => account.providerAccountId)).toEqual([compatibility, ascii]);
    expect(result.warnings).toHaveLength(3);
  });

  it("bounds and validates provider decimal strings before arbitrary-precision parsing", () => {
    const result = normalizeSimpleFinPayload({ accounts: [{
      id: "bounded-decimals",
      name: "Bounded decimals",
      currency: "USD",
      balance: "1e3",
      "available-balance": `1${"0".repeat(1_000_000)}`,
      transactions: [
        { id: "excess-scale", posted: 1_787_846_400, amount: "1.1234567895" },
        { id: "leading-zero", posted: 1_787_846_400, amount: "001.25" },
        { id: "canonical", posted: 1_787_846_400, amount: "1.25" },
      ],
    }] });

    expect(result.accounts[0]).toMatchObject({
      balance: null,
      availableBalance: null,
      transactions: [{ providerTransactionId: "canonical", amount: "1.25" }],
    });
    expect(result.warnings).toHaveLength(2);
  });

  it("skips unsupported/duplicate account identities and bounds provider volume", () => {
    const result = normalizeSimpleFinPayload({ accounts: [
      { id: "same", name: "First", currency: "CAD", transactions: [] },
      { id: "same", name: "Duplicate", currency: "CAD", transactions: [] },
      { id: "unsupported", name: "Unsupported", currency: "XXX", transactions: [] },
    ] });
    expect(result.accounts).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    expect(() => normalizeSimpleFinPayload({
      accounts: Array.from({ length: 101 }, (_, index) => ({
        id: `account-${index}`, name: `Account ${index}`, currency: "USD", transactions: [],
      })),
    })).toThrow(/safe ingestion limit/);
  });

  it("fails closed on fractional or unsafe JSON numbers whose source decimal precision is unknowable", () => {
    const result = normalizeSimpleFinPayload({ accounts: [{
      id: "bank-numeric",
      name: "Numeric compatibility",
      currency: "USD",
      balance: 0.1,
      "available-balance": Number.MAX_SAFE_INTEGER + 1,
      transactions: [
        { id: "fractional", posted: 1_787_846_400, amount: 0.1 },
        { id: "unsafe", posted: 1_787_846_400, amount: Number.MAX_SAFE_INTEGER + 1 },
        { id: "safe-integer", posted: 1_787_846_400, amount: 42 },
      ],
    }] });

    expect(result.accounts[0]).toMatchObject({
      balance: null,
      availableBalance: null,
      transactions: [{ providerTransactionId: "safe-integer", amount: "42" }],
    });
    expect(result.warnings).toHaveLength(2);
  });
});
