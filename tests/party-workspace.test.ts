import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  actorHasActivePermission: vi.fn(async () => true),
  principalCanWrite: vi.fn(() => true),
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: mocks.actorHasActivePermission,
}));
vi.mock("@/modules/identity/session", () => ({
  transactionAuthMethod: vi.fn(() => "demo-link"),
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  principalCanWrite: mocks.principalCanWrite,
}));

import { loadPartyAccountCreationOptions } from "@/modules/parties/party-workspace";

const principal: SessionPrincipal = {
  sessionId: "20000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000002",
  organizationId: "20000000-0000-4000-8000-000000000003",
  membershipId: "20000000-0000-4000-8000-000000000004",
  organizationName: "Demo tenant",
  roleLabel: "Owner",
  displayName: "Demo Owner",
  initials: "DO",
  sessionMode: "demo",
  authMethod: "DEMO_LINK",
  expiresAt: new Date("2026-08-27T20:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

function client() {
  const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
    void parameters;
    if (statement.includes("FROM organization_memberships membership")) return { rows: [{ allowed: true }] };
    if (statement.includes("SELECT DISTINCT entity.id AS legal_entity_id")) {
      return { rows: [{
        legal_entity_id: "30000000-0000-4000-8000-000000000001",
        entity_code: "CA01",
        ledger_id: "30000000-0000-4000-8000-000000000002",
        ledger_code: "PRIMARY",
        functional_currency: "CAD",
        role: "CUSTOMER",
        control_account_id: "30000000-0000-4000-8000-000000000003",
        control_account_code: "1100",
        control_account_name: "Accounts receivable",
      }] };
    }
    throw new Error(`Unexpected party-workspace SQL: ${statement}`);
  });
  return { query, databaseClient: { query } as unknown as PoolClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actorHasActivePermission.mockResolvedValue(true);
  mocks.principalCanWrite.mockReturnValue(true);
});

describe("party-account creation workspace", () => {
  it("returns only tenant-scoped usable control options under the bound demo lease", async () => {
    const { query, databaseClient } = client();
    mocks.withTenantTransaction.mockImplementation(async (
      context: unknown,
      work: (transactionClient: PoolClient) => Promise<unknown>,
    ) => {
      expect(context).toMatchObject({
        organizationId: principal.organizationId,
        actorId: principal.userId,
        sessionId: principal.sessionId,
        sessionMode: "demo",
        authMethod: "demo-link",
      });
      return work(databaseClient);
    });

    await expect(loadPartyAccountCreationOptions(principal)).resolves.toEqual([{
      legalEntityId: "30000000-0000-4000-8000-000000000001",
      entityCode: "CA01",
      ledgerId: "30000000-0000-4000-8000-000000000002",
      ledgerCode: "PRIMARY",
      functionalCurrency: "CAD",
      role: "CUSTOMER",
      controlAccountId: "30000000-0000-4000-8000-000000000003",
      controlAccountCode: "1100",
      controlAccountName: "Accounts receivable",
    }]);
    const optionsQuery = query.mock.calls.find(([statement]) =>
      statement.includes("SELECT DISTINCT entity.id AS legal_entity_id"),
    );
    expect(optionsQuery?.[1]).toEqual([principal.organizationId]);
    expect(optionsQuery?.[0]).not.toContain("country_code IN");
  });

  it("fails closed before loading control accounts when writes are disabled", async () => {
    const { query, databaseClient } = client();
    mocks.principalCanWrite.mockReturnValue(false);
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (transactionClient: PoolClient) => Promise<unknown>,
    ) => work(databaseClient));

    await expect(loadPartyAccountCreationOptions(principal)).resolves.toEqual([]);
    expect(query.mock.calls.some(([statement]) =>
      statement.includes("SELECT DISTINCT entity.id AS legal_entity_id"),
    )).toBe(false);
  });
});
