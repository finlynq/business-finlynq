import { describe, expect, it } from "vitest";
import {
  demoAccountingCalendar,
  demoAccountingDate,
  demoDateOffset,
  demoPeriodState,
} from "@/modules/demo/accounting-clock";
import { DEMO_BASELINE_DATE } from "@/modules/demo/constants";
import {
  WASHINGTON_SALES_USE_EFFECTIVE_FROM,
  WASHINGTON_SALES_USE_EFFECTIVE_TO,
} from "@/modules/tax/packs/washington";

describe("demo accounting clock", () => {
  it("follows the Toronto calendar inside the approved tax window", () => {
    expect(demoAccountingDate(new Date("2026-08-28T02:00:00.000Z"))).toBe("2026-08-27");
    expect(demoAccountingDate(new Date("2026-08-28T05:00:00.000Z"))).toBe("2026-08-28");
  });

  it("pins before the baseline and after the approved Washington pack", () => {
    expect(demoAccountingDate(new Date("2025-01-01T12:00:00.000Z"))).toBe(DEMO_BASELINE_DATE);
    expect(demoAccountingDate(new Date("2027-01-01T12:00:00.000Z")))
      .toBe(WASHINGTON_SALES_USE_EFFECTIVE_TO);
    expect(DEMO_BASELINE_DATE >= WASHINGTON_SALES_USE_EFFECTIVE_FROM).toBe(true);
    expect(DEMO_BASELINE_DATE <= WASHINGTON_SALES_USE_EFFECTIVE_TO).toBe(true);
  });

  it("derives fiscal period state and relative fixture dates from the clock", () => {
    const calendar = demoAccountingCalendar(new Date("2026-09-15T16:00:00.000Z"));
    expect(calendar).toMatchObject({ accountingDate: "2026-09-15", fiscalYear: 2026, periodNumber: 9 });
    expect(demoPeriodState(7, calendar.periodNumber)).toBe("SEALED");
    expect(demoPeriodState(8, calendar.periodNumber)).toBe("HARD_CLOSED");
    expect(demoPeriodState(9, calendar.periodNumber)).toBe("OPEN");
    expect(demoDateOffset(calendar.accountingDate, -16)).toBe("2026-08-30");
  });
});
