import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

const fixtures = vi.hoisted(() => {
  const entity = {
    id: "10000000-0000-4000-8000-000000000001", code: "CA01", ledgerId: "10000000-0000-4000-8000-000000000002",
    ledgerCode: "CA01-PRIMARY", currency: "CAD", periods: [], accounts: [], displayName: "Company", defaultPeriodId: null,
  };
  const selection = {
    entityId: entity.id, entityCode: entity.code, entityName: entity.displayName,
    ledgerId: entity.ledgerId, ledgerCode: entity.ledgerCode, currency: entity.currency,
    basis: "date", fromDate: "2026-01-01", toDate: "2026-12-31",
    fromPeriodId: null, toPeriodId: null, accountId: null, accountCode: null, segmentFilters: {},
  };
  const report = {
    selection, fiscalYear: 2026, asOfDate: "2026-10-14", snapshotHash: "a".repeat(64),
    columns: [{ key: "2026-01", label: "Jan", startsOn: "2026-01-01", endsOn: "2026-01-31",
      includedFrom: "2026-01-01", includedTo: "2026-01-31", coverage: "COMPLETE", periodState: "CLOSED" }],
    rows: [{ entityCode: "CA01", ledgerCode: "CA01-PRIMARY", currency: "CAD", accountCode: "4000", combinationId: "10000000-0000-4000-8000-000000000006",
      accountName: "Sales", accountClass: "REVENUE", canonicalKey: "CA01.4000", displayKey: "CA01.4000",
      displaySegments: [], amount: "100.00", months: { "2026-01": "100.00" } }],
  };
  return { entity, selection, report };
});

vi.mock("@/modules/workspace/access", () => ({ requireWorkspacePrincipal: async () => ({ sessionMode: "demo" }) }));
vi.mock("@/modules/workspace/entity-context", () => ({ currentWorkspaceEntityContext: async () => ({ selectedEntity: fixtures.entity }) }));
vi.mock("@/modules/reporting/tenant-reporting", () => ({
  loadReportDimensions: async () => ({ entities: [fixtures.entity] }),
  reportFilterInput: () => ({}),
  resolveReportSelection: () => fixtures.selection,
  loadEffectiveAccountHierarchy: async () => null,
  financialStatementDisplayLines: (rows: readonly { accountClass: string; canonicalKey: string }[], _hierarchy: unknown, kind: string) => rows
    .filter((row) => row.accountClass === kind).map((row) => ({ kind: "ACCOUNT", id: row.canonicalKey, row, depth: 0 })),
}));
vi.mock("@/modules/reporting/monthly-profit-and-loss", () => ({
  loadMonthlyProfitAndLoss: async () => fixtures.report,
  monthlyReportAsOfDate: () => "2026-10-14",
  monthlyReportSelectionInput: (_dimensions: unknown, input: unknown) => input,
}));

import { GET } from "@/app/(workspace)/reports/profit-and-loss.xlsx/route";
import { monthlyReportPresentationHash } from "@/modules/reporting/monthly-profit-and-loss-export";

describe("monthly P&L workbook export", () => {
  it("exports the exact scoped grid and rejects a stale snapshot", async () => {
    const hash = monthlyReportPresentationHash(fixtures.report as never, null);
    const response = await GET(new Request(`https://example.test/app/reports/profit-and-loss.xlsx?snapshot=${hash}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("spreadsheetml.sheet");
    const book = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<readonly string[]>(book.Sheets["Monthly P&L"]!, { header: 1 });
    expect(rows).toContainEqual(expect.arrayContaining(["CA01.4000 · Sales", "100.00", "100.00"]));
    expect(rows).toContainEqual(expect.arrayContaining(["Net income (loss)", "100.00", "100.00"]));
    const stale = await GET(new Request(`https://example.test/app/reports/profit-and-loss.xlsx?snapshot=${"b".repeat(64)}`));
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("Rerun");
  });
});
