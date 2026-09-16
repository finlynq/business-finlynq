import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculateAssetSchedule, finiteScheduleEnd } from "@/modules/assets/model";

describe("asset and prepaid schedule calculation", () => {
  it("calculates deterministic straight-line depreciation with final-period rounding", () => {
    const schedule = calculateAssetSchedule({
      kind: "TANGIBLE",
      classification: "FINITE_LIFE",
      inServiceOn: "2026-01-15",
      usefulLifeMonths: 3,
      cost: "100.00",
      residualValue: "10.00",
      currency: "CAD",
    });

    expect(finiteScheduleEnd("2026-01-15", 3)).toBe("2026-03-31");
    expect(schedule.map((line) => line.amount)).toEqual(["30.00", "30.00", "30.00"]);
    expect(schedule.map((line) => line.periodEndOn)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("prorates prepaids by covered days in partial months and true-ups the final month", () => {
    const schedule = calculateAssetSchedule({
      kind: "PREPAID",
      classification: "FINITE_LIFE",
      inServiceOn: "2026-01-15",
      scheduleEndOn: "2026-03-14",
      cost: "1200.00",
      residualValue: "0",
      currency: "CAD",
    });

    expect(schedule).toHaveLength(3);
    expect(schedule[0]).toMatchObject({ periodStartOn: "2026-01-15", periodEndOn: "2026-01-31", amount: "345.76" });
    expect(schedule[1]).toMatchObject({ periodStartOn: "2026-02-01", periodEndOn: "2026-02-28", amount: "569.49" });
    expect(schedule[2]).toMatchObject({ periodStartOn: "2026-03-01", periodEndOn: "2026-03-14", amount: "284.75" });
    expect(schedule.reduce((total, line) => total.plus(line.amount), new Decimal(0)).toFixed(2)).toBe("1200.00");
  });

  it("puts indivisible rounding into the final schedule entry", () => {
    const schedule = calculateAssetSchedule({
      kind: "INTANGIBLE",
      classification: "FINITE_LIFE",
      inServiceOn: "2026-04-01",
      usefulLifeMonths: 3,
      cost: "100.00",
      residualValue: "0",
      currency: "CAD",
    });
    expect(schedule.map((line) => line.amount)).toEqual(["33.33", "33.33", "33.34"]);
  });

  it("keeps indefinite-life intangibles out of automatic amortization", () => {
    expect(calculateAssetSchedule({
      kind: "INTANGIBLE",
      classification: "INDEFINITE_LIFE",
      inServiceOn: "2026-01-01",
      cost: "5000",
      residualValue: "0",
      currency: "CAD",
    })).toEqual([]);
    expect(() => calculateAssetSchedule({
      kind: "TANGIBLE",
      classification: "INDEFINITE_LIFE",
      inServiceOn: "2026-01-01",
      cost: "5000",
      residualValue: "0",
      currency: "CAD",
    })).toThrow(/Only intangible/);
  });
});
