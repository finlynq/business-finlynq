export type OrganizationFxRate = Readonly<{
  id: string;
  sourceCurrency: string;
  targetCurrency: string;
  rate: string;
  effectiveAt: string;
  source: string;
}>;

export type FxEvidenceDraft = Readonly<{
  rate: string;
  source: string;
  effectiveAt: string;
  organizationRateId: string | null;
}>;

function validTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function utcFxDateCutoff(date: string): string {
  const timestamp = Date.parse(`${date}T23:59:59.999Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

export function applicableOrganizationFxRates(
  rates: readonly OrganizationFxRate[],
  transactionCurrency: string,
  functionalCurrency: string,
  asOf: string,
): readonly OrganizationFxRate[] {
  const asOfTimestamp = validTimestamp(asOf);
  if (asOfTimestamp === null) return [];
  return [...rates]
    .filter((rate) => (
      rate.sourceCurrency === transactionCurrency &&
      rate.targetCurrency === functionalCurrency &&
      (validTimestamp(rate.effectiveAt) ?? Number.POSITIVE_INFINITY) <= asOfTimestamp
    ))
    .sort((left, right) => (
      (validTimestamp(right.effectiveAt) ?? 0) - (validTimestamp(left.effectiveAt) ?? 0)
    ));
}

export function suggestedFxEvidence(
  rates: readonly OrganizationFxRate[],
  transactionCurrency: string,
  functionalCurrency: string,
  asOf: string,
): FxEvidenceDraft {
  if (transactionCurrency === functionalCurrency) {
    return {
      rate: "1",
      source: "FUNCTIONAL",
      effectiveAt: asOf,
      organizationRateId: null,
    };
  }
  const suggestion = applicableOrganizationFxRates(
    rates,
    transactionCurrency,
    functionalCurrency,
    asOf,
  )[0];
  return suggestion
    ? {
        rate: suggestion.rate,
        source: suggestion.source,
        effectiveAt: suggestion.effectiveAt,
        organizationRateId: suggestion.id,
      }
    : {
        rate: "",
        source: "USER_ENTERED",
        effectiveAt: asOf,
        organizationRateId: null,
      };
}
