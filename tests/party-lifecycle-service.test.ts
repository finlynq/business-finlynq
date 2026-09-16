import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTenantTransaction: vi.fn(),
  assertPermission: vi.fn(async () => undefined),
  assertRole: vi.fn(async () => undefined),
  assertWrites: vi.fn(),
  assertWritable: vi.fn(async () => ({ isDemo: false })),
  loadKey: vi.fn(async () => ({ dek: Buffer.alloc(32, 7), keyVersion: 4 })),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/identity/authorization", () => ({
  assertActorHasActivePermission: mocks.assertPermission,
  assertActorHasActiveOrganizationRole: mocks.assertRole,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: mocks.assertWrites,
  assertWritableOrganization: mocks.assertWritable,
}));
vi.mock("@/security/organization-key-store", () => ({
  loadActiveOrganizationKey: mocks.loadKey,
}));
vi.mock("@/security/organization-encryption", () => ({
  createBlindIndex: vi.fn(() => "corrected-name-token"),
  decryptField: vi.fn(() => "Maple Studios Ltd"),
  encryptField: vi.fn(() => ({ protected: "corrected-name" })),
  parseEncryptedField: vi.fn(() => ({ protected: "current-name" })),
  serializeEncryptedField: vi.fn(() => "serialized-corrected-name"),
}));

import { updateParty } from "@/modules/parties/party-lifecycle-service";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  session: "10000000-0000-4000-8000-000000000003",
  party: "20000000-0000-4000-8000-000000000001",
};

const context = {
  organizationId: ids.organization,
  actorId: ids.actor,
  sessionId: ids.session,
  sessionMode: "real" as const,
  requestId: "party-correction-test",
  authMethod: "password+mfa",
  sourceSurface: "UI" as const,
  reason: "Correct the registered party name",
};

const command = {
  context,
  partyId: ids.party,
  displayName: "Maple Studio Limited",
  active: true,
  expectedDisplayName: "Maple Studios Ltd",
  expectedActive: true,
  reason: context.reason,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadKey.mockImplementation(async () => ({
    dek: Buffer.alloc(32, 7),
    keyVersion: 4,
  }));
  const client = { query: mocks.query } as unknown as PoolClient;
  mocks.withTenantTransaction.mockImplementation(async (_context, work) => work(client));
});

describe("party owner correction", () => {
  it("renames a party in place with owner authorization and immutable audit evidence", async () => {
    mocks.query.mockImplementation(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("FROM parties") && statement.includes("FOR UPDATE")) {
        return { rows: [{
          id: ids.party,
          display_name_ciphertext: "encrypted-current-name",
          display_name_key_version: 3,
          active: true,
        }] };
      }
      if (statement.includes("duplicate_count")) return { rows: [{ duplicate_count: 0 }] };
      if (statement.includes("UPDATE parties")) {
        expect(parameters?.[5]).toBe(ids.party);
        return { rows: [{ id: ids.party, active: true }] };
      }
      if (statement.includes("append_tenant_business_audit")) {
        expect(parameters).toEqual([
          ids.organization,
          ids.party,
          "Maple Studios Ltd",
          "Maple Studio Limited",
          true,
          true,
          false,
        ]);
        return { rows: [{}] };
      }
      throw new Error(`Unexpected party correction SQL: ${statement}`);
    });

    await expect(updateParty(command)).resolves.toEqual({
      partyId: ids.party,
      displayName: "Maple Studio Limited",
      active: true,
      idempotentReplay: false,
      warnings: [],
    });
    expect(mocks.assertPermission).toHaveBeenCalled();
    expect(mocks.assertRole).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ids.organization,
      actorId: ids.actor,
      roleKeys: ["OWNER"],
    });
    expect(mocks.query.mock.calls.some(([statement]) =>
      String(statement).includes("UPDATE party_accounts")
    )).toBe(false);
  });

  it("requires current MFA assurance before opening a tenant transaction", async () => {
    await expect(updateParty({
      ...command,
      context: { ...context, authMethod: "password" },
    })).rejects.toThrow(/current MFA assurance/i);
    expect(mocks.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("returns an idempotent replay after the requested correction already succeeded", async () => {
    const encryption = await import("@/security/organization-encryption");
    vi.mocked(encryption.decryptField).mockReturnValueOnce("Maple Studio Limited");
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: ids.party,
      display_name_ciphertext: "encrypted-corrected-name",
      display_name_key_version: 4,
      active: true,
    }] });

    await expect(updateParty(command)).resolves.toMatchObject({
      partyId: ids.party,
      displayName: "Maple Studio Limited",
      idempotentReplay: true,
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("warns about, but does not silently merge, a duplicate display name", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        id: ids.party,
        display_name_ciphertext: "encrypted-current-name",
        display_name_key_version: 3,
        active: true,
      }] })
      .mockResolvedValueOnce({ rows: [{ duplicate_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: ids.party, active: true }] })
      .mockResolvedValueOnce({ rows: [{}] });

    await expect(updateParty(command)).resolves.toMatchObject({
      partyId: ids.party,
      warnings: ["Another active party has the same normalized display name."],
    });
  });
});
