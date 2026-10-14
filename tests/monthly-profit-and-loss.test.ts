import { beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  assertPermission: vi.fn(async () => undefined),
  readContext: [] as unknown[],
}));

vi.mock("@/modules/workspace/tenant-read", () => ({
  withWorkspaceTenantRead: async (context: unknown, _route: string, work: (client: unknown) => Promise<unknown>) => {
    mocks.readContext.push(context);
    return work({ query: mocks.query });
  },
}));
vi.mock("@/modules/identity/authorization", () => ({ assertActorHasActivePermission: mocks.assertPermission }));
vi.mock("@/modules/identity/session", () => ({ transactionAuthMethod: () => "demo-link" }));

import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  loadMonthlyProfitAndLoss,
  monthlyReportColumns,
  monthlyReportSelectionInput,
} from "@/modules/reporting/monthly-profit-and-loss";
import { monthlyProfitAndLossExportRows, monthlyReportPresentationHash } from "@/modules/reporting/monthly-profit-and-loss-export";
import type { ReportDimensions, ReportSelection } from "@/modules/reporting/tenant-reporting";

const entity = {
  id: "10000000-0000-4000-8000-000000000001",
  code: "CA01",
  displayName: "Company",
  ledgerId: "10000000-0000-4000-8000-000000000002",
  ledgerCode: "CA01-PRIMARY",
  currency: "CAD",
  defaultPeriodId: "period-3",
  periods: Array.from({ length: 12 }, (_, index) => {
    const start = new Date(Date.UTC(2025, 6 + index, 1));
    const end = new Date(Date.UTC(2025, 7 + index, 0));
    return {
      id: `period-${index + 1}`,
      label: new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(start),
      startsOn: start.toISOString().slice(0, 10),
      endsOn: end.toISOString().slice(0, 10),
      fiscalYear: 2026,
      periodNumber: index + 1,
      state: "OPEN",
    };
  }),
  accounts: [],
};
const selection: ReportSelection = {
  entityId: entity.id,
  entityCode: entity.code,
  entityName: entity.displayName,
  ledgerId: entity.ledgerId,
  ledgerCode: entity.ledgerCode,
  currency: entity.currency,
  basis: "period",
  fromDate: "2025-07-01",
  toDate: "2026-06-30",
  fromPeriodId: "period-1",
  toPeriodId: "period-12",
  accountId: null,
  accountCode: null,
  segmentFilters: {},
};
const principal = {
  organizationId: "10000000-0000-4000-8000-000000000003",
  userId: "10000000-0000-4000-8000-000000000004",
  sessionId: "10000000-0000-4000-8000-000000000005",
  sessionMode: "demo" as const,
};

beforeEach(() => {
  mocks.query.mockReset();
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.assertPermission.mockClear();
  mocks.readContext.length = 0;
});

describe("monthly profit and loss", () => {
  it("orders a non-calendar fiscal year and labels partial and future months", () => {
    const dimensions: ReportDimensions = { entities: [entity] };
    expect(monthlyReportSelectionInput(dimensions, { entity: entity.id })).toMatchObject({
      basis: "period", fromPeriod: "period-1", toPeriod: "period-12",
    });
    const result = monthlyReportColumns(entity, selection, "2025-09-15");
    expect(result.fiscalYear).toBe(2026);
    expect(result.columns).toHaveLength(12);
    expect(result.columns.map((column) => column.coverage).slice(0, 4)).toEqual([
      "COMPLETE", "COMPLETE", "PARTIAL", "FUTURE",
    ]);
    expect(result.columns[2]).toMatchObject({ includedFrom: "2025-09-01", includedTo: "2025-09-15" });
    expect(result.columns[11]?.label).toBe("Jun");
    expect(() => monthlyReportColumns(entity, { ...selection, fromDate: "2025-06-01" }, "2025-09-15"))
      .toThrow("one configured fiscal year");
    const broken = { ...entity, periods: entity.periods.map((period, index) => index === 3
      ? { ...period, startsOn: "2025-10-02" } : period) };
    expect(() => monthlyReportColumns(broken, selection, "2025-09-15"))
      .toThrow("overlapping or missing dates");
  });

  it("uses one scoped posted-line query and nets a reversal in its actual month", async () => {
    mocks.query.mockResolvedValue({ rows: [
      { bucket_key: "period-1", combination_id: "10000000-0000-4000-8000-000000000006", entity_code: "CA01", ledger_code: "CA01-PRIMARY", functional_currency: "CAD",
        account_code: "4000", account_name: "Sales", account_class: "REVENUE", canonical_key: "CA01.4000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000",
        account_segment_definitions: [], debit: "0", credit: "100" },
      { bucket_key: "period-2", combination_id: "10000000-0000-4000-8000-000000000006", entity_code: "CA01", ledger_code: "CA01-PRIMARY", functional_currency: "CAD",
        account_code: "4000", account_name: "Sales", account_class: "REVENUE", canonical_key: "CA01.4000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000",
        account_segment_definitions: [], debit: "20", credit: "0" },
    ] });
    const report = await loadMonthlyProfitAndLoss(principal as never, selection, entity, "2025-09-15");
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0]?.[0]).toContain("entry.status = 'POSTED'");
    expect(mocks.query.mock.calls[0]?.[1]?.slice(0, 3)).toEqual([principal.organizationId, entity.id, entity.ledgerId]);
    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ permission: PERMISSIONS.readMcpLedger }));
    expect(report.rows[0]).toMatchObject({ amount: "80", months: { "period-1": "100", "period-2": "-20" } });
    const grid = monthlyProfitAndLossExportRows(report, null);
    expect(grid.find((row) => row.label === "Total revenue")?.total).toBe("80");
    expect(grid.find((row) => row.label === "Total revenue")?.values.slice(0, 3)).toEqual(["100", "-20", "0"]);
    expect(grid.at(-1)).toMatchObject({ label: "Net income (loss)", total: "80" });
    expect(monthlyReportPresentationHash(report, null)).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.readContext[0]).toMatchObject({ organizationId: principal.organizationId, sessionMode: "demo" });
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))("plans the exact aggregate SQL against migrated PostgreSQL", async () => {
    await loadMonthlyProfitAndLoss(principal as never, selection, entity, "2025-09-15");
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      const result = await owner.query(`EXPLAIN ${sql}`, params);
      expect(result.rows.length).toBeGreaterThan(0);
    } finally {
      await owner.end();
    }
  });
});
