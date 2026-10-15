import { z } from "zod";
import { exact, minorUnits, quantizeMoney, sumExact } from "@/kernel/money";
const decimal = z.string().trim().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,9})?$/).refine(value => exact(value).abs().lte("999999999999999999999999999"));
const nonnegative = decimal.refine(value => exact(value).gte(0));
const evidence = z.string().trim().min(8).max(1500);
const source = z.object({ url: z.url().refine(value => value.startsWith("https://")), title: z.string().trim().min(1).max(200), accessedOn: z.iso.date(), reference: evidence }).strict();
export const provisionAssumptionsSchema = z.object({
    jurisdiction: z.string().trim().min(2).max(80).nullable(), province: z.string().trim().min(2).max(80).nullable(),
    corporationStatus: z.enum(["UNKNOWN", "CCPC", "NON_CCPC", "OTHER"]),
    eligibility: z.enum(["UNKNOWN", "REVIEWED_ELIGIBLE", "REVIEWED_NOT_ELIGIBLE"]), eligibilityEvidence: evidence.nullable(),
    incomeCategory: z.enum(["UNKNOWN", "ACTIVE_BUSINESS", "GENERAL", "OTHER_REVIEWED"]),
    rules: z.array(z.object({ component: z.string().trim().min(1).max(80), version: z.string().trim().min(1).max(80),
        effectiveFrom: z.iso.date(), effectiveTo: z.iso.date(), legislation: z.enum(["ENACTED", "PROPOSED", "UNKNOWN"]),
        sources: z.array(source).min(1).max(10), rationale: evidence,
        bands: z.array(z.object({ upTo: nonnegative.nullable(), ratePercent: nonnegative.refine(value => exact(value).lte(100)) }).strict()).min(1).max(10),
    }).strict()).max(30),
    lossCarryforward: nonnegative.nullable(), lossEvidence: evidence.nullable(), credits: nonnegative.nullable(), creditEvidence: evidence.nullable(),
    adjustments: z.array(z.object({ key: z.string().trim().min(1).max(80), category: z.enum(["PERMANENT", "TEMPORARY"]), label: z.string().trim().min(1).max(150), amount: decimal, evidence, sourceReference: z.string().trim().min(1).max(500) }).strict()).max(100),
    ccaClaims: z.array(z.object({ scheduleId: z.uuid(), claimedYtd: nonnegative, rationale: evidence }).strict()).max(100),
    expenseAccountIds: z.array(z.uuid()).max(20), expenseCombinationId: z.uuid().nullable(), payableCombinationId: z.uuid().nullable(),
    journalClassifications: z.array(z.object({ journalId: z.uuid(), kind: z.enum(["CURRENT_YEAR_PROVISION", "PRIOR_YEAR_TRUE_UP", "INSTALMENT", "PAYMENT", "OTHER"]), taxYear: z.number().int().min(1900).max(2500), evidence }).strict()).max(500),
    completenessEvidence: evidence.nullable(), rationale: evidence,
}).strict();
export type ProvisionAssumptions = z.infer<typeof provisionAssumptionsSchema>;
export type ProvisionBridgeAdjustment = {
    key: string;
    category: string;
    label: string;
    amount: string;
    evidence: unknown;
};
const day = (date: string) => Date.parse(`${date}T00:00:00.000Z`) / 86400000;
/** Reviewed single-jurisdiction YTD estimate. No legal rates or eligibility are inferred. */
export function calculateProvision(input: {
    assumptions: ProvisionAssumptions;
    yearStart: string;
    yearEnd: string;
    currency: string;
    bookPreTaxIncome: string;
    priorPostedProvision: string;
    ccaAdjustments?: ProvisionBridgeAdjustment[];
    sourceBlockers?: string[];
}) {
    const a = input.assumptions, blockers = [...(input.sourceBlockers ?? [])];
    const money = (value: string | ReturnType<typeof exact>) => quantizeMoney(value, input.currency).toFixed(minorUnits(input.currency));
    if (!a.jurisdiction || !a.province)
        blockers.push("Confirm the jurisdiction and province for this single-jurisdiction estimate.");
    if (a.corporationStatus === "UNKNOWN" || a.eligibility === "UNKNOWN" || a.incomeCategory === "UNKNOWN" || !a.eligibilityEvidence)
        blockers.push("Review corporation status, income category and rate eligibility with supporting evidence.");
    if (!a.completenessEvidence)
        blockers.push("Review book coverage, cut-off, adjustments and source completeness.");
    if (a.lossCarryforward === null || (exact(a.lossCarryforward ?? "0").gt(0) && !a.lossEvidence))
        blockers.push("Enter an explicit supported loss carryforward or zero.");
    if (a.credits === null || (exact(a.credits ?? "0").gt(0) && !a.creditEvidence))
        blockers.push("Enter explicit supported nonrefundable credits or zero.");
    if (!a.expenseAccountIds.length || !a.expenseCombinationId || !a.payableCombinationId)
        blockers.push("Map current tax expense and payable accounts before calculating a provision.");
    if (new Set(a.adjustments.map(row => row.key)).size !== a.adjustments.length)
        blockers.push("Adjustment keys must be unique.");
    if (new Set(a.ccaClaims.map(row => row.scheduleId)).size !== a.ccaClaims.length)
        blockers.push("Use each exact CCA schedule only once.");
    if (new Set(a.journalClassifications.map(row => row.journalId)).size !== a.journalClassifications.length)
        blockers.push("Classify each journal only once.");
    const bridge: ProvisionBridgeAdjustment[] = [...a.adjustments, ...(input.ccaAdjustments ?? [])];
    const income = exact(input.bookPreTaxIncome).plus(sumExact(bridge.map(row => row.amount)));
    const lossApplied = exact(a.lossCarryforward ?? "0").lt(income) ? exact(a.lossCarryforward ?? "0") : income.gt(0) ? income : exact(0);
    const taxable = income.minus(lossApplied).gt(0) ? income.minus(lossApplied) : exact(0);
    const components = [...new Set(a.rules.map(rule => rule.component))].sort();
    if (!components.length)
        blockers.push("Supply reviewed enacted tax-year rules and rate bands; there are no default rates.");
    const ruleCalculations: {
        component: string;
        version: string;
        effectiveFrom: string;
        effectiveTo: string;
        days: number;
        yearDays: number;
        tax: string;
        sources: unknown;
    }[] = [];
    const yearDays = day(input.yearEnd) - day(input.yearStart) + 1;
    if (!Number.isInteger(yearDays) || yearDays < 1 || yearDays > 367)
        blockers.push("Confirm a fiscal tax year of at most 367 days.");
    let gross = exact(0);
    for (const component of components) {
        const rules = a.rules.filter(rule => rule.component === component).sort((x, y) => x.effectiveFrom.localeCompare(y.effectiveFrom));
        let next = day(input.yearStart);
        for (const rule of rules) {
            const start = Math.max(day(rule.effectiveFrom), day(input.yearStart)), end = Math.min(day(rule.effectiveTo), day(input.yearEnd));
            if (end < start)
                continue;
            if (rule.legislation !== "ENACTED")
                blockers.push(`${component} ${rule.version}: only reviewed enacted rules can support the estimate.`);
            if (start !== next)
                blockers.push(`${component}: effective-date coverage has a gap or overlap.`);
            next = end + 1;
            let lower = exact(0), tax = exact(0);
            for (const [index, band] of rule.bands.entries()) {
                if ((band.upTo === null) !== (index === rule.bands.length - 1))
                    blockers.push(`${component}: use ascending bands ending with an unlimited band.`);
                const upper = band.upTo === null ? taxable : exact(band.upTo);
                if (band.upTo !== null && upper.lte(lower))
                    blockers.push(`${component}: band limits must increase.`);
                const slice = (taxable.lt(upper) ? taxable : upper).minus(lower);
                if (slice.gt(0))
                    tax = tax.plus(slice.times(band.ratePercent).div(100));
                lower = upper;
            }
            const weighted = yearDays > 0 ? tax.times(end - start + 1).div(yearDays) : exact(0);
            gross = gross.plus(weighted);
            ruleCalculations.push({ component, version: rule.version, effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo, days: end - start + 1, yearDays, tax: money(weighted), sources: rule.sources });
        }
        if (next !== day(input.yearEnd) + 1)
            blockers.push(`${component}: rules must cover the whole fiscal tax year, including known rate changes.`);
    }
    const grossRounded = quantizeMoney(gross, input.currency), creditRequested = exact(a.credits ?? "0");
    const creditApplied = creditRequested.lt(grossRounded) ? creditRequested : grossRounded;
    const charge = quantizeMoney(grossRounded.minus(creditApplied), input.currency);
    return { ready: blockers.length === 0, blockers: [...new Set(blockers)], currency: input.currency, yearStart: input.yearStart, yearEnd: input.yearEnd,
        bookPreTaxIncome: money(input.bookPreTaxIncome), adjustments: bridge, incomeBeforeLosses: money(income), lossApplied: money(lossApplied), estimatedTaxableIncome: money(taxable),
        rules: ruleCalculations, grossCurrentTax: money(grossRounded), creditsApplied: money(creditApplied), ytdCurrentTax: money(charge),
        priorPostedProvision: money(input.priorPostedProvision), incrementalAdjustment: money(charge.minus(input.priorPostedProvision)),
        boundary: "PROVISIONAL_CURRENT_TAX_ONLY_NO_DEFERRED_TAX_NO_FILING_NO_PAYMENT" as const,
        explanation: "Current tax expense is excluded from pre-tax book income. Only classified current-year posted provisions reduce the adjustment; instalments and payments remain in the separate liability roll-forward. Losses and credits do not create refundable assets. Effective tax-year rates are weighted by days, with no automatic rate or eligibility assumptions." };
}
