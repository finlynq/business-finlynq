import { build } from "esbuild";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import templateSeed from "../src/modules/tax/templates/canada-t2-corporation-v2.json";
import { taxFilingTemplateDefinitionSchema } from "../src/modules/tax/filing-template";
import type { TaxFilingWorkspaceDto } from "../src/modules/tax/filing-workspace";
import type { TaxFilingReadiness } from "../src/modules/tax/filing-readiness";

const id = (tail: number) => `40000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;

// Mount the production component in Chromium with explicit transport fixtures.
// Actual committed mapping/configuration/posted-ledger behavior is covered by
// tests/db/tax-refresh.integration.test.ts; this checks the user's review flow.
test("browser review: repair mapping, activate configuration and refresh an immutable tax comparison", async ({ page }) => {
  const root = resolve(__dirname, "..");
  const template = { ...templateSeed, definition: taxFilingTemplateDefinitionSchema.parse(templateSeed.definition) };
  const configuration = { id: id(10), legalEntityId: id(1), ledgerId: id(2), registrationId: null,
    filingTypeKey: template.templateKey, templateId: template.id, templateName: template.name, templateVersion: 2,
    mappingSetId: id(11), mappingVersion: 1, version: 1, state: "ACTIVE" as const,
    effectiveFrom: "2025-01-01", effectiveTo: null, supersedesConfigurationId: null, correctionOfConfigurationId: null,
    reason: "Synthetic original configuration", createdBy: id(3), createdAt: "2025-12-31T00:00:00Z", current: true, dependencyCount: 1 };
  let readiness: TaxFilingReadiness = { ready: false, checkedAt: "2026-01-02T00:00:00Z", ledgerFingerprint: "a".repeat(32),
    configuration: { id: id(10), version: 1, templateId: template.id, mappingSetId: id(11), mappingVersion: 1 },
    blockers: [{ code: "MAPPING_COVERAGE_INCOMPLETE", message: "Posted activity from 6200 is missing from book net income. Add it to the mapping and activate the reviewed configuration.", remediationUrl: "/app/tax#tax-mappings" }],
    coverage: { required: true, currentBookNetIncome: "-125.500000000", omittedNetIncome: "-125.500000000",
      unmappedAccounts: [{ id: id(5), code: "6200", name: "Synthetic new expense", accountClass: "EXPENSE", debits: "125.50", credits: "0", netIncome: "-125.50", hasActivity: true }] } };
  let workspace: TaxFilingWorkspaceDto = {
    templates: [template], ledgers: [{ legalEntityId: id(1), entityCode: "SYN", entityName: "Synthetic company", countryCode: "CA", ledgerId: id(2), ledgerCode: "PRIMARY", currencyCode: "CAD" }],
    accounts: [{ id: id(4), ledgerId: id(2), code: "4100", displayName: "Synthetic revenue", accountClass: "REVENUE" }, { id: id(5), ledgerId: id(2), code: "6200", displayName: "Synthetic new expense", accountClass: "EXPENSE" }],
    mappingVersions: [{ mappingSetId: id(11), ledgerId: id(2), templateId: template.id, mappingVersion: 1, state: "ACTIVE", effectiveFrom: "2025-01-01" }],
    mappings: [{ mappingSetId: id(11), mappingVersion: 1, legalEntityId: id(1), ledgerId: id(2), templateId: template.id,
      fieldKey: "wp_book_net_income", glAccountId: id(4), accountCode: "4100", accountName: "Synthetic revenue", balanceBasis: "NET_CREDIT", multiplier: "1.000000", reason: "Synthetic mapping", createdAt: "2025-01-01T00:00:00Z" }],
    configurations: [configuration], registrations: [], canManageMappings: true, canPrepareFilings: true, canManageConfigurations: true, canManageCanonical: false,
    filings: [{ id: id(20), legalEntityId: id(1), ledgerId: id(2), entityCode: "SYN", ledgerCode: "PRIMARY", templateId: template.id, templateName: template.name, templateVersion: 2,
      mappingSetId: id(11), mappingVersion: 1, configurationId: id(10), configurationVersion: 1,
      capturedAt: "2025-12-31T00:00:00Z", createdAt: "2025-12-31T00:00:00Z", filingType: "HISTORICAL_IMPORT", status: "REVIEW_REQUIRED",
      periodStart: "2025-01-01", periodEnd: "2025-12-31", externalReference: "SYNTHETIC-ORIGINAL", sourceFileName: "synthetic.csv",
      manualValues: { wp_schedule_1_additions: "0", wp_schedule_1_deductions: "3.25" }, reportedValues: { line_300: "0" }, manualInputsNeedReview: false,
      refreshedFromFilingId: null, freshness: { mayBeStale: true, reasons: ["Later posted expense"], readiness }, reconciliation: [], validations: [] }],
  };
  const result = await build({ absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", outfile: "tax-refresh.js", loader: { ".css": "local-css" },
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import { useEffect, useState } from "react"; import { createRoot } from "react-dom/client";
      import { TaxWorkpaperControls } from "@/app/_components/tax-workpaper-controls.client";
      import { TaxFilingWorkspace } from "@/app/_components/tax-filing-workspace.client";
      function Fixture() { const [workspace, setWorkspace] = useState(null);
        useEffect(() => { const refresh = () => fetch('/__e2e__/tax-state').then(r => r.json()).then(setWorkspace);
          window.addEventListener('tax-refresh', refresh); refresh(); return () => window.removeEventListener('tax-refresh', refresh); }, []);
        return workspace ? <><TaxFilingWorkspace workspace={workspace} refreshFilingId="${id(20)}" /><TaxWorkpaperControls filingId="${id(30)}" canManage={true}/></> : <p>Loading</p>; }
      createRoot(document.getElementById('root')).render(<Fixture />);` },
    plugins: [{ name: "tax-navigation-boundary", setup(bundler) {
      bundler.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "tax-boundary" }));
      bundler.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "tax-boundary" }));
      bundler.onLoad({ filter: /.*/, namespace: "tax-boundary" }, (args) => ({ resolveDir: root, loader: "tsx", contents: args.path === "link"
        ? 'import { createElement } from "react"; export default function Link(props) { return createElement("a", props); }'
        : 'export function useRouter() { return { refresh() { window.dispatchEvent(new Event("tax-refresh")); } }; }' }));
    } }],
  });
  const js = result.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
  await page.route("**/__e2e__/tax-state", (route) => route.fulfill({ json: workspace }));
  await page.route("**/__e2e__/tax-refresh", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>body{font-family:Arial;padding:20px}input,textarea,select{display:block;margin:8px}${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>` }));
  await page.route("**/api/tax/filings/preview?*", (route) => route.fulfill({ json: readiness }));
  const drafts=new Map<string, Record<string, unknown>>();
  let refreshed=false;
  await page.route("**/api/tax/drafts",async route=>{
    const command=route.request().postDataJSON();const prior=drafts.get(command.draftId);
    const input=command.payload??prior?.payload;
    const row={...prior,id:id(100+drafts.size),draft_id:command.draftId,version:command.expectedVersion+1,kind:command.kind,
      state:command.action==="LOCK"?"LOCKED":command.action==="REVIEW"?"REVIEWED":"DRAFT",payload:input,
      review:command.action==="SAVE"?null:{after:input,warnings:["Review lock does not file a return or close an accounting period."]},
      review_hash:command.action==="SAVE"?null:"a".repeat(64),result:null as unknown,created_by:id(3),created_at:"2026-01-02T00:00:00Z",reason:command.reason};
    if(command.action==="LOCK"){
      expect(command.reviewHash).toBe("a".repeat(64));
      if(command.kind==="MAPPING"){
        expect(input).toMatchObject({expectedMappingVersion:1,effectiveFrom:"2025-01-03",mappings:[
          {fieldKey:"wp_book_net_income",glAccountId:id(4),balanceBasis:"NET_CREDIT",multiplier:"1"},
          {fieldKey:"wp_book_net_income",glAccountId:id(5),balanceBasis:"NET_CREDIT",multiplier:"1"}]});
        workspace={...workspace,mappingVersions:[{...workspace.mappingVersions[0]!,mappingSetId:id(12),mappingVersion:2,effectiveFrom:"2025-01-03"}],
          mappings:[id(4),id(5)].map(accountId=>({...workspace.mappings[0]!,mappingSetId:id(12),mappingVersion:2,glAccountId:accountId}))};
        readiness={...readiness,blockers:[{code:"CONFIGURATION_MAPPING_OUTDATED",message:"Configuration v1 still pins mapping v1. Review and activate mapping v2.",remediationUrl:"/app/tax#tax-configuration"}]};
        row.result={mappingSetId:id(12),version:2};
      }else if(command.kind==="CONFIGURATION"){
        expect(input).toMatchObject({expectedConfigurationVersion:1,mappingSetId:id(12),templateId:template.id,effectiveFrom:"2025-01-03"});
        workspace={...workspace,configurations:[{...configuration,current:false},{...configuration,id:id(13),version:2,mappingSetId:id(12),mappingVersion:2,effectiveFrom:"2025-01-03"}]};
        readiness={...readiness,ready:true,configuration:{...readiness.configuration!,id:id(13),version:2,mappingSetId:id(12),mappingVersion:2},blockers:[],coverage:{...readiness.coverage,omittedNetIncome:"0.000000000",unmappedAccounts:[]}};
        row.result={configurationId:id(13),version:2};
      }else{
        expect(input).toMatchObject({refreshFromFilingId:id(20),configurationId:id(13),filingType:"HISTORICAL_IMPORT",externalReference:"SYNTHETIC-ORIGINAL",sourceFileName:"synthetic.csv",reportedValues:{line_300:"0"},manualValues:{wp_schedule_1_additions:"0",wp_schedule_1_deductions:"3.25"}});
        expect(input.reportedValues).not.toHaveProperty("line_360");refreshed=true;row.result={filingId:id(21),status:"REVIEW_REQUIRED",varianceCount:1};
      }
    }
    drafts.set(command.draftId,row);await route.fulfill({status:201,json:{draft:row,idempotentReplay:false}});
  });
  let hidden=false,controlVersion=1;
  await page.route("**/api/tax/filings/controls/preview?*",route=>route.fulfill({json:{workpaper:{id:id(30),filingType:"PREPARED",entityName:"Synthetic unfiled draft",periodStart:"2025-03-01",periodEnd:"2025-03-31"},version:controlVersion,deleted:hidden,events:[],dependencies:[],eligible:true,reasons:[],previewHash:"b".repeat(64),submissionState:"Confirm this draft is unfiled.",retention:"Snapshot retained; restoring never makes the draft canonical."}}));
  await page.route("**/api/tax/filings/controls",async route=>{
    const command=route.request().postDataJSON();expect(command).toMatchObject({filingId:id(30),expectedVersion:controlVersion,previewHash:"b".repeat(64)});
    expect(command.confirmation).toBe(`${command.action} ${id(30)}${command.action==="DELETE"?" UNFILED":""}`);
    hidden=command.action==="DELETE";controlVersion++;await route.fulfill({status:201,json:{event:{version:controlVersion},idempotentReplay:false}});
  });
  await page.goto("/__e2e__/tax-refresh#tax-workpaper");
  await expect(page.getByRole("button", { name: "Save workpaper draft" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Current tax mapping coverage" })).toContainText("6200");
  await page.getByRole("tab", { name: "Account mappings", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Book net income or loss" }).click();
  await page.getByRole("group", { name: "WP-BOOK Book net income or loss *", exact: true }).getByLabel("Ledger accounts").selectOption([id(4), id(5)]);
  await page.getByLabel("Mapping effective from").fill("2025-01-02");
  await page.getByLabel("Change reason", { exact: true }).fill("Include synthetic posted expense");
  await page.getByRole("button", { name: "Save mapping draft" }).click();
  await expect(page.getByText(/Mapping draft saved/)).toBeVisible();
  await page.getByRole("button",{name:"Review changes",exact:true}).click();
  await expect(page.getByRole("button",{name:"Lock version",exact:true})).toBeEnabled();
  await page.getByLabel("Mapping effective from").fill("2025-01-03");
  await expect(page.getByRole("button",{name:"Lock version",exact:true})).toBeDisabled();
  await page.getByRole("tab",{name:"Prepare or reconcile",exact:true}).click();
  await expect(page.getByLabel("Period start",{exact:true})).toHaveValue("2025-01-01");
  await page.getByRole("tab",{name:"Account mappings",exact:true}).click();
  await expect(page.getByLabel("Mapping effective from")).toHaveValue("2025-01-03");
  await page.getByRole("button",{name:"Save mapping draft",exact:true}).click();
  await page.getByRole("button",{name:"Review changes",exact:true}).click();
  await page.getByRole("button",{name:"Lock version",exact:true}).click();
  await expect(page.getByRole("button",{name:"Create corrected version",exact:true})).toBeVisible();
  await page.getByRole("tab", { name: "Filing configuration", exact: true }).click();
  await page.getByLabel("Effective from", { exact: true }).fill("2025-01-03");
  await page.getByLabel("Configuration reason").fill("Activate reviewed synthetic mapping");
  await page.getByRole("button", { name: "Save configuration draft" }).click();
  await expect(page.getByText(/Configuration draft saved/)).toBeVisible();
  await page.getByRole("button",{name:"Review changes",exact:true}).click();
  await page.getByRole("button",{name:"Lock version",exact:true}).click();
  await expect(page.getByRole("button",{name:"Create corrected version",exact:true})).toBeVisible();
  await page.getByRole("tab", { name: "Prepare or reconcile", exact: true }).click();
  await expect(page.getByLabel("Filing reference", { exact: true })).toHaveValue("SYNTHETIC-ORIGINAL");
  await expect(page.getByRole("button", { name: "Save workpaper draft" })).toBeEnabled();
  await page.getByRole("button", { name: "Save workpaper draft" }).click();
  await expect(page.getByText(/Workpaper input draft saved/)).toBeVisible();
  await page.getByRole("button",{name:"Review changes",exact:true}).click();
  await page.getByRole("button",{name:"Lock version",exact:true}).click();
  await expect(page.getByRole("button",{name:"Create corrected version",exact:true})).toBeVisible();
  expect(refreshed).toBe(true);
  await page.getByRole("button",{name:"Review lock and cleanup eligibility",exact:true}).click();
  const controls=page.getByRole("region",{name:"Exact workpaper review"});
  await expect(controls.getByRole("button",{name:"Delete draft",exact:true})).toBeDisabled();
  await controls.getByLabel("Reason",{exact:true}).fill("Synthetic incorrect unfiled preparation");
  await controls.getByLabel(/Confirm exact record and action/).fill(`DELETE ${id(30)} UNFILED`);
  await controls.getByRole("button",{name:"Delete draft",exact:true}).click();
  await expect(controls).not.toBeVisible();expect(hidden).toBe(true);
  await page.getByRole("button",{name:"Review lock and cleanup eligibility",exact:true}).click();
  await controls.getByLabel(/Confirm exact record and action/).fill(`RESTORE ${id(30)}`);
  await controls.getByRole("button",{name:"Restore draft",exact:true}).click();
  await expect(controls).not.toBeVisible();expect(hidden).toBe(false);
});
