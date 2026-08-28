import { describe, expect, it } from "vitest";
import { formatBankingTimestamp } from "@/modules/banking/presentation";

describe("banking timestamp presentation", () => {
  it("renders server-fed instants as explicit deterministic UTC text", () => {
    expect(formatBankingTimestamp("2026-08-28T01:30:00.000Z"))
      .toBe("2026-08-28 01:30 UTC");
    expect(formatBankingTimestamp("2026-08-28T01:30:59.999-04:00"))
      .toBe("2026-08-28 05:30 UTC");
  });

  it("preserves the existing null and invalid timestamp fallbacks", () => {
    expect(formatBankingTimestamp(null)).toBe("Never");
    expect(formatBankingTimestamp("not-a-date")).toBe("not-a-date");
  });
});
