import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  failSource: "" as string,
  queries: [] as string[],
}));

vi.mock("@/modules/workspace/tenant-read", () => ({
  withWorkspaceTenantRead: async (_context: unknown, _path: string, work: (client: unknown) => Promise<unknown>) => work({
    query: async (query: string) => {
      mocks.queries.push(query);
      if (query.includes("bank_external_accounts")) {
        if (mocks.failSource === "bank") throw new Error("bank unavailable");
        return { rows: [{ period_id: "period-1", account_count: 1, reconciled_count: 0 }] };
      }
      if (query.includes("asset_register")) {
        if (mocks.failSource === "asset") throw new Error("asset unavailable");
        return { rows: [{ period_id: "period-1", eligible_count: 2, missing_count: 0, due_depreciation: 1, due_prepaid: 0, drafted_count: 0, posted_prepaid: 1 }] };
      }
      return { rows: [{ period_id: "period-1", receivable_count: 0, payable_count: 0 }] };
    },
  }),
}));

import { loadCloseMonitor } from "@/modules/close/monitor";

const principal = {
  organizationId: "org-1", userId: "user-1", sessionId: "session-1",
  sessionMode: "real", authMethod: "PASSWORD", stepUpExpiresAt: null,
} as Parameters<typeof loadCloseMonitor>[0];
const periods = [{
  id: "period-1", ledgerId: "ledger-1", entityCode: "CA01", ledgerCode: "PRIMARY",
  currency: "CAD", label: "September 2026", startsOn: "2026-09-01", endsOn: "2026-09-30",
  state: "OPEN", version: 1, unpostedJournalCount: 1,
}] as Parameters<typeof loadCloseMonitor>[1];

describe("month-end close source monitor", () => {
  it("separates due depreciation, posted prepaid, and uncomputed tax", async () => {
    mocks.failSource = "";
    const [monitor] = await loadCloseMonitor(principal, periods);
    expect(monitor.checks.find((check) => check.key === "depreciation")?.status).toBe("BLOCKED");
    expect(monitor.checks.find((check) => check.key === "prepaids")?.status).toBe("SOURCE CHECK");
    expect(monitor.checks.find((check) => check.key === "unposted-journals")?.status).toBe("BLOCKED");
    expect(monitor.checks.find((check) => check.key === "tax-provision")?.status).toBe("NOT COMPUTED");
  });

  it("marks a failed source unknown without treating it as zero", async () => {
    mocks.failSource = "asset";
    mocks.queries.length = 0;
    const [monitor] = await loadCloseMonitor(principal, periods);
    expect(monitor.checks.filter((check) => ["depreciation", "prepaids", "asset-drafts"].includes(check.key)).map((check) => check.status))
      .toEqual(["UNKNOWN", "UNKNOWN", "UNKNOWN"]);
    expect(monitor.checks.find((check) => check.key === "bank")?.status).toBe("NEEDS REVIEW");
    expect(mocks.queries).toContain("ROLLBACK TO SAVEPOINT close_monitor_asset");
  });
});
