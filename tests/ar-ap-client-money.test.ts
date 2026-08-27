import { describe, expect, it } from "vitest";
import {
  displayExactMoney,
  exactAllocationTotal,
  isPositiveExactAmount,
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
});
