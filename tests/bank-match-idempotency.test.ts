import type { PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandFingerprint } from "@/kernel/command-fingerprint";
import type { SessionPrincipal } from "@/modules/identity/session";

const previousBusinessWrites = process.env.BUSINESS_WRITES_ENABLED;
process.env.BUSINESS_WRITES_ENABLED = "true";

const ids = {
  session: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  organization: "10000000-0000-4000-8000-000000000003",
  reconciliation: "10000000-0000-4000-8000-000000000004",
  observation: "10000000-0000-4000-8000-000000000005",
  line: "10000000-0000-4000-8000-000000000006",
  allocation: "10000000-0000-4000-8000-000000000007",
};

const principal: SessionPrincipal = {
  sessionId: ids.session,
  userId: ids.actor,
  organizationId: ids.organization,
  membershipId: "10000000-0000-4000-8000-000000000008",
  organizationName: "Tenant",
  roleLabel: "Preparer",
  displayName: "Preparer",
  initials: "PR",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-08-31T00:00:00Z"),
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
  actorHasActivePermission: vi.fn(),
  assertActorHasActivePermission: mocks.assertActorHasActivePermission,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: vi.fn(),
  assertWritableOrganization: mocks.assertWritableOrganization,
  mutationContext: vi.fn((selected: SessionPrincipal, requestId: string, metadata: { reason: string }) => ({
    organizationId: selected.organizationId,
    actorId: selected.userId,
    requestId,
    authMethod: "password",
    sourceSurface: "IMPORT",
    reason: metadata.reason,
  })),
  principalCanWrite: vi.fn(() => true),
}));
vi.mock("@/modules/identity/session", () => ({ hasRecentStepUp: vi.fn(() => true) }));

import { createBankMatchAllocation } from "@/modules/banking/banking-service";

const body = {
  observationVersionId: ids.observation,
  journalLineId: ids.line,
  allocatedAmount: "25.00",
  idempotencyKey: "bank-match-ui-1",
};

function sessionRow() {
  return {
    id: ids.reconciliation,
    status: "DRAFT" as const,
    external_account_id: "10000000-0000-4000-8000-000000000009",
    cash_account_combination_id: "10000000-0000-4000-8000-000000000010",
    currency_code: "CAD",
    statement_start_on: "2026-08-01",
    statement_end_on: "2026-08-31",
    opening_balance: "0",
    closing_balance: "25",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  if (previousBusinessWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousBusinessWrites;
});

describe("bank-match allocation idempotency", () => {
  it("replays a stored pre-canonicalization v1 raw-input hash without re-validating mutable bank evidence", async () => {
    const commandHash = createCommandFingerprint("banking.reconciliation.match.allocation", {
      reconciliationId: ids.reconciliation,
      observationVersionId: ids.observation,
      journalLineId: ids.line,
      allocatedAmount: "25.00",
    }, "v1");
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("FROM bank_reconciliation_sessions")) return { rows: [sessionRow()] };
      if (statement.includes("FROM bank_match_allocations") && statement.includes("idempotency_key")) {
        return { rows: [{ id: ids.allocation, command_hash: commandHash }] };
      }
      throw new Error(`Unexpected replay SQL: ${statement}`);
    });
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    await expect(createBankMatchAllocation({
      principal,
      requestId: "bank-match-replay",
      reconciliationId: ids.reconciliation,
      ...body,
    })).resolves.toEqual({ allocationId: ids.allocation, idempotentReplay: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects a key reused with changed match facts", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("FROM bank_reconciliation_sessions")) return { rows: [sessionRow()] };
      if (statement.includes("FROM bank_match_allocations") && statement.includes("idempotency_key")) {
        return { rows: [{ id: ids.allocation, command_hash: "f".repeat(64) }] };
      }
      throw new Error(`Unexpected conflict SQL: ${statement}`);
    });
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    await expect(createBankMatchAllocation({
      principal,
      requestId: "bank-match-conflict",
      reconciliationId: ids.reconciliation,
      ...body,
      allocatedAmount: "24.00",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("replays equivalent exact-decimal spellings against the canonical stored fact", async () => {
    const commandHash = createCommandFingerprint("banking.reconciliation.match.allocation", {
      reconciliationId: ids.reconciliation,
      observationVersionId: ids.observation,
      journalLineId: ids.line,
      allocatedAmount: "25",
    }, "v2");
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("FROM bank_reconciliation_sessions")) return { rows: [sessionRow()] };
      if (statement.includes("FROM bank_match_allocations") && statement.includes("idempotency_key")) {
        return { rows: [{ id: ids.allocation, command_hash: commandHash }] };
      }
      throw new Error(`Unexpected canonical replay SQL: ${statement}`);
    });
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    await expect(createBankMatchAllocation({
      principal,
      requestId: "bank-match-canonical-replay",
      reconciliationId: ids.reconciliation,
      ...body,
      allocatedAmount: "25.000",
    })).resolves.toEqual({ allocationId: ids.allocation, idempotentReplay: true });
  });

  it("persists the canonical command hash and permits independent split allocation keys", async () => {
    const inserts: readonly unknown[][] = [];
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("FROM bank_reconciliation_sessions")) return { rows: [sessionRow()] };
      if (statement.includes("FROM bank_match_allocations") && statement.includes("idempotency_key")) return { rows: [] };
      if (statement.includes("bank-evidence")) return { rows: [] };
      if (statement.includes("selected.lock_key")) return { rows: [] };
      if (statement.includes("WITH selected_observation")) {
        return { rows: [{ observation_amount: "25", line_amount: "25", observation_allocated: "0", line_allocated: "0" }] };
      }
      if (statement.includes("INSERT INTO bank_match_allocations")) {
        (inserts as unknown[][]).push([...(parameters ?? [])]);
        return { rows: [{ id: parameters?.[0] }] };
      }
      throw new Error(`Unexpected create SQL: ${statement}`);
    });
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    const first = await createBankMatchAllocation({
      principal,
      requestId: "bank-match-create",
      reconciliationId: ids.reconciliation,
      ...body,
      allocatedAmount: "12.00",
    });
    const second = await createBankMatchAllocation({
      principal,
      requestId: "bank-match-split-create",
      reconciliationId: ids.reconciliation,
      ...body,
      allocatedAmount: "13.00",
      idempotencyKey: "bank-match-ui-2",
    });
    expect(first).toMatchObject({ idempotentReplay: false });
    expect(second).toMatchObject({ idempotentReplay: false });
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.[6]).toBe(body.idempotencyKey);
    expect(inserts[1]?.[6]).toBe("bank-match-ui-2");
    expect(inserts[0]?.[7]).toBe(createCommandFingerprint("banking.reconciliation.match.allocation", {
      reconciliationId: ids.reconciliation,
      observationVersionId: ids.observation,
      journalLineId: ids.line,
      allocatedAmount: "12",
    }, "v2"));
  });
});
