import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTenantTransaction: vi.fn(),
  mutationContext: vi.fn((principal, requestId, options) => ({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId,
    authMethod: "password+mfa",
    sourceSurface: options.sourceSurface,
    reason: options.reason,
    mcpConnectionId: principal.mcpConnectionId,
  })),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: vi.fn(),
  assertWritableOrganization: vi.fn(async () => ({ isDemo: false })),
  demoWritesEnabled: vi.fn(() => false),
  mutationContext: mocks.mutationContext,
  principalCanWrite: vi.fn(() => true),
}));

import {
  accountCombinationConfigurationSchema,
  createAccountCombination,
} from "@/modules/ledger/accounting-configuration";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  membership: "10000000-0000-4000-8000-000000000003",
  session: "10000000-0000-4000-8000-000000000004",
  connection: "10000000-0000-4000-8000-000000000005",
  entity: "20000000-0000-4000-8000-000000000001",
  ledger: "20000000-0000-4000-8000-000000000002",
  account: "20000000-0000-4000-8000-000000000003",
  combination: "20000000-0000-4000-8000-000000000004",
};

const principal = {
  sessionId: ids.session,
  userId: ids.user,
  organizationId: ids.organization,
  membershipId: ids.membership,
  organizationName: "Next Software",
  roleLabel: "Owner",
  displayName: "Owner",
  initials: "OW",
  sessionMode: "real" as const,
  authMethod: "PASSWORD" as const,
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  mfaVerifiedAt: new Date("2098-12-31T23:50:00Z"),
  stepUpExpiresAt: new Date("2099-01-01T00:00:00Z"),
  mcpConnectionId: ids.connection,
  organizationWritesEnabled: true,
};

const combination = accountCombinationConfigurationSchema.parse({
  legalEntityId: ids.entity,
  ledgerId: ids.ledger,
  accountId: ids.account,
  reason: "Create the default natural-account combination",
});

beforeEach(() => {
  vi.clearAllMocks();
  const client = { query: mocks.query } as unknown as PoolClient;
  mocks.withTenantTransaction.mockImplementation(async (_context, work) => work(client));
});

describe("account-combination setup boundary", () => {
  it("returns the same active normalized combination as an authorized replay", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ valid_from: "2025-01-01", valid_to: null }] })
      .mockResolvedValueOnce({ rows: [{ id: ids.combination, active: true }] })
      .mockResolvedValueOnce({ rows: [{ id: ids.combination }] });

    await expect(createAccountCombination({
      principal,
      requestId: "combination-replay",
      ...combination,
    })).resolves.toEqual({ id: ids.combination, idempotentReplay: true });
    expect(mocks.mutationContext).toHaveBeenCalledWith(
      principal,
      "combination-replay",
      expect.objectContaining({ sourceSurface: "MCP" }),
    );
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("app.accounting_create_account_combination"),
      expect.any(Array),
    );
  });

  it("returns tenant-safe configuration details instead of a generic SQL rejection", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ valid_from: "2025-01-01", valid_to: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error("raw database detail"), { code: "22023" }));

    await expect(createAccountCombination({
      principal,
      requestId: "combination-invalid",
      ...combination,
    })).rejects.toMatchObject({
      code: "ACCOUNT_COMBINATION_CONFIGURATION_REJECTED",
      safeDetails: {
        legalEntityId: ids.entity,
        ledgerId: ids.ledger,
        accountId: ids.account,
        effectiveFrom: "2025-01-01",
        effectiveTo: null,
        equivalentCombinationExists: false,
        constraintCategory: "TENANT_CONFIGURATION_MISMATCH",
      },
    });
  });
});
