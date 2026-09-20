import { describe, expect, it } from "vitest";
import {
  calculateCcaSchedule,
  effectiveCcaRule,
} from "@/modules/assets/tax-depreciation";

describe("Canadian CCA schedule calculation", () => {
  it("applies the standard half-year rule without changing book depreciation", () => {
    const [line] = calculateCcaSchedule({
      openingUcc: "0",
      prescribedRate: "0.55",
      firstYearFactor: "0.5",
      businessUsePercent: "100",
      years: [{ taxYear: 2027, additions: "1000" }],
    });

    expect(line).toMatchObject({
      businessUseAddition: "1000.00",
      firstYearAdjustment: "500.00",
      ccaBase: "500.00",
      maximumCca: "275.00",
      claimedCca: "275.00",
      closingUcc: "725.00",
    });
  });

  it("applies the enacted Class 50 first-year factor at the exact effective window", () => {
    const rule = effectiveCcaRule("CA-CCA-CLASS-50-IMMEDIATE-2024-2026", "2025-06-01");
    const [line] = calculateCcaSchedule({
      openingUcc: "0",
      prescribedRate: rule.prescribedRate,
      firstYearFactor: rule.firstYearFactor,
      businessUsePercent: "100",
      years: [{ taxYear: 2025, additions: "1349.99" }],
    });

    expect(rule.authorityStatus).toBe("ENACTED");
    expect(rule.firstYearTreatment).toBe("IMMEDIATE_EXPENSING");
    expect(line.maximumCca).toBe("1349.99");
    expect(line.closingUcc).toBe("0.00");
    expect(() => effectiveCcaRule(rule.key, "2027-01-01")).toThrow(/effective/);
  });

  it("keeps assistance, business-use limits, and a reduced claim explicit", () => {
    const [line] = calculateCcaSchedule({
      openingUcc: "0",
      prescribedRate: "0.55",
      firstYearFactor: "0.5",
      businessUsePercent: "80",
      years: [{
        taxYear: 2027,
        additions: "1000",
        assistance: "100",
        claimedCca: "100",
      }],
    });

    expect(line).toMatchObject({
      businessUseAddition: "720.00",
      maximumCca: "198.00",
      claimedCca: "100.00",
      closingUcc: "620.00",
    });
  });

  it("separately reports recapture and terminal loss", () => {
    const [recapture] = calculateCcaSchedule({
      openingUcc: "100",
      prescribedRate: "0.55",
      firstYearFactor: "0.5",
      businessUsePercent: "100",
      years: [{
        taxYear: 2027,
        proceeds: "200",
        dispositionCapitalCost: "200",
        remainingAssetsAfterYear: false,
      }],
    });
    const [terminal] = calculateCcaSchedule({
      openingUcc: "100",
      prescribedRate: "0.55",
      firstYearFactor: "0.5",
      businessUsePercent: "100",
      years: [{ taxYear: 2027, remainingAssetsAfterYear: false }],
    });

    expect(recapture).toMatchObject({ recapture: "100.00", terminalLoss: "0.00", closingUcc: "0.00" });
    expect(terminal).toMatchObject({ recapture: "0.00", terminalLoss: "100.00", maximumCca: "0.00", closingUcc: "0.00" });
  });

  it("rejects excess claims, excess assistance, and non-contiguous tax years", () => {
    expect(() => calculateCcaSchedule({
      openingUcc: "0",
      prescribedRate: "0.55",
      firstYearFactor: "0.5",
      businessUsePercent: "100",
      years: [{ taxYear: 2027, additions: "100", claimedCca: "28" }],
    })).toThrow(/cannot exceed/);
    expect(() => calculateCcaSchedule({
      openingUcc: "0",
      prescribedRate: "0.55",
      firstYearFactor: "0.5",
      businessUsePercent: "100",
      years: [{ taxYear: 2027, additions: "100", assistance: "101" }],
    })).toThrow(/assistance/);
    expect(() => calculateCcaSchedule({
      openingUcc: "0",
      prescribedRate: "0.55",
      firstYearFactor: "0.5",
      businessUsePercent: "100",
      years: [{ taxYear: 2027 }, { taxYear: 2029 }],
    })).toThrow(/contiguous/);
  });
});
