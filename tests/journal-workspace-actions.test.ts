import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => {
  const journalRows = [
    {
      id: "30000000-0000-4000-8000-000000000001",
      ledger_id: "30000000-0000-4000-8000-000000000010",
      journal_number: null,
      accounting_date: "2026-08-27",
      entity_code: "CA01",
      functional_currency: "CAD",
      description: "Manual draft",
      journal_type_key: "ledger.manual",
      type_label: "Manual journal",
      owner_module: "ledger",
      correction_route: "/journals",
      status: "DRAFT",
      period_state: "OPEN" as const,
      total_debit_functional: "100.00",
      canonical_account_keys: [
        "CA01.6100.0000.MKT.0000.0000.0000.0000.0000.0000.0000.0000.0000",
      ],
      account_segment_definitions: [
        { key: "subaccount", displayName: "Product", visible: false },
        { key: "department", displayName: "Cost center", visible: true },
        ...Array.from({ length: 8 }, (_, index) => ({
          key: `custom${index + 1}`,
          displayName: `Custom ${index + 1}`,
          visible: false,
        })),
      ],
      source_number: null,
      canonical_content_hash: "a".repeat(64),
      reversal_of_number: null,
      reversed_by_number: null,
    },
    {
      id: "30000000-0000-4000-8000-000000000002",
      ledger_id: "30000000-0000-4000-8000-000000000010",
      journal_number: 41,
      accounting_date: "2026-08-26",
      entity_code: "CA01",
      functional_currency: "CAD",
      description: "Posted manual journal",
      journal_type_key: "ledger.manual",
      type_label: "Manual journal",
      owner_module: "ledger",
      correction_route: "/journals",
      status: "POSTED",
      period_state: "OPEN" as const,
      total_debit_functional: "200.00",
      source_number: null,
      canonical_content_hash: null,
      reversal_of_number: null,
      reversed_by_number: null,
    },
    {
      id: "30000000-0000-4000-8000-000000000003",
      ledger_id: "30000000-0000-4000-8000-000000000010",
      journal_number: 40,
      accounting_date: "2026-08-25",
      entity_code: "CA01",
      functional_currency: "CAD",
      description: "Already reversed manual journal",
      journal_type_key: "ledger.manual",
      type_label: "Manual journal",
      owner_module: "ledger",
      correction_route: "/journals",
      status: "POSTED",
      period_state: "OPEN" as const,
      total_debit_functional: "300.00",
      source_number: null,
      canonical_content_hash: null,
      reversal_of_number: null,
      reversed_by_number: 42,
    },
    {
      id: "30000000-0000-4000-8000-000000000004",
      ledger_id: "30000000-0000-4000-8000-000000000010",
      journal_number: 39,
      accounting_date: "2026-08-24",
      entity_code: "CA01",
      functional_currency: "CAD",
      description: "Posted invoice",
      journal_type_key: "receivables.sales-invoice",
      type_label: "Sales invoice",
      owner_module: "receivables",
      correction_route: "/app/receivables/invoices",
      status: "POSTED",
      period_state: "OPEN" as const,
      total_debit_functional: "400.00",
      source_number: "INV-1001",
      canonical_content_hash: null,
      reversal_of_number: null,
      reversed_by_number: null,
    },
  ];
  const periodRows = [{
    id: "40000000-0000-4000-8000-000000000001",
    ledger_id: "30000000-0000-4000-8000-000000000010",
    entity_code: "CA01",
    label: "August 2026",
    starts_on: "2026-08-01",
    ends_on: "2026-08-31",
    state: "OPEN" as const,
  }];
  const client = {
    query: vi.fn(async (statement: string) => {
      if (statement.includes("FROM organization_memberships membership")) {
        return { rows: [{ is_demo: true }] };
      }
      if (statement.includes("AS entity_count")) {
        return { rows: [{ entity_count: 1, ledger_count: 1, active_key_count: 1 }] };
      }
      if (statement.includes("FROM journal_entries entry")) return { rows: journalRows };
      if (statement.includes("FROM fiscal_periods period")) return { rows: periodRows };
      throw new Error(`Unexpected tenant workspace query: ${statement}`);
    }),
  };
  return {
    client,
    actorHasActivePermission: vi.fn(async () => true),
    principalCanWrite: vi.fn(() => true),
    withTenantTransaction: vi.fn(async (_context: unknown, work: (databaseClient: unknown) => unknown) => work(client)),
  };
});

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/identity/session", () => ({
  hasRecentStepUp: vi.fn(() => false),
  transactionAuthMethod: vi.fn(() => "demo-link"),
}));
vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: mocks.actorHasActivePermission,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  principalCanWrite: mocks.principalCanWrite,
}));

import {
  loadManualJournalOptions,
  loadTenantJournalWorkspace,
} from "@/modules/ledger/tenant-workspace";

const principal: SessionPrincipal = {
  sessionId: "20000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000002",
  organizationId: "20000000-0000-4000-8000-000000000003",
  membershipId: "20000000-0000-4000-8000-000000000004",
  organizationName: "Demo tenant",
  roleLabel: "Accountant",
  displayName: "Demo Accountant",
  initials: "DA",
  sessionMode: "demo",
  authMethod: "DEMO_LINK",
  expiresAt: new Date("2026-08-27T20:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.principalCanWrite.mockReturnValue(true);
  mocks.actorHasActivePermission.mockResolvedValue(true);
});

describe("tenant journal action capabilities", () => {
  it("denies the ledger register before querying accounting data without read permission", async () => {
    mocks.actorHasActivePermission.mockResolvedValueOnce(false);

    await expect(loadTenantJournalWorkspace(principal)).rejects.toThrow("Ledger read permission is required");
    expect(mocks.client.query).toHaveBeenCalledTimes(1);
    expect(mocks.client.query.mock.calls[0]?.[0]).toContain("FROM organization_memberships membership");
  });

  it("denies journal setup options before exposing the chart without read permission", async () => {
    mocks.actorHasActivePermission.mockResolvedValueOnce(false);

    await expect(loadManualJournalOptions(principal)).rejects.toThrow("Ledger read permission is required");
    expect(mocks.client.query).toHaveBeenCalledTimes(1);
  });

  it("authorizes only eligible source-owned states and supplies an optimistic draft hash", async () => {
    const workspace = await loadTenantJournalWorkspace(principal);

    expect(workspace.demoOnly).toBe(true);
    expect(workspace.canPost).toBe(true);
    expect(workspace.canReverse).toBe(true);
    expect(workspace.reversalPeriods).toHaveLength(1);
    expect(workspace.journals.map((journal) => ({
      id: journal.id,
      canPost: journal.canPost,
      canReverse: journal.canReverse,
    }))).toEqual([
      { id: "30000000-0000-4000-8000-000000000001", canPost: true, canReverse: false },
      { id: "30000000-0000-4000-8000-000000000002", canPost: false, canReverse: true },
      { id: "30000000-0000-4000-8000-000000000003", canPost: false, canReverse: false },
      { id: "30000000-0000-4000-8000-000000000004", canPost: false, canReverse: false },
    ]);
    expect(workspace.journals[0]?.expectedContentHash).toBe("a".repeat(64));
    expect(workspace.journals[0]?.accountKeys[0]).toMatchObject({
      canonicalKey: "CA01.6100.0000.MKT.0000.0000.0000.0000.0000.0000.0000.0000.0000",
      displayKey: "CA01.6100.MKT.0000",
      displaySegments: expect.arrayContaining([
        { key: "department", displayName: "Cost center", code: "MKT" },
      ]),
    });
    expect(workspace.journals[3]).toMatchObject({
      ownerModule: "receivables",
      sourceNumber: "INV-1001",
      correctionRoute: "/app/receivables/invoices",
    });
  });

  it("fails closed before row actions when tenant writes are disabled", async () => {
    mocks.principalCanWrite.mockReturnValue(false);
    const workspace = await loadTenantJournalWorkspace(principal);

    expect(workspace.canPost).toBe(false);
    expect(workspace.canReverse).toBe(false);
    expect(workspace.reversalPeriods).toEqual([]);
    expect(workspace.journals.every((journal) => !journal.canPost && !journal.canReverse)).toBe(true);
  });
});
