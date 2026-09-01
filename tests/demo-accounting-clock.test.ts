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

  it("keeps the rolling fixture window inside one fiscal period at month boundaries", () => {
    const earlyMonthCalendars = [
      demoAccountingCalendar(new Date("2026-09-01T16:00:00.000Z")),
      demoAccountingCalendar(new Date("2026-09-16T16:00:00.000Z")),
    ];
    for (const earlyMonth of earlyMonthCalendars) {
      expect(earlyMonth).toMatchObject({ accountingDate: "2026-08-31", fiscalYear: 2026, periodNumber: 8 });
      expect(demoDateOffset(earlyMonth.accountingDate, -16)).toBe("2026-08-15");
    }

    const laterMonth = demoAccountingCalendar(new Date("2026-09-17T16:00:00.000Z"));
    expect(laterMonth).toMatchObject({ accountingDate: "2026-09-17", fiscalYear: 2026, periodNumber: 9 });
    expect(demoDateOffset(laterMonth.accountingDate, -16)).toBe("2026-09-01");

    for (const calendar of [...earlyMonthCalendars, laterMonth]) {
      for (const offset of [-16, -14, -11, -8]) {
        expect(demoDateOffset(calendar.accountingDate, offset).slice(0, 7))
          .toBe(calendar.accountingDate.slice(0, 7));
      }
    }
  });

  it("derives fiscal period states from the stabilized clock", () => {
    const calendar = demoAccountingCalendar(new Date("2026-09-17T16:00:00.000Z"));
    expect(demoPeriodState(7, calendar.periodNumber)).toBe("SEALED");
    expect(demoPeriodState(8, calendar.periodNumber)).toBe("HARD_CLOSED");
    expect(demoPeriodState(9, calendar.periodNumber)).toBe("OPEN");
  });
});
