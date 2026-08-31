import { describe, expect, it } from "vitest";
import { exact, formatMoney, formatMoneyAmount, quantizeMoney } from "@/kernel/money";

describe("exact money", () => {
  it("does not inherit binary floating-point artifacts", () => {
    expect(exact("0.1").plus("0.2").toFixed(2)).toBe("0.30");
    expect(quantizeMoney("12.345", "CAD").toFixed(2)).toBe("12.35");
  });

  it("preserves negative signs when a report renders currency in its own column", () => {
    expect(formatMoneyAmount("1234.5", "USD")).toBe("1,234.50");
    expect(formatMoneyAmount("-20", "USD")).toBe("-20.00");
    expect(formatMoney("-20", "USD")).toBe("-USD 20.00");
  });

});
