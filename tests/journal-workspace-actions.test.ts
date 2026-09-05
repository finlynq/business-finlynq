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
  const accountPostingRows = [{
    journal_entry_id: "30000000-0000-4000-8000-000000000001",
    canonical_key: "CA01.6100.0000.MKT.0000.0000.0000.0000.0000.0000.0000.0000.0000",
    debit_functional: "100.00",
    credit_functional: "0.00",
    ending_balance_functional: "475.00",
    ending_side: "DEBIT" as const,
  }];
  const manualEntityPeriodRows = [
    {
      entity_id: "30000000-0000-4000-8000-000000000020",
      entity_code: "CA01",
      ledger_id: "30000000-0000-4000-8000-000000000010",
      functional_currency: "CAD",
      period_id: "40000000-0000-4000-8000-000000000001",
      period_label: "August 2026",
      starts_on: "2026-08-01",
      ends_on: "2026-08-31",
      period_state: "OPEN" as const,
    },
    {
      entity_id: "30000000-0000-4000-8000-000000000020",
      entity_code: "CA01",
      ledger_id: "30000000-0000-4000-8000-000000000010",
      functional_currency: "CAD",
      period_id: "40000000-0000-4000-8000-000000000002",
      period_label: "September 2026",
      starts_on: "2026-09-01",
      ends_on: "2026-09-30",
      period_state: "ADJUSTMENT_ONLY" as const,
    },
  ];
  const manualAccountRows = [
    {
      entity_id: "30000000-0000-4000-8000-000000000020",
      combination_id: "30000000-0000-4000-8000-000000000021",
      account_code: "1000",
      account_name: "Cash",
      valid_from: "2026-01-01",
      valid_to: null,
    },
    {
      entity_id: "30000000-0000-4000-8000-000000000020",
      combination_id: "30000000-0000-4000-8000-000000000022",
      account_code: "6100",
      account_name: "Office expense",
      valid_from: "2026-09-01",
      valid_to: null,
    },
  ];
  const client = {
    query: vi.fn(async (statement: string, _params?: readonly unknown[]) => {
      void _params;
      if (statement.includes("FROM organization_memberships membership")) {
        return { rows: [{ is_demo: true }] };
      }
      if (statement.includes("AS entity_count")) {
        return { rows: [{ entity_count: 1, ledger_count: 1, active_key_count: 1 }] };
      }
      if (statement.includes("SELECT entity.id AS entity_id, entity.code AS entity_code") &&
          statement.includes("LEFT JOIN fiscal_periods period")) {
        return { rows: manualEntityPeriodRows };
      }
      if (statement.includes("SELECT entity.id AS entity_id, combination.id AS combination_id")) {
        return { rows: manualAccountRows };
      }
      if (statement.includes("WITH current_postings AS")) return { rows: accountPostingRows };
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

  it("loads manual-journal periods and accounts without a periods-by-accounts cartesian query", async () => {
    const options = await loadManualJournalOptions(principal, "2026-08-27");

    expect(options).toEqual({
      evaluatedAccountingDate: "2026-08-27",
      readOnly: false,
      entities: [{
        id: "30000000-0000-4000-8000-000000000020",
        code: "CA01",
        ledgerId: "30000000-0000-4000-8000-000000000010",
        currency: "CAD",
        periods: [
          {
            id: "40000000-0000-4000-8000-000000000001",
            label: "August 2026",
            startsOn: "2026-08-01",
            endsOn: "2026-08-31",
            state: "OPEN",
          },
          {
            id: "40000000-0000-4000-8000-000000000002",
            label: "September 2026",
            startsOn: "2026-09-01",
            endsOn: "2026-09-30",
            state: "ADJUSTMENT_ONLY",
          },
        ],
        accounts: [
          {
            combinationId: "30000000-0000-4000-8000-000000000021",
            code: "1000",
            displayName: "Cash",
            validFrom: "2026-01-01",
            validTo: null,
            validOnAccountingDate: true,
          },
          {
            combinationId: "30000000-0000-4000-8000-000000000022",
            code: "6100",
            displayName: "Office expense",
            validFrom: "2026-09-01",
            validTo: null,
            validOnAccountingDate: false,
          },
        ],
      }],
    });
    const accountingQueries = mocks.client.query.mock.calls
      .map(([statement]) => String(statement))
      .filter((statement) => statement.includes("FROM legal_entities entity"));
    expect(accountingQueries).toHaveLength(2);
    expect(accountingQueries[0]).toContain("LEFT JOIN fiscal_periods period");
    expect(accountingQueries[0]).not.toContain("account_combinations");
    expect(accountingQueries[1]).toContain("JOIN account_combinations combination");
    expect(accountingQueries[1]).not.toContain("fiscal_periods");
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
    expect(workspace.journals[0]?.accountPostings[0]).toMatchObject({
      displayKey: "CA01.6100.MKT.0000",
      debitFunctional: "100.00",
      creditFunctional: "0.00",
      endingBalanceFunctional: "475.00",
      endingSide: "DEBIT",
    });
    const postingQuery = mocks.client.query.mock.calls.find(([statement]) => (
      String(statement).includes("WITH current_postings AS")
    ));
    expect(postingQuery?.[0]).not.toContain("account.class::text AS account_class");
    expect(postingQuery?.[0]).toContain("history_line.debit_functional - history_line.credit_functional");
    expect(postingQuery?.[0]).toContain("account_balance.net_functional > 0 THEN 'DEBIT'");
    expect(postingQuery?.[0]).toContain("account_balance.net_functional < 0 THEN 'CREDIT'");
    expect(postingQuery?.[0]).toContain("abs(account_balance.net_functional)::text");
    expect(postingQuery?.[0]).toContain("history_entry.status = 'POSTED'");
    expect(postingQuery?.[0]).toContain("history_entry.accounting_date <= current_entry.accounting_date");
    expect(postingQuery?.[1]).toEqual([
      principal.organizationId,
      workspace.journals.map((journal) => journal.id),
    ]);
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
