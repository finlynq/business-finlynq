import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  permission: true,
  queries: [] as { statement: string; params: readonly unknown[] | undefined }[],
  query: vi.fn(async (statement: string, params?: readonly unknown[]) => {
    mocks.queries.push({ statement, params });
    if (statement.includes("FROM organization_memberships membership")) {
      return { rows: [{ is_demo: false }] };
    }
    if (statement.includes("FROM journal_entries entry") && statement.includes("LIMIT 1")) {
      return { rows: [{
        id: "30000000-0000-4000-8000-000000000020",
        journal_number: 41,
        accounting_date: "2026-08-20",
        entity_code: "US01",
        ledger_code: "US01-PRIMARY",
        functional_currency: "USD",
        description: "Posted invoice",
        journal_type_key: "receivables.sales-invoice",
        type_label: "Sales invoice",
        owner_module: "receivables",
        correction_route: "https://attacker.invalid/redirect",
        origin: "USER",
        purpose: "ROUTINE",
        status: "POSTED",
        source_number: "INV-1001",
        total_debit_functional: "113",
        total_credit_functional: "113",
        posted_at: "2026-08-20T16:00:00.000Z",
      }] };
    }
    if (statement.includes("FROM journal_lines line")) {
      return { rows: [{
        id: "30000000-0000-4000-8000-000000000021",
        line_number: 1,
        account_code: "1100",
        account_name: "Accounts receivable",
        canonical_key: "US01.1100.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000",
        account_segment_definitions: [
          { key: "subaccount", displayName: "Product", visible: false },
          { key: "department", displayName: "Cost center", visible: true },
          ...Array.from({ length: 8 }, (_, index) => ({
            key: `custom${index + 1}`,
            displayName: `Custom ${index + 1}`,
            visible: false,
          })),
        ],
        memo: "Invoice control",
        transaction_currency: "CAD",
        debit_transaction: "150",
        credit_transaction: "0",
        fx_rate: "0.753333333333333333",
        fx_rate_source: "manual-spot",
        fx_rate_effective_at: "2026-08-20T12:00:00.000Z",
        debit_functional: "113",
        credit_functional: "0",
      }] };
    }
    throw new Error(`Unexpected query: ${statement}`);
  }),
  actorHasActivePermission: vi.fn(async () => mocks.permission),
  withTenantTransaction: vi.fn(async (_context: unknown, work: (client: unknown) => unknown) => (
    work({ query: mocks.query })
  )),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/identity/session", () => ({
  hasRecentStepUp: vi.fn(() => false),
  transactionAuthMethod: vi.fn(() => "password"),
}));
vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: mocks.actorHasActivePermission,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  principalCanWrite: vi.fn(() => false),
}));

import { PERMISSIONS } from "@/modules/identity/permissions";
import { loadTenantJournalDetail } from "@/modules/ledger/tenant-workspace";

const principal: SessionPrincipal = {
  sessionId: "20000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000002",
  organizationId: "20000000-0000-4000-8000-000000000003",
  membershipId: "20000000-0000-4000-8000-000000000004",
  organizationName: "Tenant",
  roleLabel: "Auditor",
  displayName: "Auditor",
  initials: "AU",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-08-28T00:00:00.000Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

beforeEach(() => {
  mocks.permission = true;
  mocks.queries.length = 0;
  mocks.query.mockClear();
  mocks.actorHasActivePermission.mockClear();
});

describe("tenant journal detail", () => {
  it("returns immutable debit, credit, currency, and FX evidence only from the tenant scope", async () => {
    const journalId = "30000000-0000-4000-8000-000000000020";
    const detail = await loadTenantJournalDetail(principal, journalId);

    expect(mocks.actorHasActivePermission).toHaveBeenCalledWith(expect.anything(), {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readMcpLedger,
    });
    expect(mocks.queries.slice(1).every((query) => query.params?.[0] === principal.organizationId)).toBe(true);
    expect(mocks.queries.slice(1).every((query) => query.params?.[1] === journalId)).toBe(true);
    expect(detail).toMatchObject({
      number: "41",
      debitFunctional: "113",
      creditFunctional: "113",
      sourceHref: "/app/receivables/invoices?q=INV-1001",
      lines: [{
        canonicalKey: "US01.1100.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000",
        displayKey: "US01.1100.0000.0000",
        displaySegments: expect.arrayContaining([
          { key: "department", displayName: "Cost center", code: "0000" },
        ]),
        transactionCurrency: "CAD",
        fxRateSource: "manual-spot",
        debitFunctional: "113",
      }],
    });
  });

  it("fails closed before reading a journal header without ledger-read permission", async () => {
    mocks.permission = false;

    await expect(loadTenantJournalDetail(
      principal,
      "30000000-0000-4000-8000-000000000020",
    )).rejects.toThrow("Ledger read permission is required");
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
