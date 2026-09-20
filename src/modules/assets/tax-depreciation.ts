import Decimal from "decimal.js";
import { z } from "zod";

const amount = z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/);

export const canadianCcaRuleSchema = z.object({
  key: z.string(),
  version: z.string(),
  jurisdiction: z.literal("CA"),
  regimeKey: z.literal("CANADA_CCA"),
  classKey: z.string(),
  description: z.string(),
  prescribedRate: z.string(),
  firstYearFactor: z.string(),
  firstYearTreatment: z.enum(["STANDARD_HALF_YEAR", "IMMEDIATE_EXPENSING"]),
  eligibilitySummary: z.string().min(1),
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().nullable(),
  authorityStatus: z.enum(["ENACTED", "PROPOSED"]),
  sourceUri: z.url(),
}).strict();

export type CanadianCcaRule = z.infer<typeof canadianCcaRuleSchema>;

export const CANADIAN_CCA_RULES: readonly CanadianCcaRule[] = [
  canadianCcaRuleSchema.parse({
    key: "CA-CCA-CLASS-50-STANDARD",
    version: "2025.1",
    jurisdiction: "CA",
    regimeKey: "CANADA_CCA",
    classKey: "50",
    description: "General-purpose electronic data-processing equipment under standard Class 50 treatment.",
    prescribedRate: "0.55",
    firstYearFactor: "0.5",
    firstYearTreatment: "STANDARD_HALF_YEAR",
    eligibilitySummary: "Use only after review confirms that no enacted enhanced first-year allowance applies to the addition.",
    effectiveFrom: "2007-03-19",
    effectiveTo: null,
    authorityStatus: "ENACTED",
    sourceUri: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/sole-proprietorships-partnerships/report-business-income-expenses/claiming-capital-cost-allowance/classes-depreciable-property.html",
  }),
  canadianCcaRuleSchema.parse({
    key: "CA-CCA-CLASS-50-IMMEDIATE-2024-2026",
    version: "2026.1",
    jurisdiction: "CA",
    regimeKey: "CANADA_CCA",
    classKey: "50",
    description: "Enacted immediate first-year expensing for eligible new Class 50 productivity-enhancing property acquired and available for use after April 15, 2024 and before 2027.",
    prescribedRate: "0.55",
    // The enacted 9/11 additional factor plus the ordinary full addition gives
    // a 20/11 base multiplier; at 55%, that is a 100% first-year rate.
    firstYearFactor: "1.818181818181818182",
    firstYearTreatment: "IMMEDIATE_EXPENSING",
    eligibilitySummary: "Confirm new-property eligibility, acquisition and available-for-use dates, ownership/rollover restrictions, and any loss-limitation rules before selection.",
    effectiveFrom: "2024-04-16",
    effectiveTo: "2026-12-31",
    authorityStatus: "ENACTED",
    sourceUri: "https://www.parl.ca/DocumentViewer/en/45-1/bill/C-15/royal-assent",
  }),
];

export const ccaYearInputSchema = z.object({
  taxYear: z.number().int().min(1900).max(2500),
  additions: amount.default("0"),
  assistance: amount.default("0"),
  proceeds: amount.default("0"),
  dispositionCapitalCost: amount.default("0"),
  claimedCca: amount.optional(),
  remainingAssetsAfterYear: z.boolean().default(true),
}).strict();

export const ccaScheduleInputSchema = z.object({
  openingUcc: amount.default("0"),
  prescribedRate: z.string().trim().regex(/^0(?:\.\d{1,9})?$|^1(?:\.0{1,9})?$/).refine((value) => new Decimal(value).greaterThan(0)),
  firstYearFactor: z.string().trim().regex(/^\d+(?:\.\d{1,18})?$/).refine((value) => new Decimal(value).greaterThanOrEqualTo(0) && new Decimal(value).lessThanOrEqualTo(4)),
  businessUsePercent: z.string().trim().regex(/^\d+(?:\.\d{1,4})?$/).refine((value) => new Decimal(value).greaterThan(0) && new Decimal(value).lessThanOrEqualTo(100)),
  years: z.array(ccaYearInputSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  for (let index = 1; index < value.years.length; index += 1) {
    if (value.years[index]!.taxYear !== value.years[index - 1]!.taxYear + 1) {
      context.addIssue({ code: "custom", path: ["years", index, "taxYear"], message: "CCA years must be contiguous" });
    }
  }
});

export type CcaScheduleInput = z.input<typeof ccaScheduleInputSchema>;
export type CcaScheduleLine = Readonly<{
  taxYear: number;
  openingUcc: string;
  additions: string;
  assistance: string;
  businessUseAddition: string;
  proceeds: string;
  dispositionReduction: string;
  firstYearAdjustment: string;
  ccaBase: string;
  maximumCca: string;
  claimedCca: string;
  recapture: string;
  terminalLoss: string;
  closingUcc: string;
}>;

/** Deterministic pool continuity. Values remain exact until rounded to cents per tax year. */
export function calculateCcaSchedule(raw: CcaScheduleInput): readonly CcaScheduleLine[] {
  const input = ccaScheduleInputSchema.parse(raw);
  const rate = new Decimal(input.prescribedRate);
  const firstYearFactor = new Decimal(input.firstYearFactor);
  const use = new Decimal(input.businessUsePercent).dividedBy(100);
  let opening = new Decimal(input.openingUcc);
  return input.years.map((year) => {
    const additions = new Decimal(year.additions);
    const assistance = new Decimal(year.assistance);
    if (assistance.greaterThan(additions)) throw new Error("CCA assistance cannot exceed additions for the year");
    const businessUseAddition = additions.minus(assistance).times(use);
    const proceeds = new Decimal(year.proceeds).times(use);
    const dispositionCost = new Decimal(year.dispositionCapitalCost).times(use);
    const dispositionReduction = Decimal.min(proceeds, dispositionCost);
    const poolBeforeCca = opening.plus(businessUseAddition).minus(dispositionReduction);
    const recapture = Decimal.max(0, poolBeforeCca.negated());
    const nonNegativePool = Decimal.max(0, poolBeforeCca);
    const terminalLoss = !year.remainingAssetsAfterYear && nonNegativePool.greaterThan(0)
      ? nonNegativePool
      : new Decimal(0);
    const firstYearAdjustment = businessUseAddition.times(new Decimal(1).minus(firstYearFactor));
    const ccaBase = terminalLoss.greaterThan(0)
      ? new Decimal(0)
      : Decimal.max(0, nonNegativePool.minus(firstYearAdjustment));
    const maximum = Decimal.min(nonNegativePool, ccaBase.times(rate)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const claimed = year.claimedCca === undefined ? maximum : new Decimal(year.claimedCca);
    if (claimed.greaterThan(maximum)) throw new Error("Claimed CCA cannot exceed the calculated maximum");
    const closing = recapture.greaterThan(0) || terminalLoss.greaterThan(0)
      ? new Decimal(0)
      : nonNegativePool.minus(claimed).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const line = {
      taxYear: year.taxYear,
      openingUcc: opening.toFixed(2),
      additions: additions.toFixed(2),
      assistance: assistance.toFixed(2),
      businessUseAddition: businessUseAddition.toFixed(2),
      proceeds: proceeds.toFixed(2),
      dispositionReduction: dispositionReduction.toFixed(2),
      firstYearAdjustment: firstYearAdjustment.toFixed(2),
      ccaBase: ccaBase.toFixed(2),
      maximumCca: maximum.toFixed(2),
      claimedCca: claimed.toFixed(2),
      recapture: recapture.toFixed(2),
      terminalLoss: terminalLoss.toFixed(2),
      closingUcc: closing.toFixed(2),
    };
    opening = closing;
    return line;
  });
}

export function effectiveCcaRule(ruleKey: string, availableForUseOn: string): CanadianCcaRule {
  const rule = CANADIAN_CCA_RULES.find((candidate) => candidate.key === ruleKey &&
    candidate.effectiveFrom <= availableForUseOn &&
    (candidate.effectiveTo === null || candidate.effectiveTo >= availableForUseOn));
  if (!rule) throw new Error("No reviewed CCA rule is effective for the supplied available-for-use date");
  return rule;
}
