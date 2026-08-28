import { describe, expect, it } from "vitest";
import { exact, formatMoney, formatMoneyAmount, quantizeMoney } from "@/kernel/money";
import {
  calculateOpenItemRevaluation,
  calculatePartialSettlementFx,
  convertToFunctional,
  FX_QUOTE_CONVENTION,
  FX_REVALUATION_METHOD,
} from "@/modules/ledger/fx-policy";

describe("exact money and foreign currency", () => {
  it("does not inherit binary floating-point artifacts", () => {
    expect(exact("0.1").plus("0.2").toFixed(2)).toBe("0.30");
    expect(quantizeMoney("12.345", "CAD").toFixed(2)).toBe("12.35");
  });

  it("preserves negative signs when a report renders currency in its own column", () => {
    expect(formatMoneyAmount("1234.5", "USD")).toBe("1,234.50");
    expect(formatMoneyAmount("-20", "USD")).toBe("-20.00");
    expect(formatMoney("-20", "USD")).toBe("-USD 20.00");
  });

  it("uses one explicit quote and revaluation convention", () => {
    expect(FX_QUOTE_CONVENTION).toBe("FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT");
    expect(FX_REVALUATION_METHOD).toBe("REVERSE_NEXT_PERIOD");
    expect(convertToFunctional("100", "1.30", "CAD")).toBe("130");
  });

  it("realizes FX only on the allocated receivable portion", () => {
    expect(
      calculatePartialSettlementFx({
        position: "RECEIVABLE",
        allocatedTransactionAmount: "40",
        carryingRate: "1.30",
        settlementRate: "1.32",
        functionalCurrency: "CAD",
      }),
    ).toEqual({
      carryingFunctionalAmount: "52",
      settlementFunctionalAmount: "52.8",
      gainLossFunctional: "0.8",
    });
  });

  it("remeasures only the remaining open monetary item", () => {
    expect(
      calculateOpenItemRevaluation({
        position: "RECEIVABLE",
        openTransactionAmount: "60",
        carryingFunctionalAmount: "78",
        closingRate: "1.35",
        functionalCurrency: "CAD",
      }),
    ).toEqual({
      revaluedFunctionalAmount: "81",
      gainLossFunctional: "3",
      reversesNextPeriod: true,
    });
  });
});
