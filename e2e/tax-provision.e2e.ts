import { build } from "esbuild";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { calculateProvision, type ProvisionAssumptions } from "../src/modules/tax/provision-model";
import type { listProvisions, provisionWorkspaceOptions, ProvisionCalculationRow } from "../src/modules/tax/provision-service";
const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("provision browser: reviewed assumptions, immutable calculation and explicit unposted generation", async ({ page }) => {
    const root = resolve(__dirname, ".."), date = "2026-01-02T00:00:00.000Z";
    const payload: ProvisionAssumptions = { jurisdiction: "SYNTHETIC", province: "TEST", corporationStatus: "OTHER", eligibility: "REVIEWED_NOT_ELIGIBLE", eligibilityEvidence: "Synthetic reviewed status", incomeCategory: "GENERAL", rules: [{ component: "Synthetic tax", version: "fixture-1", effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31", legislation: "ENACTED", sources: [{ url: "https://example.org/synthetic-tax-rule", title: "Synthetic fixture, not a legal rate", accessedOn: "2025-01-01", reference: "Synthetic deterministic test rule" }], rationale: "Synthetic test rate", bands: [{ upTo: null, ratePercent: "10" }] }], lossCarryforward: "0", lossEvidence: null, credits: "0", creditEvidence: null, adjustments: [], ccaClaims: [], expenseAccountIds: [id(5)], expenseCombinationId: id(6), payableCombinationId: id(7), journalClassifications: [], completenessEvidence: "Synthetic complete posted book coverage", rationale: "Synthetic reviewed tax assumptions" };
    const options: Awaited<ReturnType<typeof provisionWorkspaceOptions>> = { ledgers: [{ id: id(2), entityId: id(1), label: "Synthetic company · PRIMARY", currency: "CAD" }], periods: [{ id: id(3), ledgerId: id(2), fiscalYear: 2025, label: "Synthetic annual period", startsOn: "2025-01-01", endsOn: "2025-12-31", state: "OPEN" }], combinations: [{ id: id(6), accountId: id(5), ledgerId: id(2), label: "6200 · Current tax", accountClass: "EXPENSE" }, { id: id(7), accountId: id(8), ledgerId: id(2), label: "2100 · Tax payable", accountClass: "LIABILITY" }], capabilities: { configure: true, prepare: true, draft: true } };
    const data: Awaited<ReturnType<typeof listProvisions>> = { assumptions: [{ id: id(10), organization_id: id(9), legal_entity_id: id(1), ledger_id: id(2), fiscal_year: 2025, year_start: "2025-01-01", year_end: "2025-12-31", version: 1, state: "DRAFT", payload, created_by: id(4), created_at: date, reason: "Synthetic assumptions", command_hash: "a".repeat(64) }], calculations: [], events: [] };
    const result = await build({ absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", outfile: "provision.js", stdin: { resolveDir: root, loader: "tsx", contents: `import{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import{TaxProvisionWorkspace}from'@/app/_components/tax-provision-workspace.client';function Fixture(){const[state,setState]=useState(null);useEffect(()=>{const refresh=()=>fetch('/__e2e__/provision-state').then(r=>r.json()).then(setState);window.addEventListener('provision-refresh',refresh);refresh();return()=>window.removeEventListener('provision-refresh',refresh);},[]);return state?<TaxProvisionWorkspace {...state} writable={true}/>:<p>Loading</p>;}createRoot(document.getElementById('root')).render(<Fixture/>);` }, plugins: [{ name: "navigation", setup(bundler) { bundler.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" })); bundler.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export function useRouter(){return{refresh(){window.dispatchEvent(new Event("provision-refresh"));}}}' })); } }] });
    const js = result.outputFiles[0]!.text;
    await page.route("**/__e2e__/provision-state", route => route.fulfill({ json: { data, options } }));
    await page.route("**/__e2e__/provision", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>body{font-family:Arial;padding:20px}input,select{display:block;margin:8px}fieldset{margin:12px}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>` }));
    await page.route("**/api/tax/provision/assumptions", async (route) => { const c = route.request().postDataJSON(), prior = data.assumptions[0]!; expect(c.expectedVersion).toBe(prior.version); const row = { ...prior, id: id(10 + c.expectedVersion), version: c.expectedVersion + 1, state: c.action === "REVIEW" ? "REVIEWED" as const : "DRAFT" as const, payload: c.payload }; data.assumptions.unshift(row); await route.fulfill({ json: { assumptions: row, idempotentReplay: false } }); });
    function preview() {
        const a=data.assumptions[0]!;
        const snapshot:ProvisionCalculationRow["snapshot"]={
            ...calculateProvision({assumptions:a.payload as ProvisionAssumptions,yearStart:a.year_start,yearEnd:a.year_end,currency:"CAD",bookPreTaxIncome:"1000",priorPostedProvision:"0"}),
            scope:{entityName:"Synthetic company",ledgerCode:"PRIMARY",throughDate:"2025-12-31",currency:"CAD",legalEntityId:id(1),ledgerId:id(2),fiscalYear:2025,periodId:id(3),periodState:"OPEN",periodStart:"2025-01-01",periodEnd:"2025-12-31"},
            assumptions:{id:a.id,version:a.version,state:a.state,payload:a.payload as ProvisionAssumptions,recordedBy:id(4),recordedAt:date},
            mappings:{expense:undefined,payable:undefined,excludedTaxExpenseAccounts:[]},
            sources:{ledgerFingerprint:"a".repeat(32),periods:[],sourceJournals:[],unposted:[],ccaSources:[]},
            liabilityRollforward:{openingCreditBalance:"0",closingCreditBalance:"0",movements:[],unclassifiedMovementCount:0,explanation:"Synthetic reviewed roll-forward"}
        };
        return {sourceHash:"b".repeat(64),snapshot};
    }
    await page.route("**/api/tax/provision/preview?*", route => route.fulfill({ json: preview() }));
    await page.route("**/api/tax/provision/calculations", async (route) => { const c = route.request().postDataJSON(); expect(c).toMatchObject({ periodId: id(3), throughDate: "2025-12-31", assumptionsId: data.assumptions[0]!.id }); const calc = { id: id(20), organization_id: id(9), legal_entity_id: id(1), ledger_id: id(2), period_id: id(3), assumptions_id: c.assumptionsId, fiscal_year: 2025, through_date: c.throughDate, version: 1, snapshot: preview().snapshot, source_hash: preview().sourceHash, command_hash: "c".repeat(64), created_by: id(4), created_at: date } as ProvisionCalculationRow; data.calculations.push(calc); await route.fulfill({ json: { calculation: calc, idempotentReplay: false } }); });
    const actions: string[] = [];
    await page.route("**/api/tax/provision/events", async (route) => { const c = route.request().postDataJSON(); expect(c.sourceHash).toBe("b".repeat(64)); expect(c.expectedVersion).toBe(data.events.length); actions.push(c.action); const event = { id: id(30 + data.events.length), calculation_id: id(20), version: data.events.length + 1, action: c.action, journal_id: c.action === "DRAFT" ? id(40) : null, source_hash: c.sourceHash, command_hash: "d".repeat(64), created_by: id(4), created_at: date, reason: c.reason, journal_status: c.action === "DRAFT" ? "DRAFT" : null, journal_deleted: false }; data.events.push(event); await route.fulfill({ json: { event, idempotentReplay: false } }); });
    await page.goto("/__e2e__/provision");
    await expect(page.getByRole("combobox", { name: "Corporation status", exact: true })).toHaveValue("UNKNOWN");
    await page.getByLabel("Saved assumptions").selectOption(id(10));
    await page.getByLabel("Reason for the next save, review or generation").fill("Synthetic browser review evidence");
    await expect(page.getByRole("button", { name: "Review exact assumptions" })).toBeEnabled();
    await page.getByLabel("Overall assumptions rationale").fill("Changed synthetic reviewed rationale");
    await expect(page.getByRole("button", { name: "Review exact assumptions" })).toBeDisabled();
    await page.getByRole("button", { name: "Save assumptions draft" }).click();
    await page.getByRole("button", { name: "Review exact assumptions" }).click();
    await expect(page.getByText(/Version 3 · REVIEWED/)).toBeVisible();
    await page.getByRole("combobox", { name: "Accounting period", exact: true }).selectOption(id(3));
    await expect(page.getByLabel("YTD through date")).toHaveValue("2025-12-31");
    await page.getByRole("button", { name: "Inspect current sources" }).click();
    await expect(page.getByRole("heading", { name: "Ready for review", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save immutable calculation" }).click();
    await expect(page.getByRole("button", { name: "Generate unposted journal" })).toBeDisabled();
    await page.getByRole("button", { name: "Review this calculation" }).click();
    await page.getByRole("button", { name: "Generate unposted journal" }).click();
    await expect(page.getByRole("link", { name: new RegExp(`Journal ${id(40)} · DRAFT`) })).toBeVisible();
    expect(actions).toEqual(["REVIEW", "DRAFT"]);
});
