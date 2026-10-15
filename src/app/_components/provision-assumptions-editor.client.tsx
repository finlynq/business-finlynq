"use client";
import type { ProvisionAssumptions } from "@/modules/tax/provision-model";
type Field = {
    key: string;
    label: string;
    type?: "date" | "number" | "url";
    nullable?: boolean;
    options?: string[];
    fields?: Field[];
    empty?: Record<string, unknown>;
};
const evidence = (key: string, label: string): Field => ({ key, label, nullable: true });
const fields: Field[] = [
    { key: "jurisdiction", label: "Jurisdiction", nullable: true }, { key: "province", label: "Province / territory", nullable: true },
    { key: "corporationStatus", label: "Corporation status", options: ["UNKNOWN", "CCPC", "NON_CCPC", "OTHER"] },
    { key: "eligibility", label: "Rate eligibility", options: ["UNKNOWN", "REVIEWED_ELIGIBLE", "REVIEWED_NOT_ELIGIBLE"] }, evidence("eligibilityEvidence", "Eligibility evidence and business-limit allocation"),
    { key: "incomeCategory", label: "Income category", options: ["UNKNOWN", "ACTIVE_BUSINESS", "GENERAL", "OTHER_REVIEWED"] },
    { key: "rules", label: "Enacted tax-year rules", empty: { component: "", version: "", effectiveFrom: "", effectiveTo: "", legislation: "UNKNOWN", sources: [], rationale: "", bands: [] }, fields: [
            { key: "component", label: "Tax component" }, { key: "version", label: "Rule version" }, { key: "effectiveFrom", label: "Effective from", type: "date" }, { key: "effectiveTo", label: "Effective through", type: "date" }, { key: "legislation", label: "Legislation status", options: ["UNKNOWN", "PROPOSED", "ENACTED"] }, { key: "rationale", label: "Rule and allocation rationale" },
            { key: "sources", label: "Official sources", empty: { url: "", title: "", accessedOn: "", reference: "" }, fields: [{ key: "url", label: "Official HTTPS source", type: "url" }, { key: "title", label: "Source title" }, { key: "accessedOn", label: "Checked on", type: "date" }, { key: "reference", label: "Section and supporting reference" }] },
            { key: "bands", label: "Ascending rate bands", empty: { upTo: null, ratePercent: "" }, fields: [{ key: "upTo", label: "Cumulative taxable-income limit (blank = unlimited)", nullable: true }, { key: "ratePercent", label: "Reviewed rate percent" }] },
        ] },
    { key: "lossCarryforward", label: "Supported loss carryforward (enter zero explicitly)", nullable: true }, evidence("lossEvidence", "Loss balance evidence"),
    { key: "credits", label: "Supported nonrefundable credits (enter zero explicitly)", nullable: true }, evidence("creditEvidence", "Credit evidence"),
    { key: "adjustments", label: "Book-to-tax adjustments", empty: { key: "", category: "PERMANENT", label: "", amount: "", evidence: "", sourceReference: "" }, fields: [{ key: "key", label: "Unique reference" }, { key: "category", label: "Category", options: ["PERMANENT", "TEMPORARY"] }, { key: "label", label: "Description" }, { key: "amount", label: "Signed adjustment amount" }, { key: "evidence", label: "Evidence" }, { key: "sourceReference", label: "Source reference" }] },
    { key: "ccaClaims", label: "Reviewed CCA schedule claims", empty: { scheduleId: "", claimedYtd: "", rationale: "" }, fields: [{ key: "scheduleId", label: "Exact current asset tax schedule ID" }, { key: "claimedYtd", label: "Supported YTD CCA claim" }, { key: "rationale", label: "Claim rationale" }] },
    { key: "journalClassifications", label: "Existing tax journal classifications", empty: { journalId: "", kind: "OTHER", taxYear: 0, evidence: "" }, fields: [{ key: "journalId", label: "Exact journal ID" }, { key: "kind", label: "Classification", options: ["CURRENT_YEAR_PROVISION", "PRIOR_YEAR_TRUE_UP", "INSTALMENT", "PAYMENT", "OTHER"] }, { key: "taxYear", label: "Tax year", type: "number" }, { key: "evidence", label: "Classification evidence" }] },
    evidence("completenessEvidence", "Book coverage, cut-off, CCA, adjustments and completeness review"), { key: "rationale", label: "Overall assumptions rationale" },
];
function Editor({ fields, value, onChange, path }: {
    fields: Field[];
    value: Record<string, unknown>;
    onChange: (value: Record<string, unknown>) => void;
    path: string;
}) {
    return <>{fields.map(field => {
            const current = value[field.key], id = `${path}-${field.key}`;
            if (field.fields) {
                const rows = (Array.isArray(current) ? current : []) as Record<string, unknown>[];
                return <fieldset key={field.key}><legend>{field.label}</legend>{rows.map((row, index) => <fieldset key={index}><legend>{field.label} {index + 1}</legend><Editor fields={field.fields!} value={row} path={`${id}-${index}`} onChange={next => onChange({ ...value, [field.key]: rows.map((item, i) => i === index ? next : item) })}/><button type="button" className="text-link" onClick={() => onChange({ ...value, [field.key]: rows.filter((_, i) => i !== index) })}>Remove {field.label.toLowerCase()} {index + 1}</button></fieldset>)}<button type="button" className="secondary-button" onClick={() => onChange({ ...value, [field.key]: [...rows, structuredClone(field.empty)] })}>Add {field.label.toLowerCase()}</button></fieldset>;
            }
            const update = (next: string) => onChange({ ...value, [field.key]: field.type === "number" ? Number(next) : field.nullable && next === "" ? null : next });
            return <label key={field.key} htmlFor={id}>{field.label}{field.options ? <select id={id} value={String(current ?? "")} onChange={e => update(e.target.value)}>{field.options.map(option => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}</select> : <input id={id} type={field.type ?? "text"} value={String(current ?? "")} onChange={e => update(e.target.value)}/>}</label>;
        })}</>;
}
export function ProvisionAssumptionsEditor({ value, onChange }: {
    value: ProvisionAssumptions;
    onChange: (value: ProvisionAssumptions) => void;
}) { return <Editor fields={fields} value={value} onChange={next => onChange(next as ProvisionAssumptions)} path="provision"/>; }
export function emptyProvisionAssumptions(): ProvisionAssumptions { return { jurisdiction: null, province: null, corporationStatus: "UNKNOWN", eligibility: "UNKNOWN", eligibilityEvidence: null, incomeCategory: "UNKNOWN", rules: [], lossCarryforward: null, lossEvidence: null, credits: null, creditEvidence: null, adjustments: [], ccaClaims: [], expenseAccountIds: [], expenseCombinationId: null, payableCombinationId: null, journalClassifications: [], completenessEvidence: null, rationale: "" }; }
