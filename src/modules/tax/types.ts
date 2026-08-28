export type TaxDirection = "SALE" | "PURCHASE";
export type TaxCategory =
  | "STANDARD"
  | "ZERO_RATED"
  | "EXEMPT"
  | "RESALE"
  | "MARKETPLACE_COLLECTED"
  | "OUT_OF_SCOPE";

export type TaxFacts = Readonly<{
  direction: TaxDirection;
  taxPointDate: string;
  currency: string;
  taxableBasis: string;
  destinationCountry: string;
  destinationRegion: string;
  destinationCity?: string;
  locationCode?: string;
  category: TaxCategory;
  registrationId?: string;
  evidenceReference?: string;
  recoverablePercent?: string;
}>;

export type TaxComponent = Readonly<{
  key: string;
  label: string;
  rate: string;
  amount: string;
  treatment:
    | "PAYABLE"
    | "RECOVERABLE"
    | "NONRECOVERABLE"
    | "SELF_ASSESSED_PAYABLE"
    | "DISCLOSURE_ONLY";
}>;

export type TaxDecisionStatus =
  | "APPLIED"
  | "ZERO_RATED"
  | "EXEMPT"
  | "RESALE"
  | "MARKETPLACE_COLLECTED"
  | "OUT_OF_SCOPE"
  | "MANUAL_REVIEW_REQUIRED";

export type TaxDecision = Readonly<{
  status: TaxDecisionStatus;
  packKey: string;
  packVersion: string;
  ruleKey: string;
  jurisdiction: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  facts: TaxFacts;
  components: readonly TaxComponent[];
  totalTax: string;
  rounding: "LINE_HALF_UP";
  source: string;
  reviewReason?: string;
}>;

export type TaxPack = Readonly<{
  key: string;
  version: string;
  decide(facts: TaxFacts): TaxDecision;
}>;

export function manualReview(
  pack: Pick<TaxPack, "key" | "version">,
  facts: TaxFacts,
  reason: string,
  source: string,
): TaxDecision {
  return {
    status: "MANUAL_REVIEW_REQUIRED",
    packKey: pack.key,
    packVersion: pack.version,
    ruleKey: "unsupported-or-incomplete",
    jurisdiction: `${facts.destinationCountry}-${facts.destinationRegion}`,
    effectiveFrom: facts.taxPointDate,
    effectiveTo: null,
    facts,
    components: [],
    totalTax: "0.00",
    rounding: "LINE_HALF_UP",
    source,
    reviewReason: reason,
  };
}
