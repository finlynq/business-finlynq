import { exact, minorUnits, quantizeMoney } from "@/kernel/money";
import { manualReview, type TaxDecision, type TaxFacts, type TaxPack } from "../types";

const SOURCE = "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html";

function zeroDecision(
  facts: TaxFacts,
  status: "ZERO_RATED" | "EXEMPT" | "OUT_OF_SCOPE",
): TaxDecision {
  return {
    status,
    packKey: ontarioHstPack.key,
    packVersion: ontarioHstPack.version,
    ruleKey: `ontario-${status.toLowerCase().replaceAll("_", "-")}`,
    jurisdiction: "CA-ON",
    effectiveFrom: "2016-07-01",
    effectiveTo: null,
    facts,
    components: [],
    totalTax: quantizeMoney(0, facts.currency).toFixed(minorUnits(facts.currency)),
    rounding: "LINE_HALF_UP",
    source: SOURCE,
  };
}

export const ontarioHstPack: TaxPack = {
  key: "ca.on.hst",
  version: "2026.08.26",
  decide(facts) {
    if (facts.destinationCountry !== "CA" || facts.destinationRegion !== "ON") {
      return manualReview(this, facts, "Ontario pack requires an Ontario place-of-supply decision", SOURCE);
    }

    try {
      quantizeMoney(0, facts.currency);
    } catch {
      return manualReview(this, facts, "Document currency precision is not configured", SOURCE);
    }

    if (!facts.registrationId) {
      return manualReview(this, facts, "Entity GST/HST registration must be selected", SOURCE);
    }

    if (facts.category === "ZERO_RATED") return zeroDecision(facts, "ZERO_RATED");
    if (facts.category === "EXEMPT") return zeroDecision(facts, "EXEMPT");
    if (facts.category === "OUT_OF_SCOPE") return zeroDecision(facts, "OUT_OF_SCOPE");

    if (facts.category !== "STANDARD") {
      return manualReview(this, facts, `Unsupported Ontario category: ${facts.category}`, SOURCE);
    }

    const basis = exact(facts.taxableBasis);
    let tax: ReturnType<typeof quantizeMoney>;
    try {
      tax = quantizeMoney(basis.times("0.13"), facts.currency);
    } catch {
      return manualReview(this, facts, "Document currency precision is not configured", SOURCE);
    }
    let recoveryRate = exact(0);
    if (facts.direction === "PURCHASE") {
      try {
        recoveryRate = exact(facts.recoverablePercent ?? "0").div(100);
      } catch {
        return manualReview(this, facts, "Recoverable HST percentage must be an exact decimal", SOURCE);
      }

      if (recoveryRate.isNegative() || recoveryRate.greaterThan(1)) {
        return manualReview(this, facts, "Recoverable HST percentage must be between 0 and 100", SOURCE);
      }
    }

    const recoverable = facts.direction === "PURCHASE"
      ? quantizeMoney(tax.times(recoveryRate), facts.currency)
      : exact(0);
    const nonrecoverable = facts.direction === "PURCHASE" ? tax.minus(recoverable) : exact(0);
    const components = facts.direction === "SALE"
      ? [
          {
            key: "HST",
            label: "Ontario HST",
            rate: "0.13",
            amount: tax.toFixed(minorUnits(facts.currency)),
            treatment: "PAYABLE" as const,
          },
        ]
      : [
          ...(!recoverable.isZero()
            ? [
                {
                  key: "HST_RECOVERABLE",
                  label: "Ontario HST — recoverable ITC",
                  rate: "0.13",
                  amount: recoverable.toFixed(minorUnits(facts.currency)),
                  treatment: "RECOVERABLE" as const,
                },
              ]
            : []),
          ...(!nonrecoverable.isZero()
            ? [
                {
                  key: "HST_NONRECOVERABLE",
                  label: "Ontario HST — nonrecoverable",
                  rate: "0.13",
                  amount: nonrecoverable.toFixed(minorUnits(facts.currency)),
                  treatment: "NONRECOVERABLE" as const,
                },
              ]
            : []),
        ];

    return {
      status: "APPLIED",
      packKey: this.key,
      packVersion: this.version,
      ruleKey: facts.direction === "SALE" ? "on-hst-output-standard" : "on-hst-input-standard",
      jurisdiction: "CA-ON",
      effectiveFrom: "2016-07-01",
      effectiveTo: null,
      facts,
      components,
      totalTax: tax.toFixed(minorUnits(facts.currency)),
      rounding: "LINE_HALF_UP",
      source: SOURCE,
    };
  },
};
