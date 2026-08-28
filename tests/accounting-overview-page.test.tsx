import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const principal = {
    organizationName: "Scope tenant",
    sessionMode: "real" as const,
  };
  const entities = [
    {
      id: "30000000-0000-4000-8000-000000000001",
      code: "CA01",
      displayName: "Canada Company",
      countryCode: "CA",
      regionCode: "ON",
      accountingProfile: "CAN_GAAP_ASPE",
      ledgerId: "30000000-0000-4000-8000-000000000011",
      ledgerCode: "CA01-PRIMARY",
      functionalCurrency: "CAD",
      periodLabel: "August 2026",
      periodState: "OPEN",
    },
    {
      id: "30000000-0000-4000-8000-000000000002",
      code: "US01",
      displayName: "United States Company",
      countryCode: "US",
      regionCode: "WA",
      accountingProfile: "US_GAAP_NONPUBLIC",
      ledgerId: "30000000-0000-4000-8000-000000000012",
      ledgerCode: "US01-PRIMARY",
      functionalCurrency: "USD",
      periodLabel: "August 2026",
      periodState: "OPEN",
    },
  ];
  return {
    principal,
    entities,
    requireWorkspacePrincipal: vi.fn(async () => principal),
    currentWorkspaceEntityContext: vi.fn(async () => ({
      options: entities.map((entity) => ({
        id: entity.id,
        code: entity.code,
        displayName: entity.displayName,
        functionalCurrency: entity.functionalCurrency,
        periodLabel: entity.periodLabel,
        periodState: entity.periodState,
      })),
      selectedEntity: {
        id: entities[0]!.id,
        code: entities[0]!.code,
        displayName: entities[0]!.displayName,
        functionalCurrency: entities[0]!.functionalCurrency,
        periodLabel: entities[0]!.periodLabel,
        periodState: entities[0]!.periodState,
      },
    })),
    loadAccountingOverview: vi.fn(async () => ({
      access: { ledger: true, receivables: true, payables: true, tax: true },
      postedJournalCount: 2,
      unpostedJournalCount: 1,
      taxDecisionCount: 2,
      manualReviewTaxCount: 0,
      openReceivables: [{ currency: "CAD", amount: "125" }],
      openPayables: [{ currency: "CAD", amount: "45" }],
    })),
    loadEntitySummaries: vi.fn(async () => entities),
  };
});

vi.mock("@/modules/workspace/access", () => ({
  requireWorkspacePrincipal: mocks.requireWorkspacePrincipal,
}));
vi.mock("@/modules/workspace/entity-context", () => ({
  currentWorkspaceEntityContext: mocks.currentWorkspaceEntityContext,
}));
vi.mock("@/modules/reporting/tenant-reporting", () => ({
  loadAccountingOverview: mocks.loadAccountingOverview,
  loadEntitySummaries: mocks.loadEntitySummaries,
}));

import OverviewPage from "@/app/(workspace)/app/page";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("accounting overview entity scope", () => {
  it("uses the persisted working entity by default and filters entity panels", async () => {
    const markup = renderToStaticMarkup(await OverviewPage());

    expect(mocks.loadAccountingOverview).toHaveBeenCalledWith(
      mocks.principal,
      mocks.entities[0]!.id,
    );
    expect(markup).toContain("CA01 · Canada Company");
    expect(markup).toContain("Canada Company");
    expect(markup).not.toContain("United States Company");
    expect(markup).toContain('href="/app?scope=all"');
  });

  it("loads the organization scope only after the explicit All entities choice", async () => {
    const markup = renderToStaticMarkup(await OverviewPage({
      searchParams: Promise.resolve({ scope: "all" }),
    }));

    expect(mocks.loadAccountingOverview).toHaveBeenCalledWith(mocks.principal, null);
    expect(markup).toContain("All entities");
    expect(markup).toContain("Canada Company");
    expect(markup).toContain("United States Company");
    expect(markup).toContain("currencies shown separately");
  });
});
