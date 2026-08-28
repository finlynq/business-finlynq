import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  membership: "10000000-0000-4000-8000-000000000003",
  session: "10000000-0000-4000-8000-000000000004",
  party: "10000000-0000-4000-8000-000000000005",
  account: "10000000-0000-4000-8000-000000000006",
  entity: "10000000-0000-4000-8000-000000000007",
  address: "10000000-0000-4000-8000-000000000008",
};

const principal: SessionPrincipal = {
  sessionId: ids.session,
  userId: ids.user,
  organizationId: ids.organization,
  membershipId: ids.membership,
  organizationName: "Tenant",
  roleLabel: "Owner",
  displayName: "Owner",
  initials: "OW",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-08-27T00:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

const mocks = vi.hoisted(() => ({
  actorHasActivePermission: vi.fn(async () => true),
  principalCanWrite: vi.fn(() => true),
  withWorkspaceTenantRead: vi.fn(),
  decryptField: vi.fn((_field: unknown, _dek: Buffer, context: { recordId: string }) =>
    context.recordId === "10000000-0000-4000-8000-000000000008"
      ? JSON.stringify({
          line1: "184 Harbour Avenue",
          city: "Toronto",
          region: "ON",
          postalCode: "M5V 2T6",
          countryCode: "CA",
        })
      : "Harbour Dental Group"),
  loadActiveOrganizationKey: vi.fn(async () => ({ dek: Buffer.alloc(32), keyVersion: 1 })),
}));

vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: mocks.actorHasActivePermission,
}));
vi.mock("@/modules/identity/session", () => ({
  transactionAuthMethod: vi.fn(() => "password"),
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  principalCanWrite: mocks.principalCanWrite,
}));
vi.mock("@/modules/workspace/tenant-read", () => ({
  withWorkspaceTenantRead: mocks.withWorkspaceTenantRead,
}));
vi.mock("@/security/organization-encryption", () => ({
  createBlindIndex: vi.fn(() => "blind-index"),
  parseEncryptedField: vi.fn((value: string) => value),
  decryptField: mocks.decryptField,
}));
vi.mock("@/security/organization-key-store", () => ({
  loadActiveOrganizationKey: mocks.loadActiveOrganizationKey,
}));

import { loadTenantPartyDirectory } from "@/modules/ledger/tenant-workspace";

function databaseClient(): PoolClient {
  return {
    query: vi.fn(async (statement: string) => {
      if (statement.includes("FROM organization_memberships membership")) return { rows: [{ is_demo: false }] };
      if (statement.includes("organization_key_versions")) {
        return { rows: [{ entity_count: 2, ledger_count: 2, active_key_count: 1 }] };
      }
      if (statement.startsWith("SELECT count(*)::int AS count FROM parties")) return { rows: [{ count: 1 }] };
      if (statement.includes("SELECT id, party_number, display_name_ciphertext")) {
        return { rows: [{
          id: ids.party,
          party_number: "P-000184",
          display_name_ciphertext: "encrypted-name",
          display_name_key_version: 1,
          active: true,
        }] };
      }
      if (statement.includes("FROM party_accounts account")) {
        return { rows: [{
          id: ids.account,
          party_id: ids.party,
          legal_entity_id: ids.entity,
          entity_code: "CA01",
          entity_name: "Northstar Canada",
          ledger_code: "CA01-PRIMARY",
          role: "CUSTOMER",
          account_number: "C-CA-0001",
          transaction_currency: null,
          control_account_code: "1100",
          active: true,
        }] };
      }
      if (statement.includes("FROM party_addresses")) {
        return { rows: [{
          id: ids.address,
          party_id: ids.party,
          kind: "BILLING",
          ciphertext: "encrypted-address",
          key_version: "1",
          valid_from: "2026-01-01",
          valid_to: null,
        }] };
      }
      throw new Error(`Unexpected party directory SQL: ${statement}`);
    }),
  } as unknown as PoolClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actorHasActivePermission.mockResolvedValue(true);
  mocks.principalCanWrite.mockReturnValue(true);
  mocks.loadActiveOrganizationKey.mockResolvedValue({ dek: Buffer.alloc(32), keyVersion: 1 });
});

describe("organization-wide party directory", () => {
  it("returns one encrypted party with its legal-entity roles and shared addresses", async () => {
    const client = databaseClient();
    mocks.withWorkspaceTenantRead.mockImplementation(async (
      context: unknown,
      nextPath: string,
      work: (client: PoolClient) => Promise<unknown>,
    ) => {
      expect(context).toMatchObject({ organizationId: ids.organization, actorId: ids.user });
      expect(nextPath).toBe("/app/parties");
      return work(client);
    });

    const directory = await loadTenantPartyDirectory(principal);
    expect(directory.parties).toEqual([expect.objectContaining({
      id: ids.party,
      partyNumber: "P-000184",
      displayName: "Harbour Dental Group",
      accounts: [expect.objectContaining({
        entityCode: "CA01",
        role: "CUSTOMER",
        accountNumber: "C-CA-0001",
      })],
      addresses: [expect.objectContaining({
        kind: "BILLING",
        line1: "184 Harbour Avenue",
        city: "Toronto",
        countryCode: "CA",
      })],
    })]);

    const query = client.query as ReturnType<typeof vi.fn>;
    const accountQuery = query.mock.calls.find(([statement]) =>
      String(statement).includes("FROM party_accounts account"));
    const addressQuery = query.mock.calls.find(([statement]) =>
      String(statement).includes("FROM party_addresses"));
    expect(accountQuery?.[1]).toEqual([ids.organization, [ids.party]]);
    expect(addressQuery?.[1]).toEqual([ids.organization, [ids.party]]);
  });
});
