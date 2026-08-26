import { exact, quantizeMoney, sumExact } from "@/kernel/money";
import { manualReview, type TaxDecision, type TaxFacts, type TaxPack } from "../types";

const SOURCE = "https://dor.wa.gov/taxes-rates/sales-use-tax-rates/local-sales-use-tax/local-sales-use-tax-rate-table";
const EFFECTIVE_FROM = "2026-07-01";
const EFFECTIVE_TO = "2026-09-30";

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
    effectiveFrom: EFFECTIVE_FROM,
    effectiveTo: EFFECTIVE_TO,
    facts,
    components: [],
    totalTax: "0.00",
    rounding: "LINE_HALF_UP",
    source: SOURCE,
  };
}

export const washingtonSalesUsePack: TaxPack = {
  key: "us.wa.sales-use",
  version: "2026.Q3.DOR",
  decide(facts) {
    if (facts.destinationCountry !== "US" || facts.destinationRegion !== "WA") {
      return manualReview(this, facts, "Washington pack requires a Washington sourcing decision", SOURCE);
    }

    if (facts.currency !== "USD") {
      return manualReview(this, facts, "Washington demo pack accepts USD documents only", SOURCE);
    }

    if (facts.taxPointDate < EFFECTIVE_FROM || facts.taxPointDate > EFFECTIVE_TO) {
      return manualReview(this, facts, "No effective official DOR rate version is loaded for this date", SOURCE);
    }

    if (facts.locationCode !== "1726" || facts.destinationCity?.toUpperCase() !== "SEATTLE") {
      return manualReview(this, facts, "A verified Washington DOR location code is required", SOURCE);
    }

    if (facts.category === "RESALE") {
      if (!facts.evidenceReference) {
        return manualReview(this, facts, "A reseller-permit evidence reference is required", SOURCE);
      }
      return zeroDecision(facts, "RESALE");
    }

    if (facts.category === "MARKETPLACE_COLLECTED") {
      if (!facts.evidenceReference) {
        return manualReview(this, facts, "Marketplace collection evidence is required", SOURCE);
      }
      return zeroDecision(facts, "MARKETPLACE_COLLECTED");
    }

    if (facts.category === "OUT_OF_SCOPE") return zeroDecision(facts, "OUT_OF_SCOPE");

    if (facts.category !== "STANDARD") {
      return manualReview(this, facts, `Unsupported Washington category: ${facts.category}`, SOURCE);
    }

    const basis = exact(facts.taxableBasis);
    const stateTax = quantizeMoney(basis.times("0.065"), "USD");
    const localTax = quantizeMoney(basis.times("0.0405"), "USD");
    const components = [
      {
        key: "WA_STATE",
        label: "Washington state",
        rate: "0.065",
        amount: stateTax.toFixed(2),
        treatment: (facts.direction === "SALE" ? "PAYABLE" : "NONRECOVERABLE") as "PAYABLE" | "NONRECOVERABLE",
      },
      {
        key: "WA_LOCAL_1726",
        label: "Seattle local",
        rate: "0.0405",
        amount: localTax.toFixed(2),
        treatment: (facts.direction === "SALE" ? "PAYABLE" : "NONRECOVERABLE") as "PAYABLE" | "NONRECOVERABLE",
      },
    ];

    return {
      status: "APPLIED",
      packKey: this.key,
      packVersion: this.version,
      ruleKey: facts.direction === "SALE" ? "wa-retail-sale-destination" : "wa-consumer-use",
      jurisdiction: "US-WA-1726",
      effectiveFrom: EFFECTIVE_FROM,
      effectiveTo: EFFECTIVE_TO,
      facts,
      components,
      totalTax: sumExact(components.map((component) => component.amount)).toFixed(2),
      rounding: "LINE_HALF_UP",
      source: SOURCE,
    };
  },
};
