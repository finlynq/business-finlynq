import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { demoSearchIndex } from "@/modules/demo/dashboard-data";

const mocks = vi.hoisted(() => {
  const principal = {
    sessionId: "20000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    organizationId: "20000000-0000-4000-8000-000000000003",
    membershipId: "20000000-0000-4000-8000-000000000004",
    organizationName: "Second Organization",
    roleLabel: "Owner",
    displayName: "Second Owner",
    initials: "SO",
    sessionMode: "real" as const,
    authMethod: "PASSWORD" as const,
    expiresAt: new Date("2026-08-27T00:00:00Z"),
    mfaVerifiedAt: null,
    stepUpExpiresAt: null,
  };
  return {
    principal,
    requireWorkspacePrincipal: vi.fn(async () => principal),
    currentPrincipal: vi.fn(async () => principal),
    requestPrincipal: vi.fn(async () => principal),
    loadTenantJournalWorkspace: vi.fn(async () => ({
      demoOnly: false,
      readiness: "EMPTY_ORGANIZATION" as const,
      canDraft: false,
      canPost: false,
      canReverse: false,
      reversalPeriods: [],
      journals: [],
    })),
    loadTenantPartyDirectory: vi.fn(async (): Promise<{
      demoOnly: boolean;
      readiness: "EMPTY_ORGANIZATION" | "READY";
      canManage: boolean;
      parties: never[];
    }> => ({
      demoOnly: false,
      readiness: "EMPTY_ORGANIZATION" as const,
      canManage: false,
      parties: [],
    })),
    loadPartyAccountCreationOptions: vi.fn(async (): Promise<readonly Readonly<{
      legalEntityId: string;
      entityCode: string;
      ledgerId: string;
      ledgerCode: string;
      functionalCurrency: string;
      role: "CUSTOMER" | "SUPPLIER";
      controlAccountId: string;
      controlAccountCode: string;
      controlAccountName: string;
    }>[]> => []),
    loadManualJournalOptions: vi.fn(async () => ({
      readOnly: true,
      entities: [],
    })),
    loadPeriodControlWorkspace: vi.fn(async () => ({
      demoOnly: false,
      canClose: false,
      canReopen: false,
      canSeal: false,
      recentStepUp: false,
      periods: [],
    })),
    loadEntitySummaries: vi.fn(async () => ([{
      id: "30000000-0000-4000-8000-000000000001",
      code: "SECOND",
      displayName: "Second Organization LLC",
      countryCode: "US",
      regionCode: "WA",
      accountingProfile: "US_GAAP",
      ledgerId: "30000000-0000-4000-8000-000000000002",
      ledgerCode: "SECOND-PRIMARY",
      functionalCurrency: "USD",
      periodLabel: "August 2026",
      periodState: "OPEN",
    }])),
    loadAccountingOverview: vi.fn(async () => ({
      access: { ledger: true, receivables: true, payables: true, tax: true },
      postedJournalCount: 0,
      unpostedJournalCount: 0,
      manualReviewTaxCount: 0,
      openReceivables: [],
      openPayables: [],
    })),
    loadTrialBalance: vi.fn(async () => []),
    loadTaxDeterminations: vi.fn(async () => []),
    loadSubledgerWorkspace: vi.fn(async (_principal: unknown, ownerModule: "receivables" | "payables") => ({
      ownerModule,
      businessKind: ownerModule === "receivables" ? "SALES_INVOICE" as const : "SUPPLIER_BILL" as const,
      settlementKind: ownerModule === "receivables" ? "CUSTOMER_RECEIPT" as const : "SUPPLIER_PAYMENT" as const,
      demoOnly: false,
      canRead: true,
      canManage: false,
      canPost: false,
      canSettle: false,
      canVoid: false,
      currentDate: "2026-08-27",
      currencies: [],
      entities: [],
      documents: [],
      openItems: [],
    })),
  };
});

vi.mock("@/modules/workspace/access", () => ({
  requireWorkspacePrincipal: mocks.requireWorkspacePrincipal,
}));
vi.mock("@/modules/identity/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/identity/session")>()),
  currentPrincipal: mocks.currentPrincipal,
  requestPrincipal: mocks.requestPrincipal,
}));
vi.mock("@/modules/ledger/tenant-workspace", () => ({
  loadTenantJournalWorkspace: mocks.loadTenantJournalWorkspace,
  loadTenantPartyDirectory: mocks.loadTenantPartyDirectory,
  loadManualJournalOptions: mocks.loadManualJournalOptions,
  loadPeriodControlWorkspace: mocks.loadPeriodControlWorkspace,
}));
vi.mock("@/modules/parties/party-workspace", () => ({
  loadPartyAccountCreationOptions: mocks.loadPartyAccountCreationOptions,
}));
vi.mock("@/modules/reporting/tenant-reporting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/reporting/tenant-reporting")>()),
  loadEntitySummaries: mocks.loadEntitySummaries,
  loadAccountingOverview: mocks.loadAccountingOverview,
  loadTrialBalance: mocks.loadTrialBalance,
  loadTaxDeterminations: mocks.loadTaxDeterminations,
}));
vi.mock("@/modules/subledger/workspace", () => ({
  loadSubledgerWorkspace: mocks.loadSubledgerWorkspace,
}));

import OverviewPage from "@/app/(workspace)/app/page";
import AutomationPage from "@/app/(workspace)/automation/page";
import PeriodClosePage from "@/app/(workspace)/controls/period-close/page";
import EntitiesPage from "@/app/(workspace)/entities/page";
import NewJournalPage from "@/app/(workspace)/journals/new/page";
import JournalsPage from "@/app/(workspace)/journals/page";
import PartiesPage from "@/app/(workspace)/parties/page";
import BillsPage from "@/app/(workspace)/payables/bills/page";
import InvoicesPage from "@/app/(workspace)/receivables/invoices/page";
import { GET as trialBalanceCsv } from "@/app/(workspace)/reports/trial-balance.csv/route";
import TrialBalancePage from "@/app/(workspace)/reports/trial-balance/page";
import TaxPage from "@/app/(workspace)/tax/page";
import { PartyCreateForm } from "@/app/_components/party-create-form.client";
import { WorkspaceShell } from "@/app/_components/workspace-shell";

function serialized(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child === "function") return `[Function ${child.name || "anonymous"}]`;
    if (typeof child === "object" && child !== null) {
      if (seen.has(child)) return "[Circular]";
      seen.add(child);
    }
    return child;
  });
}

function findSearchEntries(value: unknown): readonly { label: string }[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findSearchEntries(child);
      if (found.length > 0) return found;
    }
    return [];
  }
  const candidate = value as { props?: { entries?: readonly { label: string }[]; children?: unknown } };
  if (candidate.props?.entries) return candidate.props.entries;
  return findSearchEntries(candidate.props?.children);
}

describe("real organization workspace isolation", () => {
  const previousBusinessWrites = process.env.BUSINESS_WRITES_ENABLED;

  beforeAll(() => {
    process.env.BUSINESS_WRITES_ENABLED = "true";
  });

  afterAll(() => {
    if (previousBusinessWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
    else process.env.BUSINESS_WRITES_ENABLED = previousBusinessWrites;
  });

  it("executes every workspace page without leaking another organization's fixtures", async () => {
    const pages = await Promise.all([
      OverviewPage(),
      AutomationPage(),
      EntitiesPage({ searchParams: Promise.resolve({}) }),
      BillsPage({ searchParams: Promise.resolve({}) }),
      InvoicesPage({ searchParams: Promise.resolve({}) }),
      TrialBalancePage(),
      TaxPage({ searchParams: Promise.resolve({}) }),
    ]);
    for (const page of pages) {
      const output = serialized(page);
      expect(output).not.toContain("Northstar");
      expect(output).not.toContain("Harbour Dental");
    }
    expect(serialized(pages[0])).toContain("Accounting overview");
    expect(serialized(pages[1])).toContain("AI & MCP access");
    expect(serialized(pages[1])).toContain("demo and standard accounts");
    expect(serialized(pages[2])).toContain("Second Organization LLC");
    expect(serialized(pages[3])).toContain("Accounts payable");
    expect(serialized(pages[4])).toContain("Accounts receivable");
    expect(serialized(pages[5])).toContain("No posted balances");
    expect(serialized(pages[6])).toContain("No recorded tax decisions");
    expect(mocks.loadEntitySummaries).toHaveBeenCalledWith(mocks.principal);
    expect(mocks.loadAccountingOverview).toHaveBeenCalledWith(mocks.principal);
    expect(mocks.loadTrialBalance).toHaveBeenCalledWith(mocks.principal);
    expect(mocks.loadTaxDeterminations).toHaveBeenCalledWith(mocks.principal, { reviewOnly: false });
    expect(mocks.loadSubledgerWorkspace).toHaveBeenCalledWith(mocks.principal, "payables", "");
    expect(mocks.loadSubledgerWorkspace).toHaveBeenCalledWith(mocks.principal, "receivables", "");
  });

  it("executes the real journal and period-control pages only with tenant-scoped DTOs", async () => {
    const [journalDraft, periodControls] = await Promise.all([NewJournalPage(), PeriodClosePage()]);
    const output = serialized([journalDraft, periodControls]);
    expect(output).toContain("Create a manual journal");
    expect(output).toContain("Period controls");
    expect(output).not.toContain("Northstar");
    expect(output).not.toContain("Harbour Dental");
    expect(mocks.loadManualJournalOptions).toHaveBeenCalledWith(mocks.principal);
    expect(mocks.loadPeriodControlWorkspace).toHaveBeenCalledWith(mocks.principal);
  });

  it("executes tenant-backed journal and party pages with only the second organization DTOs", async () => {
    const [journals, parties] = await Promise.all([
      JournalsPage({ searchParams: Promise.resolve({}) }),
      PartiesPage({ searchParams: Promise.resolve({}) }),
    ]);
    expect(serialized(journals)).toContain("Accounting setup is not complete");
    expect(serialized(parties)).toContain("No party found");
    expect(serialized([journals, parties])).not.toContain("Northstar");
    expect(mocks.loadTenantJournalWorkspace).toHaveBeenCalledWith(mocks.principal, "");
    expect(mocks.loadTenantPartyDirectory).toHaveBeenCalledWith(mocks.principal, "");
  });

  it("renders encrypted party creation only when the real tenant role can manage parties", async () => {
    mocks.loadTenantPartyDirectory.mockResolvedValueOnce({
      demoOnly: false,
      readiness: "READY" as const,
      canManage: true,
      parties: [],
    });
    mocks.loadPartyAccountCreationOptions.mockResolvedValueOnce([{
      legalEntityId: "30000000-0000-4000-8000-000000000010",
      entityCode: "SECOND",
      ledgerId: "30000000-0000-4000-8000-000000000011",
      ledgerCode: "SECOND-PRIMARY",
      functionalCurrency: "USD",
      role: "CUSTOMER" as const,
      controlAccountId: "30000000-0000-4000-8000-000000000012",
      controlAccountCode: "1100",
      controlAccountName: "Accounts receivable",
    }]);
    const parties = await PartiesPage({ searchParams: Promise.resolve({}) });
    const children = (parties.props as { children: unknown[] }).children;
    const form = children.find((child) => (
      typeof child === "object" && child !== null && "type" in child && child.type === PartyCreateForm
    )) as { props?: { accountOptions?: readonly { role: string; entityCode: string }[] } } | undefined;
    expect(form?.props?.accountOptions).toEqual([
      expect.objectContaining({ role: "CUSTOMER", entityCode: "SECOND" }),
    ]);
    expect(serialized(parties)).not.toContain("Northstar");
  });

  it("does not place demo records in real-session global search or CSV output", async () => {
    const shell = WorkspaceShell({ children: null, principal: mocks.principal, readOnly: false });
    const searchEntries = findSearchEntries(shell);
    expect(searchEntries.length).toBeGreaterThan(0);
    for (const entry of demoSearchIndex) expect(searchEntries.map((item) => item.label)).not.toContain(entry.title);

    const response = await trialBalanceCsv(new NextRequest("http://localhost/app/reports/trial-balance.csv"));
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain('"Entity","Ledger","Currency"');
    expect(csv).not.toContain("Northstar");
  });
});
