import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BankingWorkspaceDto } from "@/modules/banking/banking-workspace";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTenantTransaction: vi.fn(),
  assertActorHasActivePermission: vi.fn(),
  assertTenantWritesEnabled: vi.fn(),
  assertWritableOrganization: vi.fn(),
  mutationContext: vi.fn(() => ({ organizationId: "organization" })),
  principalCanWrite: vi.fn(() => true),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: vi.fn(),
  assertActorHasActivePermission: mocks.assertActorHasActivePermission,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: mocks.assertTenantWritesEnabled,
  assertWritableOrganization: mocks.assertWritableOrganization,
  mutationContext: mocks.mutationContext,
  principalCanWrite: mocks.principalCanWrite,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  bankMappingCandidates,
  isFirstSimpleFinMapping,
  parseBankMappingSelection,
} from "@/app/_components/banking-workspace.client";
import { mapBankExternalAccount } from "@/modules/banking/banking-service";

const ids = {
  session: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  organization: "10000000-0000-4000-8000-000000000003",
  membership: "10000000-0000-4000-8000-000000000004",
  external: "10000000-0000-4000-8000-000000000005",
  connection: "10000000-0000-4000-8000-000000000006",
  entity: "10000000-0000-4000-8000-000000000007",
  ledger: "10000000-0000-4000-8000-000000000008",
  asset: "10000000-0000-4000-8000-000000000009",
  liability: "10000000-0000-4000-8000-000000000010",
};

const principal: SessionPrincipal = {
  sessionId: ids.session,
  userId: ids.user,
  organizationId: ids.organization,
  membershipId: ids.membership,
  organizationName: "Tenant",
  roleLabel: "Preparer",
  displayName: "Preparer",
  initials: "PR",
  sessionMode: "real",
  authMethod: "PASSWORD",
  organizationWritesEnabled: true,
  expiresAt: new Date("2026-09-30T00:00:00.000Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

const baseAccount: BankingWorkspaceDto["accounts"][number] = {
  id: ids.external,
  connectionId: ids.connection,
  displayName: "Operating account",
  currencyCode: "CAD",
  accountKind: "CASH",
  active: true,
  legalEntityId: null,
  entityCode: null,
  ledgerId: null,
  accountCombinationId: null,
  accountCode: null,
  accountName: null,
  latestBalance: "120.00",
  latestBalanceAt: "2026-09-01T00:00:00.000Z",
  observationCount: 4,
};

const candidates: BankingWorkspaceDto["cashAccounts"] = [
  {
    id: ids.asset,
    legalEntityId: ids.entity,
    entityCode: "CA01",
    ledgerId: ids.ledger,
    ledgerCode: "PRIMARY",
    currencyCode: "CAD",
    accountCode: "1000",
    accountName: "Cash",
    accountClass: "ASSET",
  },
  {
    id: ids.liability,
    legalEntityId: ids.entity,
    entityCode: "CA01",
    ledgerId: ids.ledger,
    ledgerCode: "PRIMARY",
    currencyCode: "CAD",
    accountCode: "2100",
    accountName: "Credit card payable",
    accountClass: "LIABILITY",
  },
];

function command(accountKind?: "CASH" | "CREDIT_CARD") {
  return {
    principal,
    requestId: "map-account-test",
    externalAccountId: ids.external,
    legalEntityId: ids.entity,
    ledgerId: ids.ledger,
    cashAccountCombinationId: accountKind === "CREDIT_CARD" ? ids.liability : ids.asset,
    ...(accountKind ? { accountKind } : {}),
  };
}

function selectedAccount(overrides: Record<string, unknown> = {}) {
  return {
    account_kind: "CASH",
    legal_entity_id: null,
    ledger_id: null,
    cash_account_combination_id: null,
    provider: "SIMPLEFIN",
    account_class: "LIABILITY",
    ...overrides,
  };
}

describe("first SimpleFIN account mapping classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query: mocks.query } as unknown as PoolClient));
    mocks.assertActorHasActivePermission.mockResolvedValue(undefined);
    mocks.assertWritableOrganization.mockResolvedValue(undefined);
  });

  it("offers both classes for an unmapped SimpleFIN account and derives the provider kind", () => {
    const workspace = {
      connections: [{
        id: ids.connection,
        provider: "SIMPLEFIN",
        displayName: "Bank",
        status: "ACTIVE",
        lastSyncedAt: null,
        lastErrorCode: null,
      }],
      cashAccounts: candidates,
    };

    expect(isFirstSimpleFinMapping(workspace, baseAccount)).toBe(true);
    expect(bankMappingCandidates(workspace, baseAccount).map((candidate) => candidate.accountClass))
      .toEqual(["ASSET", "LIABILITY"]);
    expect(parseBankMappingSelection(`${ids.entity}|${ids.ledger}|${ids.asset}|ASSET`))
      .toEqual(expect.objectContaining({ accountKind: "CASH", cashAccountCombinationId: ids.asset }));
    expect(parseBankMappingSelection(`${ids.entity}|${ids.ledger}|${ids.liability}|LIABILITY`))
      .toEqual(expect.objectContaining({ accountKind: "CREDIT_CARD", cashAccountCombinationId: ids.liability }));
    expect(bankMappingCandidates(workspace, {
      ...baseAccount,
      accountKind: "CREDIT_CARD",
      accountCombinationId: ids.liability,
    }).map((candidate) => candidate.accountClass)).toEqual(["LIABILITY"]);
  });

  it("classifies an unmapped SimpleFIN account and writes its kind with the mapping atomically", async () => {
    mocks.query.mockImplementation(async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.includes("FOR UPDATE OF external")) return { rows: [selectedAccount()] };
      if (sql.includes("AS unsafe_history")) return { rows: [{ unsafe_history: false }] };
      if (sql.includes("UPDATE bank_external_accounts external")) {
        expect(parameters).toEqual([
          ids.organization, ids.external, ids.entity, ids.ledger, ids.liability,
          "CREDIT_CARD", "CASH",
        ]);
        expect(sql).toContain("connection.provider = 'SIMPLEFIN'");
        expect(sql).toContain("NOT EXISTS");
        return { rows: [{ id: ids.external }] };
      }
      throw new Error("Unexpected SQL: " + sql);
    });

    await expect(mapBankExternalAccount(command("CREDIT_CARD"))).resolves.toEqual({
      accountId: ids.external,
      mapped: true,
    });
  });

  it("rejects a selected ledger class that does not match the requested kind", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [selectedAccount({ account_class: "ASSET" })] });

    await expect(mapBankExternalAccount(command("CREDIT_CARD"))).rejects.toMatchObject({
      code: "INVALID_CASH_MAPPING",
      status: 400,
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("does not reclassify a non-SimpleFIN account even when it is unmapped", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [selectedAccount({ provider: "FILE_IMPORT" })] });

    await expect(mapBankExternalAccount(command("CREDIT_CARD"))).rejects.toMatchObject({
      code: "ACCOUNT_KIND_CHANGE_NOT_ALLOWED",
      status: 409,
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("preserves omitted-kind callers and rejects later or historical kind changes", async () => {
    mocks.query.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain("FOR UPDATE OF external");
      return { rows: [selectedAccount({ account_class: "ASSET" })] };
    }).mockImplementationOnce(async (sql: string, parameters?: readonly unknown[]) => {
      expect(sql).toContain("UPDATE bank_external_accounts external");
      expect(parameters?.[5]).toBe("CASH");
      return { rows: [{ id: ids.external }] };
    });
    await expect(mapBankExternalAccount(command())).resolves.toMatchObject({ mapped: true });

    vi.clearAllMocks();
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query: mocks.query } as unknown as PoolClient));
    mocks.query.mockResolvedValueOnce({ rows: [selectedAccount({
      legal_entity_id: ids.entity,
      ledger_id: ids.ledger,
      cash_account_combination_id: ids.asset,
    })] });
    await expect(mapBankExternalAccount(command("CREDIT_CARD"))).rejects.toMatchObject({
      code: "ACCOUNT_KIND_CHANGE_NOT_ALLOWED",
      status: 409,
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query: mocks.query } as unknown as PoolClient));
    mocks.query
      .mockResolvedValueOnce({ rows: [selectedAccount()] })
      .mockResolvedValueOnce({ rows: [{ unsafe_history: true }] });
    await expect(mapBankExternalAccount(command("CREDIT_CARD"))).rejects.toMatchObject({
      code: "ACCOUNT_KIND_CHANGE_NOT_ALLOWED",
      status: 409,
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});
