import { exact, minorUnits, quantizeMoney } from "@/kernel/money";
import { manualReview, type TaxDecision, type TaxFacts, type TaxPack } from "../types";

const SOURCE = "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html";

type RateWindow = Readonly<{ rate: string; effectiveFrom: string; effectiveTo: string | null }>;

function rateWindow(region: string, date: string): RateWindow | null {
  if (region === "NB" && date >= "2016-07-01") return { rate: "0.15", effectiveFrom: "2016-07-01", effectiveTo: null };
  if (region === "NL" && date >= "2016-07-01") return { rate: "0.15", effectiveFrom: "2016-07-01", effectiveTo: null };
  if (region === "PE" && date >= "2016-10-01") return { rate: "0.15", effectiveFrom: "2016-10-01", effectiveTo: null };
  if (region === "NS" && date >= "2025-04-01") return { rate: "0.14", effectiveFrom: "2025-04-01", effectiveTo: null };
  if (region === "NS" && date >= "2010-07-01") return { rate: "0.15", effectiveFrom: "2010-07-01", effectiveTo: "2025-03-31" };
  return null;
}

function zeroDecision(facts: TaxFacts, window: RateWindow, status: "ZERO_RATED" | "EXEMPT" | "OUT_OF_SCOPE"): TaxDecision {
  return {
    status,
    packKey: atlanticHstPack.key,
    packVersion: atlanticHstPack.version,
    ruleKey: `atlantic-${status.toLowerCase().replaceAll("_", "-")}`,
    jurisdiction: `CA-${facts.destinationRegion}`,
    effectiveFrom: window.effectiveFrom,
    effectiveTo: window.effectiveTo,
    facts,
    components: [],
    totalTax: quantizeMoney(0, facts.currency).toFixed(minorUnits(facts.currency)),
    rounding: "LINE_HALF_UP",
    source: SOURCE,
  };
}

export const atlanticHstPack: TaxPack = {
  key: "ca.atlantic.hst",
  version: "2026.09.21",
  decide(facts) {
    const window = facts.destinationCountry === "CA"
      ? rateWindow(facts.destinationRegion, facts.taxPointDate)
      : null;
    if (!window) return manualReview(this, facts, "Atlantic HST pack requires a supported province and effective date", SOURCE);
    try {
      quantizeMoney(0, facts.currency);
    } catch {
      return manualReview(this, facts, "Document currency precision is not configured", SOURCE);
    }
    if (!facts.registrationId) return manualReview(this, facts, "Entity GST/HST registration must be selected", SOURCE);
    if (facts.category === "ZERO_RATED") return zeroDecision(facts, window, "ZERO_RATED");
    if (facts.category === "EXEMPT") return zeroDecision(facts, window, "EXEMPT");
    if (facts.category === "OUT_OF_SCOPE") return zeroDecision(facts, window, "OUT_OF_SCOPE");
    if (facts.category !== "STANDARD") return manualReview(this, facts, `Unsupported Atlantic HST category: ${facts.category}`, SOURCE);

    const tax = quantizeMoney(exact(facts.taxableBasis).times(window.rate), facts.currency);
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
    const recoverable = facts.direction === "PURCHASE" ? quantizeMoney(tax.times(recoveryRate), facts.currency) : exact(0);
    const nonrecoverable = facts.direction === "PURCHASE" ? tax.minus(recoverable) : exact(0);
    const rateLabel = exact(window.rate).times(100).toFixed();
    return {
      status: "APPLIED",
      packKey: this.key,
      packVersion: this.version,
      ruleKey: facts.direction === "SALE" ? "atlantic-hst-output-standard" : "atlantic-hst-input-standard",
      jurisdiction: `CA-${facts.destinationRegion}`,
      effectiveFrom: window.effectiveFrom,
      effectiveTo: window.effectiveTo,
      facts,
      components: facts.direction === "SALE"
        ? [{ key: "HST", label: `${facts.destinationRegion} HST ${rateLabel}%`, rate: window.rate, amount: tax.toFixed(minorUnits(facts.currency)), treatment: "PAYABLE" }]
        : [
            ...(!recoverable.isZero() ? [{ key: "HST_RECOVERABLE", label: `${facts.destinationRegion} HST — recoverable ITC`, rate: window.rate, amount: recoverable.toFixed(minorUnits(facts.currency)), treatment: "RECOVERABLE" as const }] : []),
            ...(!nonrecoverable.isZero() ? [{ key: "HST_NONRECOVERABLE", label: `${facts.destinationRegion} HST — nonrecoverable`, rate: window.rate, amount: nonrecoverable.toFixed(minorUnits(facts.currency)), treatment: "NONRECOVERABLE" as const }] : []),
          ],
      totalTax: tax.toFixed(minorUnits(facts.currency)),
      rounding: "LINE_HALF_UP",
      source: SOURCE,
    };
  },
};
