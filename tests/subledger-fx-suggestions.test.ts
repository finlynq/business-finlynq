import { describe, expect, it } from "vitest";
import {
  applicableOrganizationFxRates,
  suggestedFxEvidence,
  utcFxDateCutoff,
  type OrganizationFxRate,
} from "@/modules/subledger/fx-suggestions";

const rates: OrganizationFxRate[] = [
  {
    id: "rate-same-day-evening",
    sourceCurrency: "USD",
    targetCurrency: "CAD",
    rate: "1.385",
    effectiveAt: "2026-08-27T18:00:00.000Z",
    source: "Treasury same-day close",
  },
  {
    id: "rate-future",
    sourceCurrency: "USD",
    targetCurrency: "CAD",
    rate: "1.40",
    effectiveAt: "2026-09-01T00:00:00.000Z",
    source: "Treasury future",
  },
  {
    id: "rate-latest",
    sourceCurrency: "USD",
    targetCurrency: "CAD",
    rate: "1.375",
    effectiveAt: "2026-08-26T16:00:00.000Z",
    source: "Treasury daily",
  },
  {
    id: "rate-old",
    sourceCurrency: "USD",
    targetCurrency: "CAD",
    rate: "1.36",
    effectiveAt: "2026-08-20T16:00:00.000Z",
    source: "Treasury daily",
  },
  {
    id: "inverse",
    sourceCurrency: "CAD",
    targetCurrency: "USD",
    rate: "0.727272727272727273",
    effectiveAt: "2026-08-26T16:00:00.000Z",
    source: "Treasury daily",
  },
];

describe("subledger organization FX suggestions", () => {
  it("offers the latest rate effective for the exact transaction-to-functional direction", () => {
    expect(applicableOrganizationFxRates(
      rates,
      "USD",
      "CAD",
      "2026-08-27T12:00:00.000Z",
    ).map((rate) => rate.id)).toEqual(["rate-latest", "rate-old"]);

    expect(suggestedFxEvidence(
      rates,
      "USD",
      "CAD",
      "2026-08-27T12:00:00.000Z",
    )).toEqual({
      rate: "1.375",
      source: "Treasury daily",
      effectiveAt: "2026-08-26T16:00:00.000Z",
      organizationRateId: "rate-latest",
    });
  });

  it("uses the end of the UTC accounting date to match server eligibility", () => {
    const cutoff = utcFxDateCutoff("2026-08-27");
    expect(cutoff).toBe("2026-08-27T23:59:59.999Z");
    expect(applicableOrganizationFxRates(
      rates,
      "USD",
      "CAD",
      cutoff,
    ).map((rate) => rate.id)).toEqual([
      "rate-same-day-evening",
      "rate-latest",
      "rate-old",
    ]);
    expect(utcFxDateCutoff("")).toBe("");
  });

  it("falls back to explicit user evidence and never invents an inverse rate", () => {
    expect(suggestedFxEvidence(
      rates,
      "EUR",
      "CAD",
      "2026-08-27T12:00:00.000Z",
    )).toEqual({
      rate: "",
      source: "USER_ENTERED",
      effectiveAt: "2026-08-27T12:00:00.000Z",
      organizationRateId: null,
    });
  });
});
