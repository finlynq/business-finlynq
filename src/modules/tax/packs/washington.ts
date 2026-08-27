import { exact, minorUnits, quantizeMoney, sumExact } from "@/kernel/money";
import { manualReview, type TaxDecision, type TaxFacts, type TaxPack } from "../types";

export const WASHINGTON_SALES_USE_SOURCE = "https://dor.wa.gov/taxes-rates/sales-use-tax-rates/local-sales-use-tax/local-sales-use-tax-rate-table";
export const WASHINGTON_SALES_USE_EFFECTIVE_FROM = "2026-07-01";
export const WASHINGTON_SALES_USE_EFFECTIVE_TO = "2026-09-30";

function zeroDecision(
  facts: TaxFacts,
  status: "RESALE" | "MARKETPLACE_COLLECTED" | "OUT_OF_SCOPE",
): TaxDecision {
  return {
    status,
    packKey: washingtonSalesUsePack.key,
    packVersion: washingtonSalesUsePack.version,
    ruleKey: `washington-${status.toLowerCase().replaceAll("_", "-")}`,
    jurisdiction: "US-WA-1726",
    effectiveFrom: WASHINGTON_SALES_USE_EFFECTIVE_FROM,
    effectiveTo: WASHINGTON_SALES_USE_EFFECTIVE_TO,
    facts,
    components: [],
    totalTax: quantizeMoney(0, facts.currency).toFixed(minorUnits(facts.currency)),
    rounding: "LINE_HALF_UP",
    source: WASHINGTON_SALES_USE_SOURCE,
  };
}

export const washingtonSalesUsePack: TaxPack = {
  key: "us.wa.sales-use",
  version: "2026.Q3.DOR",
  decide(facts) {
    if (facts.destinationCountry !== "US" || facts.destinationRegion !== "WA") {
      return manualReview(this, facts, "Washington pack requires a Washington sourcing decision", WASHINGTON_SALES_USE_SOURCE);
    }

    try {
      quantizeMoney(0, facts.currency);
    } catch {
      return manualReview(this, facts, "Document currency precision is not configured", WASHINGTON_SALES_USE_SOURCE);
    }

    if (
      facts.taxPointDate < WASHINGTON_SALES_USE_EFFECTIVE_FROM ||
      facts.taxPointDate > WASHINGTON_SALES_USE_EFFECTIVE_TO
    ) {
      return manualReview(this, facts, "No effective official DOR rate version is loaded for this date", WASHINGTON_SALES_USE_SOURCE);
    }

    if (facts.locationCode !== "1726" || facts.destinationCity?.toUpperCase() !== "SEATTLE") {
      return manualReview(this, facts, "A verified Washington DOR location code is required", WASHINGTON_SALES_USE_SOURCE);
    }

    if (facts.category === "RESALE") {
      if (!facts.evidenceReference) {
        return manualReview(this, facts, "A reseller-permit evidence reference is required", WASHINGTON_SALES_USE_SOURCE);
      }
      return zeroDecision(facts, "RESALE");
    }

    if (facts.category === "MARKETPLACE_COLLECTED") {
      if (!facts.evidenceReference) {
        return manualReview(this, facts, "Marketplace collection evidence is required", WASHINGTON_SALES_USE_SOURCE);
      }
      return zeroDecision(facts, "MARKETPLACE_COLLECTED");
    }

    if (facts.category === "OUT_OF_SCOPE") return zeroDecision(facts, "OUT_OF_SCOPE");

    if (facts.category !== "STANDARD") {
      return manualReview(this, facts, `Unsupported Washington category: ${facts.category}`, WASHINGTON_SALES_USE_SOURCE);
    }

    const basis = exact(facts.taxableBasis);
    let stateTax: ReturnType<typeof quantizeMoney>;
    let localTax: ReturnType<typeof quantizeMoney>;
    try {
      stateTax = quantizeMoney(basis.times("0.065"), facts.currency);
      localTax = quantizeMoney(basis.times("0.0405"), facts.currency);
    } catch {
      return manualReview(this, facts, "Document currency precision is not configured", WASHINGTON_SALES_USE_SOURCE);
    }
    const components = [
      {
        key: "WA_STATE",
        label: "Washington state",
        rate: "0.065",
        amount: stateTax.toFixed(minorUnits(facts.currency)),
        treatment: (facts.direction === "SALE" ? "PAYABLE" : "SELF_ASSESSED_PAYABLE") as
          | "PAYABLE"
          | "SELF_ASSESSED_PAYABLE",
      },
      {
        key: "WA_LOCAL_1726",
        label: "Seattle local",
        rate: "0.0405",
        amount: localTax.toFixed(minorUnits(facts.currency)),
        treatment: (facts.direction === "SALE" ? "PAYABLE" : "SELF_ASSESSED_PAYABLE") as
          | "PAYABLE"
          | "SELF_ASSESSED_PAYABLE",
      },
    ];

    return {
      status: "APPLIED",
      packKey: this.key,
      packVersion: this.version,
      ruleKey: facts.direction === "SALE" ? "wa-retail-sale-destination" : "wa-consumer-use",
      jurisdiction: "US-WA-1726",
      effectiveFrom: WASHINGTON_SALES_USE_EFFECTIVE_FROM,
      effectiveTo: WASHINGTON_SALES_USE_EFFECTIVE_TO,
      facts,
      components,
      totalTax: sumExact(components.map((component) => component.amount))
        .toFixed(minorUnits(facts.currency)),
      rounding: "LINE_HALF_UP",
      source: WASHINGTON_SALES_USE_SOURCE,
    };
  },
};
