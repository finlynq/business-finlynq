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
  loadAccountingOverview,
  loadTaxDeterminations,
  loadTrialBalance,
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
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([principal.organizationId, true, false]);
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
});
