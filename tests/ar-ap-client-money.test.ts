import { describe, expect, it } from "vitest";
import {
  displayExactMoney,
  exactAllocationTotal,
  isPositiveExactAmount,
  sourceTaxOverridePreview,
} from "@/modules/subledger/client-money";

describe("AR/AP browser money helpers", () => {
  it("sums very large three-decimal KWD allocations without binary rounding", () => {
    expect(exactAllocationTotal({
      first: "999999999999999999999999.999",
      second: "0.001",
    }, "KWD")).toBe("1000000000000000000000000.000");
  });

  it("preserves zero-decimal JPY display and exact positivity", () => {
    expect(exactAllocationTotal({ first: "9007199254740993", second: "7" }, "JPY"))
      .toBe("9007199254741000");
    expect(displayExactMoney("JPY", "9007199254741000")).toBe("JPY 9,007,199,254,741,000");
    expect(isPositiveExactAmount("0.000")).toBe(false);
    expect(isPositiveExactAmount("not-a-number")).toBe(false);
  });

  it("previews exact source-tax arithmetic and flags a source discrepancy", () => {
    expect(sourceTaxOverridePreview({
      netAmount: "12.00",
      ratePercent: "15",
      sourceTaxAmount: "1.80",
      currency: "CAD",
    })).toEqual({
      calculatedTax: "1.80",
      sourceTax: "1.80",
      gross: "13.80",
      arithmeticMatches: true,
    });

    expect(sourceTaxOverridePreview({
      netAmount: "12.00",
      ratePercent: "15",
      sourceTaxAmount: "1.79",
      currency: "CAD",
    })).toEqual({
      calculatedTax: "1.80",
      sourceTax: "1.79",
      gross: "13.79",
      arithmeticMatches: false,
    });
  });
});
