import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  observation: "10000000-0000-4000-8000-000000000003",
  entity: "10000000-0000-4000-8000-000000000004",
  ledger: "10000000-0000-4000-8000-000000000005",
  period: "10000000-0000-4000-8000-000000000006",
  cash: "10000000-0000-4000-8000-000000000007",
  expense: "10000000-0000-4000-8000-000000000008",
  priorProposal: "10000000-0000-4000-8000-000000000009",
};

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000010",
  userId: ids.actor,
  organizationId: ids.organization,
  membershipId: "10000000-0000-4000-8000-000000000011",
  organizationName: "Tenant",
  roleLabel: "Preparer",
  displayName: "Preparer",
  initials: "PR",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-12-31T00:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

const mocks = vi.hoisted(() => ({
  withTenantTransaction: vi.fn(),
  assertWritableOrganization: vi.fn(async () => undefined),
  assertActorHasActivePermission: vi.fn(async () => undefined),
}));

vi.mock("@/db/transaction", () => ({ withTenantTransaction: mocks.withTenantTransaction }));
vi.mock("@/modules/identity/authorization", () => ({
  assertActorHasActivePermission: mocks.assertActorHasActivePermission,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: vi.fn(),
  assertWritableOrganization: mocks.assertWritableOrganization,
  mutationContext: vi.fn((selected: SessionPrincipal, requestId: string, metadata: { reason: string }) => ({
    organizationId: selected.organizationId,
    actorId: selected.userId,
    requestId,
    reason: metadata.reason,
  })),
  principalCanWrite: vi.fn(() => true),
}));

import { prepareBankAccountingProposal } from "@/modules/banking/proposal-service";

const lineBase = {
  transactionCurrency: "CAD",
  fxRate: "1",
  fxRateSource: "Bank statement",
  fxRateEffectiveAt: "2026-08-01T00:00:00Z",
};

const command = {
  principal,
  requestId: "bank-proposal-reprepare-test",
  observationVersionId: ids.observation,
  legalEntityId: ids.entity,
  ledgerId: ids.ledger,
  periodId: ids.period,
  accountingDate: "2026-08-01",
  purpose: "ROUTINE" as const,
  transactionType: "EXPENSE" as const,
  description: "Corrected bank fee proposal",
  lines: [
    { ...lineBase, accountCombinationId: ids.cash, debitFunctional: "10.00", creditFunctional: "0", debitTransaction: "10.00", creditTransaction: "0" },
    { ...lineBase, accountCombinationId: ids.expense, debitFunctional: "0", creditFunctional: "10.00", debitTransaction: "0", creditTransaction: "10.00" },
  ],
  confidence: "HIGH" as const,
  reason: "Prepare corrected bank fee accounting",
  idempotencyKey: "corrected-bank-fee-1",
};

function fakeClient(latest: { id: string; version: number; status: string } | undefined) {
  const inserts: unknown[][] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("WHERE organization_id=$1 AND idempotency_key=$2")) return { rows: [] };
      if (sql.includes("FROM bank_observation_versions version JOIN bank_observations")) return { rows: [{
        amount: "10.00", currency_code: "CAD", external_account_id: ids.cash,
        posted_on: "2026-08-01", legal_entity_id: ids.entity,
        ledger_id: ids.ledger, cash_account_combination_id: ids.cash,
      }] };
      if (sql.includes("SELECT ledger.functional_currency")) return { rows: [{
        functional_currency: "CAD", period_state: "OPEN",
        starts_on: "2026-01-01", ends_on: "2026-12-31",
      }] };
      if (sql.includes("SELECT proposal.id, proposal.version, proposal.status")) return { rows: latest ? [latest] : [] };
      if (sql.includes("SELECT DISTINCT journal.id")) return { rows: [] };
      if (sql.includes("SELECT count(*)::int AS count")) return { rows: [{ count: 2 }] };
      if (sql.includes("INSERT INTO bank_accounting_proposals")) {
        inserts.push(params ?? []);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    }),
  };
  mocks.withTenantTransaction.mockImplementation(async (_context: unknown, work: (client: PoolClient) => Promise<unknown>) => work(client as unknown as PoolClient));
  return { inserts };
}

beforeEach(() => vi.clearAllMocks());

describe("bank proposal preparation lineage", () => {
  it("creates a new version after rejection and preserves the rejected proposal as predecessor", async () => {
    const { inserts } = fakeClient({ id: ids.priorProposal, version: 2, status: "REJECTED" });
    const result = await prepareBankAccountingProposal(command);

    expect(result).toMatchObject({ version: 3, status: "PREPARED", idempotentReplay: false });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[3]).toBe(3);
    expect(inserts[0]?.[6]).toBe(ids.priorProposal);
  });

  it("still refuses a second preparation while a proposal is active", async () => {
    const { inserts } = fakeClient({ id: ids.priorProposal, version: 2, status: "REVIEWED" });
    await expect(prepareBankAccountingProposal(command)).rejects.toMatchObject({ code: "BANK_PROPOSAL_DUPLICATE" });
    expect(inserts).toHaveLength(0);
  });
});
