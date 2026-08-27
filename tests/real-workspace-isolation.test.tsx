import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
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
    loadManualJournalOptions: vi.fn(async () => ({
      readOnly: true,
      entities: [],
    })),
    loadPeriodControlWorkspace: vi.fn(async () => ({
      canClose: false,
      canReopen: false,
      canSeal: false,
      recentStepUp: false,
      periods: [],
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
  return JSON.stringify(value);
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
  it("executes every fixture-backed page as an explicit unavailable state for a second organization", async () => {
    const pages = await Promise.all([
      OverviewPage(),
      AutomationPage(),
      EntitiesPage({ searchParams: Promise.resolve({}) }),
      BillsPage({ searchParams: Promise.resolve({}) }),
      InvoicesPage({ searchParams: Promise.resolve({}) }),
      TrialBalancePage(),
      TaxPage({ searchParams: Promise.resolve({}) }),
    ]);
    const moduleNames = ["Overview", "AI and MCP", "Legal entities", "Accounts payable", "Accounts receivable", "Trial balance", "Tax"];
    for (const [index, page] of pages.entries()) {
      const output = serialized(page);
      expect(output).toContain(`\"moduleName\":\"${moduleNames[index]}\"`);
      expect(output).not.toContain("Northstar");
      expect(output).not.toContain("Harbour Dental");
    }
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
    const parties = await PartiesPage({ searchParams: Promise.resolve({}) });
    const children = (parties.props as { children: unknown[] }).children;
    expect(children.some((child) => (
      typeof child === "object" && child !== null && "type" in child && child.type === PartyCreateForm
    ))).toBe(true);
    expect(serialized(parties)).not.toContain("Northstar");
  });

  it("does not place demo records in real-session global search or CSV output", async () => {
    const shell = WorkspaceShell({ children: null, principal: mocks.principal, readOnly: false });
    const searchEntries = findSearchEntries(shell);
    expect(searchEntries.length).toBeGreaterThan(0);
    for (const entry of demoSearchIndex) expect(searchEntries.map((item) => item.label)).not.toContain(entry.title);

    const response = await trialBalanceCsv(new NextRequest("http://localhost/app/reports/trial-balance.csv"));
    expect(response.status).toBe(501);
    expect(await response.text()).not.toContain("Northstar");
  });
});
