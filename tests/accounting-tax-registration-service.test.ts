import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantTransaction: vi.fn(),
  assertTenantWritesEnabled: vi.fn(),
  assertWritableOrganization: vi.fn(async () => undefined),
  encryptField: vi.fn(() => ({ protected: "ciphertext" })),
  serializeEncryptedField: vi.fn(() => "serialized-registration-ciphertext"),
  loadActiveOrganizationKey: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: mocks.assertTenantWritesEnabled,
  assertWritableOrganization: mocks.assertWritableOrganization,
  demoWritesEnabled: vi.fn(() => true),
  mutationContext: vi.fn((principal: { organizationId: string; userId: string }, requestId: string) => ({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    requestId,
    authMethod: "demo-link",
    sourceSurface: "API",
  })),
  principalCanWrite: vi.fn(() => true),
}));
vi.mock("@/security/organization-encryption", () => ({
  decryptField: vi.fn(),
  encryptField: mocks.encryptField,
  parseEncryptedField: vi.fn(),
  serializeEncryptedField: mocks.serializeEncryptedField,
}));
vi.mock("@/security/organization-key-store", () => ({
  loadActiveOrganizationKey: mocks.loadActiveOrganizationKey,
}));
vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: vi.fn(async () => true),
}));

import { configureTaxRegistration } from "@/modules/ledger/accounting-configuration";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  membership: "10000000-0000-4000-8000-000000000003",
  session: "10000000-0000-4000-8000-000000000004",
  entity: "10000000-0000-4000-8000-000000000005",
};

const principal = {
  sessionId: ids.session,
  userId: ids.user,
  organizationId: ids.organization,
  membershipId: ids.membership,
  organizationName: "Writable demo",
  roleLabel: "Demo accountant",
  displayName: "Demo user",
  initials: "DU",
  sessionMode: "demo" as const,
  authMethod: "DEMO_LINK" as const,
  expiresAt: new Date("2026-08-28T12:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tax registration encryption boundary", () => {
  it("encrypts the reference with record-bound AAD and sends only ciphertext to the database function", async () => {
    const dek = Buffer.alloc(32, 7);
    mocks.loadActiveOrganizationKey.mockResolvedValue({ dek, keyVersion: 4 });
    const query = vi.fn(async (_statement: string, parameters?: readonly unknown[]) => ({
      rows: [{ id: parameters?.[0] }],
    }));
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    const result = await configureTaxRegistration({
      principal,
      requestId: "tax-registration-test",
      legalEntityId: ids.entity,
      regimeKey: "us.wa.sales-use",
      registrationReference: "WA-SECRET-12345",
      destinationCountry: "US",
      destinationRegion: "WA",
      destinationCity: "Seattle",
      locationCode: "1726",
      configurationEvidence: "Washington DOR lookup confirmation 2026-08-27",
      validFrom: "2026-08-27",
      validTo: null,
      reason: "Configure verified Washington sourcing",
    });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.encryptField).toHaveBeenCalledWith(
      "WA-SECRET-12345",
      dek,
      {
        organizationId: ids.organization,
        table: "entity_tax_registrations",
        column: "registration_ciphertext",
        recordId: result.id,
        keyVersion: 4,
      },
    );
    const [statement, parameters] = query.mock.calls[0] ?? [];
    expect(statement).toContain("app.accounting_add_tax_registration");
    expect(parameters).toContain("serialized-registration-ciphertext");
    expect(parameters).not.toContain("WA-SECRET-12345");
    expect([...dek]).toEqual(Array.from({ length: 32 }, () => 0));
  });
});
