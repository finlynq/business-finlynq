import { describe, it, expect } from "vitest";
import { calculateProvision, provisionAssumptionsSchema, type ProvisionAssumptions } from "@/modules/tax/provision-model";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = { url: "https://example.org/synthetic-tax-rule", title: "Synthetic acceptance rule, not a legal tax rate", accessedOn: "2025-01-01", reference: "Synthetic rate evidence for deterministic fixtures" };
function assumptions(): ProvisionAssumptions { return { jurisdiction: "SYNTHETIC", province: "TEST", corporationStatus: "OTHER", eligibility: "REVIEWED_NOT_ELIGIBLE", eligibilityEvidence: "Synthetic reviewed corporation status", incomeCategory: "GENERAL", rules: [{ component: "Synthetic current tax", version: "fixture-1", effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31", legislation: "ENACTED", sources: [source], rationale: "Synthetic fixture rate only", bands: [{ upTo: null, ratePercent: "10" }] }], lossCarryforward: "0", lossEvidence: null, credits: "0", creditEvidence: null, adjustments: [], ccaClaims: [], expenseAccountIds: [id(1)], expenseCombinationId: id(2), payableCombinationId: id(3), journalClassifications: [], completenessEvidence: "Synthetic complete book coverage", rationale: "Synthetic reviewed assumptions" }; }
function calculate(a = assumptions(), book = "1000", prior = "0") { return calculateProvision({ assumptions: a, yearStart: "2025-01-01", yearEnd: "2025-12-31", currency: "CAD", bookPreTaxIncome: book, priorPostedProvision: prior }); }
describe("provisional current tax with explicit reviewed assumptions", () => {
    it("requires explicit zero values and never invents eligibility or rates", () => {
        const a = assumptions();
        a.rules = [];
        a.eligibility = "UNKNOWN";
        a.lossCarryforward = null;
        a.credits = null;
        const result = calculate(a);
        expect(result.ready).toBe(false);
        expect(result.blockers.join(" ")).toContain("no default rates");
        expect(result.blockers.join(" ")).toContain("explicit supported loss");
        expect(calculate().ready).toBe(true);
        expect(provisionAssumptionsSchema.parse(assumptions()).lossCarryforward).toBe("0");
    });
    it("has deterministic zero and loss results without refundable assets", () => {
        for (const income of ["0", "-1000.13"]) {
            const result = calculate(assumptions(), income);
            expect(result).toMatchObject({ ready: true, estimatedTaxableIncome: "0.00", ytdCurrentTax: "0.00", incrementalAdjustment: "0.00" });
        }
        const a = assumptions();
        a.credits = "200";
        a.creditEvidence = "Synthetic credit support";
        expect(calculate(a).ytdCurrentTax).toBe("0.00");
    });
    it("explains permanent and temporary adjustments and subtracts only prior posted provision", () => {
        const a = assumptions();
        a.adjustments = [{ key: "permanent", category: "PERMANENT", label: "Synthetic disallowance", amount: "100", evidence: "Synthetic invoice support", sourceReference: "fixture:1" }, { key: "temporary", category: "TEMPORARY", label: "Synthetic timing adjustment", amount: "-200", evidence: "Synthetic timing support", sourceReference: "fixture:2" }];
        a.lossCarryforward = "50";
        a.lossEvidence = "Synthetic approved loss continuity";
        a.credits = "5";
        a.creditEvidence = "Synthetic nonrefundable credit";
        expect(calculate(a, "1000", "20")).toMatchObject({ incomeBeforeLosses: "900.00", lossApplied: "50.00", estimatedTaxableIncome: "850.00", ytdCurrentTax: "80.00", incrementalAdjustment: "60.00" });
        expect(calculate(a, "1000", "100").incrementalAdjustment).toBe("-20.00");
    });
    it("applies reviewed rate bands and exact day weighting for tax-year rate changes", () => {
        const a = assumptions();
        a.rules = [{ ...a.rules[0]!, effectiveTo: "2025-06-30" }, { ...a.rules[0]!, version: "fixture-2", effectiveFrom: "2025-07-01", bands: [{ upTo: null, ratePercent: "20" }] }];
        expect(calculate(a, "36500").ytdCurrentTax).toBe("5490.00");
        a.rules = [{ ...a.rules[0]!, effectiveTo: "2025-12-31", bands: [{ upTo: "1000", ratePercent: "10" }, { upTo: null, ratePercent: "20" }] }];
        expect(calculate(a, "1500").ytdCurrentTax).toBe("200.00");
    });
    it("blocks proposed legislation, date gaps, overlaps and ambiguous bands", () => {
        const a = assumptions();
        a.rules[0]!.legislation = "PROPOSED";
        a.rules[0]!.effectiveFrom = "2025-02-01";
        a.rules[0]!.bands = [{ upTo: "1000", ratePercent: "10" }];
        expect(calculate(a).ready).toBe(false);
        expect(calculate(a).blockers.join(" ")).toMatch(/enacted[\s\S]*gap or overlap[\s\S]*unlimited/);
    });
});
