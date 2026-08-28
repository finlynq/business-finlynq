import { describe, expect, it } from "vitest";
import { formatExactCurrencyAmount } from "@/modules/banking/exact-money";

describe("exact banking amount presentation", () => {
  it("never coerces numeric(38,9) values through a JavaScript number", () => {
    expect(formatExactCurrencyAmount("9007199254740993.123456789", "USD"))
      .toBe("USD 9,007,199,254,740,993.123456789");
    expect(formatExactCurrencyAmount("-0.000000001", "CAD"))
      .toBe("CAD -0.000000001");
  });

  it("retains normal currency minor-unit presentation without hiding exact non-zero digits", () => {
    expect(formatExactCurrencyAmount("12.000000000", "USD")).toBe("USD 12.00");
    expect(formatExactCurrencyAmount("12.100000000", "USD")).toBe("USD 12.10");
    expect(formatExactCurrencyAmount("12.000000000", "JPY")).toBe("JPY 12");
  });
});
