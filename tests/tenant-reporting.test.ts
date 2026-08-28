import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transactionContexts: [] as unknown[],
  assertPermission: vi.fn<(
    client: unknown,
    request: Readonly<{ organizationId: string; actorId: string; permission: string }>,
  ) => Promise<void>>(async () => undefined),
  hasPermission: vi.fn<(
    client: unknown,
    request: Readonly<{ organizationId: string; actorId: string; permission: string }>,
  ) => Promise<boolean>>(async () => true),
  query: vi.fn<(sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>>(
    async () => ({ rows: [] }),
  ),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: async (
    context: unknown,
    work: (client: Readonly<{ query: typeof mocks.query }>) => Promise<unknown>,
  ) => {
    mocks.transactionContexts.push(context);
    return work({ query: mocks.query });
  },
}));

vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: mocks.hasPermission,
  assertActorHasActivePermission: mocks.assertPermission,
}));

vi.mock("@/modules/identity/session", () => ({
  transactionAuthMethod: vi.fn(() => "demo-link"),
}));

import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  balanceSheetRows,
  financialStatementDisplayLines,
  loadEffectiveAccountHierarchy,
  loadAccountingOverview,
  loadTaxDeterminations,
  loadTrialBalance,
  profitAndLossRows,
  reportSearchParams,
  resolveReportSelection,
  trialBalanceCsv,
  type ReportDimensions,
  type ReportSelection,
  type TrialBalanceRow,
} from "@/modules/reporting/tenant-reporting";

const principal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Reporting tenant",
  roleLabel: "Auditor",
  displayName: "Demo auditor",
  initials: "DA",
  sessionMode: "demo" as const,
  authMethod: "DEMO_LINK" as const,
  expiresAt: new Date("2026-08-28T00:00:00.000Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

beforeEach(() => {
  mocks.transactionContexts.length = 0;
  mocks.assertPermission.mockClear();
  mocks.hasPermission.mockReset();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.query.mockReset();
  mocks.query.mockResolvedValue({ rows: [] });
});

describe("tenant reporting authorization and tax exception evidence", () => {
  it("requires the existing least-privilege ledger read permission and propagates demo mode", async () => {
    await loadTrialBalance(principal);

    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readMcpLedger,
    });
    expect(mocks.transactionContexts[0]).toEqual(expect.objectContaining({
      organizationId: principal.organizationId,
      actorId: principal.userId,
      sessionMode: "demo",
    }));
  });

  it("checks permission for every data class summarized by the accounting overview", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ posted: 0, unposted: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total: 4, manual_review: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const overview = await loadAccountingOverview(principal);

    expect(mocks.hasPermission.mock.calls.map((call) => call[1]?.permission)).toEqual([
      PERMISSIONS.readMcpLedger,
      PERMISSIONS.readReceivables,
      PERMISSIONS.readPayables,
      PERMISSIONS.readTax,
    ]);
    expect(overview.taxDecisionCount).toBe(4);
    expect(overview.manualReviewTaxCount).toBe(0);
    expect(mocks.query.mock.calls[1]?.[0]).toContain("current_draft_decisions");
  });

  it("scopes every overview data class to the validated working entity when one is selected", async () => {
    const entityId = "10000000-0000-4000-8000-000000000020";
    mocks.query
      .mockResolvedValueOnce({ rows: [{ posted: 2, unposted: 1 }] })
      .mockResolvedValueOnce({ rows: [{ total: 3, manual_review: 1 }] })
      .mockResolvedValueOnce({ rows: [{ role: "CUSTOMER", currency: "CAD", amount: "75.00" }] });

    const overview = await loadAccountingOverview(principal, entityId);

    expect(overview).toMatchObject({
      postedJournalCount: 2,
      unpostedJournalCount: 1,
      taxDecisionCount: 3,
      manualReviewTaxCount: 1,
      openReceivables: [{ currency: "CAD", amount: "75.00" }],
    });
    expect(mocks.query.mock.calls[0]?.[0]).toContain("legal_entity_id = $2::uuid");
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([principal.organizationId, entityId]);
    expect(mocks.query.mock.calls[1]?.[0]).toContain("source.legal_entity_id = $2::uuid");
    expect(mocks.query.mock.calls[1]?.[0]).toContain("snapshot.legal_entity_id = $2::uuid");
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([principal.organizationId, entityId]);
    expect(mocks.query.mock.calls[2]?.[0]).toContain("account.legal_entity_id = $4::uuid");
    expect(mocks.query.mock.calls[2]?.[1]).toEqual([principal.organizationId, true, true, entityId]);
  });

  it("queries and returns only the overview metrics allowed to a scoped role", async () => {
    mocks.hasPermission.mockImplementation(async (_client, request) => (
      request.permission === PERMISSIONS.readReceivables
    ));
    mocks.query.mockResolvedValueOnce({ rows: [{ role: "CUSTOMER", currency: "USD", amount: "25.00" }] });

    const overview = await loadAccountingOverview(principal);

    expect(overview.access).toEqual({
      ledger: false,
      receivables: true,
      payables: false,
      tax: false,
    });
    expect(overview.openReceivables).toEqual([{ currency: "USD", amount: "25.00" }]);
    expect(overview.openPayables).toEqual([]);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([principal.organizationId, true, false, null]);
  });

  it("surfaces immutable current-draft manual-review decisions through the tax queue", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: "10000000-0000-4000-8000-000000000010:draft-tax:1",
      entity_code: "US01",
      ledger_code: "PRIMARY",
      source_document_id: "10000000-0000-4000-8000-000000000010",
      source_type: "receivables.sales-invoice",
      source_number: "INV-WA-REVIEW",
      source_status: "DRAFT",
      status: "MANUAL_REVIEW_REQUIRED",
      rule_key: "unsupported-or-incomplete",
      jurisdiction: "US-WA",
      currency: "USD",
      taxable_basis: "100.00",
      total_tax: "0.00",
      pack_key: "us.wa.sales-use",
      pack_version: "2026.Q3.DOR",
      created_at: "2026-08-27T12:00:00.000Z",
      review_reason: "A verified Washington DOR location code is required",
    }] });

    const rows = await loadTaxDeterminations(principal, { reviewOnly: true });

    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readTax,
    });
    expect(mocks.query.mock.calls[0]?.[0]).toContain("jsonb_array_elements(source.snapshot -> 'lines')");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("newer.version > source.version");
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([principal.organizationId, true]);
    expect(rows).toEqual([expect.objectContaining({
      sourceNumber: "INV-WA-REVIEW",
      sourceStatus: "DRAFT",
      status: "MANUAL_REVIEW_REQUIRED",
      reviewReason: "A verified Washington DOR location code is required",
    })]);
  });

  it("scopes a parameterized trial balance to posted lines, entity, and exact range", async () => {
    const selection: ReportSelection = {
      entityId: "30000000-0000-4000-8000-000000000010",
      entityCode: "US01",
      entityName: "US company",
      ledgerId: "30000000-0000-4000-8000-000000000011",
      ledgerCode: "US01-PRIMARY",
      currency: "USD",
      basis: "date",
      fromDate: "2026-08-01",
      toDate: "2026-08-31",
      fromPeriodId: null,
      toPeriodId: null,
      accountId: null,
      accountCode: "1000",
      segmentFilters: { department: "OPS", custom8: "0000" },
    };
    mocks.query.mockResolvedValueOnce({ rows: [{
      entity_id: selection.entityId,
      entity_code: selection.entityCode,
      ledger_code: selection.ledgerCode,
      functional_currency: selection.currency,
      account_code: "1000",
      account_name: "Cash",
      account_class: "ASSET",
      canonical_key: "US01.1000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000",
      account_segment_definitions: [
        { key: "subaccount", displayName: "Product", visible: false },
        { key: "department", displayName: "Cost center", visible: true },
        ...Array.from({ length: 8 }, (_, index) => ({
          key: `custom${index + 1}`,
          displayName: `Custom ${index + 1}`,
          visible: false,
        })),
      ],
      opening_debit: "25",
      opening_credit: "0",
      period_debit: "100",
      period_credit: "40",
      debit: "85",
      credit: "0",
    }] });

    const rows = await loadTrialBalance(principal, selection);

    expect(mocks.query.mock.calls[0]?.[0]).toContain("entry.status = 'POSTED'");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("entry.legal_entity_id = $2::uuid");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("coalesce(department.code, '0000') = $7::text");
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      principal.organizationId,
      selection.entityId,
      selection.fromDate,
      selection.toDate,
      "1000",
      null,
      "OPS",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "0000",
    ]);
    expect(rows[0]).toMatchObject({
      canonicalKey: "US01.1000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000",
      displayKey: "US01.1000.0000.0000",
      openingDebit: "25",
      periodDebit: "100",
      debit: "85",
    });
  });

  it("loads the deterministic effective primary reporting hierarchy for the ledger and as-of date", async () => {
    const selection: ReportSelection = {
      entityId: "30000000-0000-4000-8000-000000000010",
      entityCode: "US01",
      entityName: "US company",
      ledgerId: "30000000-0000-4000-8000-000000000011",
      ledgerCode: "US01-PRIMARY",
      currency: "USD",
      basis: "date",
      fromDate: "2026-08-01",
      toDate: "2026-08-31",
      fromPeriodId: null,
      toPeriodId: null,
      accountId: null,
      accountCode: null,
      segmentFilters: {},
    };
    mocks.query.mockResolvedValueOnce({ rows: [{
      hierarchy_id: "30000000-0000-4000-8000-000000000020",
      hierarchy_code: "PRIMARY_REPORTING",
      hierarchy_name: "Primary statements",
      version: 2,
      effective_from: "2026-07-01",
      node_id: "30000000-0000-4000-8000-000000000021",
      parent_id: null,
      node_name: "Assets",
      sort_order: 100,
      statement_class: "ASSET",
      account_code: null,
    }] });

    await expect(loadEffectiveAccountHierarchy(principal, selection)).resolves.toEqual(
      expect.objectContaining({ code: "PRIMARY_REPORTING", version: 2, effectiveFrom: "2026-07-01" }),
    );
    expect(mocks.query.mock.calls[0]?.[0]).toContain("(hierarchy.code = 'PRIMARY_REPORTING') DESC");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("hierarchy.effective_from <= $3::date");
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      principal.organizationId,
      selection.ledgerId,
      selection.toDate,
    ]);
    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readMcpLedger,
    });
  });

  it("normalizes report filters inside the selected tenant entity and orders reversed ranges", () => {
    const dimensions: ReportDimensions = {
      segments: [{ key: "department", displayName: "Cost center" }],
      entities: [{
      id: "30000000-0000-4000-8000-000000000010",
      code: "US01",
      displayName: "US company",
      ledgerId: "30000000-0000-4000-8000-000000000011",
      ledgerCode: "US01-PRIMARY",
      currency: "USD",
      defaultPeriodId: "30000000-0000-4000-8000-000000000012",
      periods: [{
        id: "30000000-0000-4000-8000-000000000012",
        label: "August 2026",
        startsOn: "2026-08-01",
        endsOn: "2026-08-31",
      }],
      accounts: [{
        id: "30000000-0000-4000-8000-000000000013",
        code: "1000",
        displayName: "Cash",
        accountClass: "ASSET",
      }],
      }],
    };

    const selection = resolveReportSelection(dimensions, {
      entity: dimensions.entities[0]?.id,
      basis: "date",
      from: "2026-08-31",
      to: "2026-08-01",
      fromPeriod: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      account: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      accountCode: "1000",
      segmentFilters: { department: "ops", custom1: "invalid value" },
    });

    expect(selection).toMatchObject({
      entityCode: "US01",
      fromDate: "2026-08-01",
      toDate: "2026-08-31",
      fromPeriodId: dimensions.entities[0]?.defaultPeriodId,
      accountId: dimensions.entities[0]?.accounts[0]?.id,
      accountCode: "1000",
      segmentFilters: { department: "OPS" },
    });
    expect(reportSearchParams(selection!).toString()).toContain("segment_department=OPS");
  });

  it("builds natural-sign financial statements and protects every CSV cell from formulas", () => {
    const base = {
      entityId: "30000000-0000-4000-8000-000000000010",
      entityCode: "US01",
      ledgerCode: "US01-PRIMARY",
      currency: "USD",
      openingDebit: "0",
      openingCredit: "0",
      canonicalKey: "US01.1000.0000",
      displayKey: "US01.1000",
      displaySegments: [
        { key: "entity", displayName: "Entity", code: "US01" },
        { key: "account", displayName: "Account", code: "1000" },
        { key: "department", displayName: "Cost center", code: "OPS" },
      ],
      synthetic: false,
    };
    const rows: TrialBalanceRow[] = [
      { ...base, accountCode: "1000", accountName: "=FORMULA", accountClass: "ASSET", periodDebit: "150", periodCredit: "0", debit: "150", credit: "0" },
      { ...base, accountCode: "2000", accountName: "Payables", accountClass: "LIABILITY", periodDebit: "0", periodCredit: "50", debit: "0", credit: "50" },
      { ...base, accountCode: "4100", accountName: "Revenue", accountClass: "REVENUE", periodDebit: "0", periodCredit: "120", debit: "0", credit: "120" },
      { ...base, accountCode: "6100", accountName: "Expense", accountClass: "EXPENSE", periodDebit: "20", periodCredit: "0", debit: "20", credit: "0" },
      { ...base, accountCode: "1999", accountName: "Zero balance", accountClass: "ASSET", periodDebit: "10", periodCredit: "10", debit: "0", credit: "0" },
    ];

    expect(profitAndLossRows(rows).map((row) => [row.accountClass, row.amount])).toEqual([
      ["REVENUE", "120"],
      ["EXPENSE", "20"],
    ]);
    expect(balanceSheetRows(rows)).toContainEqual(expect.objectContaining({
      accountCode: "UNCLSD-EARNINGS",
      accountClass: "EQUITY",
      amount: "100",
      synthetic: true,
    }));
    expect(balanceSheetRows(rows)).not.toContainEqual(expect.objectContaining({ accountName: "Zero balance" }));
    const pnlRows = profitAndLossRows(rows);
    const hierarchyLines = financialStatementDisplayLines(pnlRows, {
      id: "30000000-0000-4000-8000-000000000020",
      code: "PRIMARY_REPORTING",
      displayName: "Primary statements",
      version: 1,
      effectiveFrom: "2026-01-01",
      nodes: [
        { id: "root", parentId: null, displayName: "Revenue", sortOrder: 100, statementClass: "REVENUE", accountCode: null },
        { id: "group", parentId: "root", displayName: "Services", sortOrder: 100, statementClass: null, accountCode: null },
        { id: "account", parentId: "group", displayName: "Service revenue", sortOrder: 10, statementClass: null, accountCode: "4100" },
      ],
    }, "REVENUE");
    expect(hierarchyLines).toEqual([
      expect.objectContaining({ kind: "GROUP", label: "Services", depth: 0, amount: "120" }),
      expect.objectContaining({ kind: "ACCOUNT", depth: 1, row: expect.objectContaining({ accountCode: "4100" }) }),
    ]);
    expect(financialStatementDisplayLines(pnlRows, null, "REVENUE"))
      .toEqual([expect.objectContaining({ kind: "ACCOUNT", depth: 0 })]);
    const csv = trialBalanceCsv(rows);
    expect(csv).toContain("\"'=FORMULA\"");
    expect(csv).toContain("\"Entity\",\"Account\",\"Cost center\",\"Ledger\",\"Currency\"");
    expect(csv).not.toContain("Displayed key");
    expect(csv).not.toContain("Canonical key");
    expect(csv).toContain("\"Opening debit\"");
    expect(csv).toContain("\"Ending credit\"");
    expect(trialBalanceCsv([], [{ key: "department", displayName: "Cost center" }]))
      .toContain("\"Entity\",\"Account\",\"Cost center\",\"Ledger\",\"Currency\"");
  });
});
