import { minorUnits, quantizeMoney } from "@/kernel/money";
import { manualReview, type TaxDecision, type TaxFacts, type TaxPack } from "../types";

const SOURCE = "Business Finlynq generic jurisdiction fallback";

function evidencedZeroDecision(
  facts: TaxFacts,
  status: "ZERO_RATED" | "EXEMPT" | "RESALE" | "MARKETPLACE_COLLECTED" | "OUT_OF_SCOPE",
): TaxDecision {
  return {
    status,
    packKey: genericUnsupportedTaxPack.key,
    packVersion: genericUnsupportedTaxPack.version,
    ruleKey: `evidenced-${status.toLowerCase().replaceAll("_", "-")}`,
    jurisdiction: `${facts.destinationCountry}-${facts.destinationRegion}`,
    effectiveFrom: facts.taxPointDate,
    effectiveTo: null,
    facts,
    components: [],
    totalTax: quantizeMoney(0, facts.currency).toFixed(minorUnits(facts.currency)),
    rounding: "LINE_HALF_UP",
    source: SOURCE,
  };
}

export const genericUnsupportedTaxPack: TaxPack = {
  key: "generic.unsupported",
  version: "2026.08.27",
  decide(facts) {
    try {
      quantizeMoney(0, facts.currency);
    } catch {
      return manualReview(this, facts, "Document currency precision is not configured", SOURCE);
    }

    if (facts.category !== "STANDARD" && facts.evidenceReference) {
      return evidencedZeroDecision(facts, facts.category);
    }

    return manualReview(
      this,
      facts,
      facts.category === "STANDARD"
        ? `No supported tax pack is installed for ${facts.destinationCountry}-${facts.destinationRegion}`
        : `An evidence reference is required for the ${facts.category.toLowerCase().replaceAll("_", " ")} treatment`,
      SOURCE,
    );
  },
};
