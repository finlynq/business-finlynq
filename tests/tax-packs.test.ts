import { describe, expect, it } from "vitest";
import { decideTax } from "@/modules/tax/engine";

describe("versioned tax decisions", () => {
  it("holds unsupported jurisdictions for review and only permits evidenced zero treatments", () => {
    const facts = {
      direction: "SALE" as const,
      taxPointDate: "2026-08-27",
      currency: "GBP",
      taxableBasis: "100.00",
      destinationCountry: "GB",
      destinationRegion: "ENG",
      category: "STANDARD" as const,
    };
    const review = decideTax("generic.unsupported", facts);
    expect(review.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(review.reviewReason).toContain("No supported tax pack");

    const evidenced = decideTax("generic.unsupported", {
      ...facts,
      category: "OUT_OF_SCOPE",
      evidenceReference: "contract-place-of-supply-2026-08",
    });
    expect(evidenced.status).toBe("OUT_OF_SCOPE");
    expect(evidenced.totalTax).toBe("0.00");
  });

  it("calculates an Ontario CAD 100 standard sale as HST 13", () => {
    const decision = decideTax("ca.on.hst", {
      direction: "SALE",
      taxPointDate: "2026-08-26",
      currency: "CAD",
      taxableBasis: "100",
      destinationCountry: "CA",
      destinationRegion: "ON",
      category: "STANDARD",
      registrationId: "demo-registration",
    });

    expect(decision.status).toBe("APPLIED");
    expect(decision.totalTax).toBe("13.00");
    expect(decision.components).toHaveLength(1);
  });

  it("distinguishes zero-rated from exempt Ontario supplies", () => {
    const facts = {
      direction: "SALE" as const,
      taxPointDate: "2026-08-26",
      currency: "CAD",
      taxableBasis: "100",
      destinationCountry: "CA" as const,
      destinationRegion: "ON",
      registrationId: "demo-registration",
    };

    expect(decideTax("ca.on.hst", { ...facts, category: "ZERO_RATED" }).status).toBe("ZERO_RATED");
    expect(decideTax("ca.on.hst", { ...facts, category: "EXEMPT" }).status).toBe("EXEMPT");
  });

  it("splits a partially recoverable Ontario purchase without losing the ITC", () => {
    const decision = decideTax("ca.on.hst", {
      direction: "PURCHASE",
      taxPointDate: "2026-08-26",
      currency: "CAD",
      taxableBasis: "100",
      destinationCountry: "CA",
      destinationRegion: "ON",
      category: "STANDARD",
      registrationId: "demo-registration",
      recoverablePercent: "50",
    });

    expect(decision.status).toBe("APPLIED");
    expect(decision.totalTax).toBe("13.00");
    expect(decision.components).toEqual([
      expect.objectContaining({
        key: "HST_RECOVERABLE",
        amount: "6.50",
        treatment: "RECOVERABLE",
      }),
      expect.objectContaining({
        key: "HST_NONRECOVERABLE",
        amount: "6.50",
        treatment: "NONRECOVERABLE",
      }),
    ]);
  });

  it("requires manual review for an invalid Ontario recovery percentage", () => {
    const decision = decideTax("ca.on.hst", {
      direction: "PURCHASE",
      taxPointDate: "2026-08-26",
      currency: "CAD",
      taxableBasis: "100",
      destinationCountry: "CA",
      destinationRegion: "ON",
      category: "STANDARD",
      registrationId: "demo-registration",
      recoverablePercent: "125",
    });

    expect(decision.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(decision.reviewReason).toMatch(/between 0 and 100/);
  });

  it("calculates Seattle Q3 2026 state and local components", () => {
    const decision = decideTax("us.wa.sales-use", {
      direction: "SALE",
      taxPointDate: "2026-08-26",
      currency: "USD",
      taxableBasis: "100",
      destinationCountry: "US",
      destinationRegion: "WA",
      destinationCity: "Seattle",
      locationCode: "1726",
      category: "STANDARD",
    });

    expect(decision.status).toBe("APPLIED");
    expect(decision.totalTax).toBe("10.55");
    expect(decision.components.map((component) => component.amount)).toEqual(["6.50", "4.05"]);
  });

  it("classifies Washington purchase tax as buyer-remitted consumer use tax", () => {
    const decision = decideTax("us.wa.sales-use", {
      direction: "PURCHASE",
      taxPointDate: "2026-08-26",
      currency: "USD",
      taxableBasis: "100",
      destinationCountry: "US",
      destinationRegion: "WA",
      destinationCity: "Seattle",
      locationCode: "1726",
      category: "STANDARD",
    });

    expect(decision.ruleKey).toBe("wa-consumer-use");
    expect(decision.totalTax).toBe("10.55");
    expect(decision.components).toEqual([
      expect.objectContaining({ amount: "6.50", treatment: "SELF_ASSESSED_PAYABLE" }),
      expect.objectContaining({ amount: "4.05", treatment: "SELF_ASSESSED_PAYABLE" }),
    ]);
  });

  it("never guesses zero tax when a Washington location is unknown", () => {
    const decision = decideTax("us.wa.sales-use", {
      direction: "SALE",
      taxPointDate: "2026-08-26",
      currency: "USD",
      taxableBasis: "100",
      destinationCountry: "US",
      destinationRegion: "WA",
      destinationCity: "Unknown",
      category: "STANDARD",
    });

    expect(decision.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(decision.reviewReason).toMatch(/verified/);
  });
});
