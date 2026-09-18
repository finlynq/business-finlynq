import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReportSelection } from "@/modules/reporting/tenant-reporting";
import type { SessionPrincipal } from "@/modules/identity/session";

vi.mock("next/navigation", () => ({ usePathname: () => "/app", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { CompactDisclosure } from "@/app/_components/compact-disclosure.client";
import { ExpandableTableRow } from "@/app/_components/expandable-table-row.client";
import { ReportRangeFields } from "@/app/_components/report-range-fields.client";
import { WorkspaceShell } from "@/app/_components/workspace-shell";
import { EntityRegister } from "@/app/_components/entity-register";

const selection: ReportSelection = {
  entityId: "entity", entityCode: "CA01", entityName: "Canada", ledgerId: "ledger", ledgerCode: "PRIMARY", currency: "CAD",
  basis: "period", fromDate: "2026-01-01", toDate: "2026-01-31", fromPeriodId: "period", toPeriodId: "period", accountId: null,
};
const periods = [{ id: "period", label: "January 2026", startsOn: "2026-01-01", endsOn: "2026-01-31" }];
const entity = { id: "entity", code: "CA01", displayName: "Canada", countryCode: "CA", regionCode: "ON", accountingProfile: "CAN_ASPE", ledgerId: "ledger", ledgerCode: "PRIMARY", functionalCurrency: "CAD", periodLabel: "January 2026", periodState: "OPEN" };

describe("compact presentation without hidden accounting state", () => {
  it("keeps closed disclosure fields mounted and preserves initial-open onboarding", () => {
    const markup = renderToStaticMarkup(<CompactDisclosure summary="Add entity"><input name="draft" defaultValue="Unfinished value" required /></CompactDisclosure>);
    expect(markup).toContain("<details");
    expect(markup).not.toContain('open=""');
    expect(markup).toContain('<summary>Add entity</summary>');
    expect(markup).toContain('value="Unfinished value"');
    expect(markup).toContain('required=""');
    expect(renderToStaticMarkup(<CompactDisclosure summary="First setup" defaultOpen><p>Setup controls</p></CompactDisclosure>)).toContain('open=""');
  });

  it("retains full evidence and forms in a hidden full-width table row", () => {
    const markup = renderToStaticMarkup(<table><tbody><ExpandableTableRow columns={3} label="journal evidence" cells={<><td>J-42</td><td>CAD 100.00</td></>}><input defaultValue="Draft reason" /><p>CAD 475.00 ending balance</p></ExpandableTableRow></tbody></table>);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls=');
    expect(markup).toContain('class="expanded-row" hidden=""');
    expect(markup).toContain('colSpan="3"');
    expect(markup).toContain('value="Draft reason"');
    expect(markup).toContain("CAD 475.00 ending balance");
  });

  it.each(["period", "date"] as const)("shows only the selected %s range pair without dropping form parameters", (basis) => {
    const markup = renderToStaticMarkup(<ReportRangeFields periods={periods} selection={{ ...selection, basis }} />);
    expect(markup.match(/hidden=""/g)).toHaveLength(2);
    for (const name of ["basis", "fromPeriod", "toPeriod", "from", "to"]) expect(markup).toContain(`name="${name}"`);
    expect(markup).toContain(`value="${basis}" selected=""`);
    expect(markup).toContain('value="2026-01-01"');
    expect(markup).toContain('value="2026-01-31"');
  });

  it("uses one mobile navigation trigger and retains scope and session warnings", () => {
    const principal: SessionPrincipal = { sessionId: "session", userId: "user", organizationId: "organization", membershipId: "membership", organizationName: "Shared tenant", roleLabel: "Accountant", displayName: "Demo", initials: "DA", sessionMode: "demo", authMethod: "DEMO_LINK", expiresAt: new Date("2026-09-19T00:00:00Z"), mfaVerifiedAt: null, stepUpExpiresAt: null };
    const markup = renderToStaticMarkup(<WorkspaceShell principal={principal} readOnly={false} entityContext={{ options: [entity], selectedEntity: entity }}><h1>Overview</h1></WorkspaceShell>);
    expect(markup.match(/aria-label="Open navigation"/g)).toHaveLength(1);
    expect(markup).toContain("Working legal entity");
    expect(markup).toContain("CAD");
    expect(markup).toContain("January 2026 · OPEN");
    expect(markup).toContain("Synthetic demo data · do not enter real information");
    expect(markup).not.toContain('class="mobile-bar"');
  });

  it("retains full entity and period context in desktop and mobile presentations", () => {
    const markup = renderToStaticMarkup(<EntityRegister entities={[entity]} />);
    for (const text of ["CA01", "Canada", "PRIMARY", "CAD", "January 2026", "OPEN", "CAN ASPE"]) expect(markup).toContain(text);
    expect(markup).toContain("entity-register-table");
    expect(markup).toContain("entity-register-cards");
  });

  it("defines compact chrome with touch overrides and safe auth breakpoints", () => {
    const compact = readFileSync("src/app/compact.css", "utf8");
    const auth = readFileSync("src/app/(auth)/auth.module.css", "utf8");
    expect(compact).toContain("--workspace-rail:232px");
    expect(compact).toContain(".form-panel { padding-bottom:0; }");
    expect(compact).toContain(".mobile-bar { display:none; }");
    expect(compact).toContain("@media(pointer:coarse),(max-width:860px)");
    expect(compact).toContain(".expanded-row[hidden] { display:none; }");
    expect(auth).toContain("@media(max-width:980px)");
  });
});
