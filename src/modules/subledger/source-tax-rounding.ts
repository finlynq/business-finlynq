import { z } from "zod";
import { exact, isQuantizedMoney, minorUnits, quantizeMoney } from "@/kernel/money";
import type { TaxDecision } from "@/modules/tax/types";
import { BusinessDocumentValidationError } from "./validation-errors";

export const sourceTaxRoundingSchema = z.object({
  amount: z.string().trim().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,9})?$/),
  reason: z.string().trim().min(8).max(500),
  evidenceReference: z.string().trim().min(1).max(200),
  reviewed: z.boolean().default(false),
}).strict();

/** Preserve the engine's jurisdiction, rates, component keys and recovery split. */
export function applySourceTaxRounding(base: TaxDecision, input: z.infer<typeof sourceTaxRoundingSchema>): TaxDecision {
  const { currency, taxableBasis, direction } = base.facts;
  const source = exact(input.amount);
  const calculated = exact(base.totalTax);
  const difference = source.minus(calculated);
  const tolerance = exact(10).pow(-minorUnits(currency));
  const reject = (message: string): never => {
    throw new BusinessDocumentValidationError("SOURCE_TAX_ROUNDING_REVIEW_REQUIRED", message);
  };
  if (direction !== "PURCHASE" || base.status !== "APPLIED"
    || base.components.some((component) => component.treatment === "DISCLOSURE_ONLY")) {
    reject("Source-tax rounding requires a supported taxable supplier line. Review the tax determination first.");
  }
  if (!isQuantizedMoney(input.amount, currency)
    || (source.isNegative() && exact(taxableBasis).greaterThan(0))
    || (source.greaterThan(0) && exact(taxableBasis).isNegative())) {
    reject("The source tax must use the invoice currency precision and have the same sign as the taxable net amount.");
  }
  if (difference.abs().greaterThan(tolerance) || (calculated.isZero() && !source.isZero())) {
    reject(`The source tax differs from the calculated tax by ${difference.toFixed(minorUnits(currency))} ${currency}. The rounding limit is one currency minor unit per line; a larger or unsupported difference needs a separately reviewed source-tax override with evidence.`);
  }
  let remaining = source;
  const components = base.components.map((component, index) => {
    const amount = index === base.components.length - 1 ? remaining
      : calculated.isZero() ? exact(0) : quantizeMoney(source.times(component.amount).div(calculated), currency);
    remaining = remaining.minus(amount);
    return { ...component, amount: amount.toFixed(minorUnits(currency)) };
  });
  const rates = new Map(base.components.map((component) => [component.key.replace(/_(?:NONRECOVERABLE|RECOVERABLE)$/, ""), component.rate]));
  const ratePercent = [...rates.values()].reduce((sum, rate) => sum.plus(rate), exact(0)).times(100).toFixed();
  const hasRecoverable = components.some((component) => component.treatment === "RECOVERABLE");
  const hasNonrecoverable = components.some((component) => component.treatment === "NONRECOVERABLE");
  return {
    ...base, components, totalTax: source.toFixed(minorUnits(currency)), ruleKey: "controlled-source-tax-rounding",
    status: input.reviewed ? "APPLIED" : "MANUAL_REVIEW_REQUIRED",
    source: `Supplier invoice rounding; engine: ${base.source}`,
    ...(input.reviewed ? {} : { reviewReason: "Verify the original invoice and explicitly review this rounding difference before posting." }),
    sourceOverride: {
      state: input.reviewed ? "REVIEWED" : "PENDING_REVIEW", ratePercent,
      sourceAmount: source.toFixed(minorUnits(currency)), calculatedAmount: base.totalTax,
      adjustmentAmount: difference.toFixed(minorUnits(currency)), automatedStatus: base.status,
      automatedRatePercent: ratePercent, automatedAmount: base.totalTax, automatedRuleKey: base.ruleKey,
      jurisdiction: base.jurisdiction, componentKey: "SOURCE_ROUNDING", reason: input.reason,
      evidenceReference: input.evidenceReference, adjustmentReason: input.reason, adjustmentEvidenceReference: input.evidenceReference,
      ...(input.reviewed ? { reviewedTreatment: hasRecoverable ? hasNonrecoverable ? "PARTIALLY_RECOVERABLE" as const : "FULLY_RECOVERABLE" as const : "NONRECOVERABLE" as const } : {}),
    },
  };
}
