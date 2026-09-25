import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTenantTransaction: vi.fn(),
  assertTenantWritesEnabled: vi.fn(),
  assertWritableOrganization: vi.fn(async () => ({ isDemo: false })),
  decryptEmailValue: vi.fn(async (_client, _row, _table, _column, ciphertext: string) => ciphertext.slice("encrypted:".length)),
  encryptEmailValue: vi.fn(async (_client, _row, _table, _column, value: string) => `encrypted:${value}`),
  activeEmailKeyVersion: vi.fn(async () => 1),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: mocks.assertTenantWritesEnabled,
  assertWritableOrganization: mocks.assertWritableOrganization,
}));
vi.mock("@/modules/identity/authorization", () => ({
  assertActorHasActivePermission: vi.fn(),
}));
vi.mock("@/modules/email/crypto", () => ({
  decryptEmailValue: mocks.decryptEmailValue,
  encryptEmailValue: mocks.encryptEmailValue,
  activeEmailKeyVersion: mocks.activeEmailKeyVersion,
}));

import {
  configurePersonalEmailAlias,
  getPersonalEmailAlias,
  provisionPersonalEmailAlias,
} from "@/modules/email/configuration";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  membership: "10000000-0000-4000-8000-000000000003",
  otherMembership: "10000000-0000-4000-8000-000000000004",
  alias: "10000000-0000-4000-8000-000000000005",
};

const context = {
  organizationId: ids.organization,
  actorId: ids.user,
  sessionId: "10000000-0000-4000-8000-000000000006",
  sessionMode: "real" as const,
  requestId: "personal-email-test",
  authMethod: "password+mfa",
  sourceSurface: "API" as const,
};

function aliasRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.alias,
    organization_id: ids.organization,
    owner_membership_id: ids.membership,
    legal_entity_id: null,
    connection_id: null,
    provider: "RESEND",
    label: "Personal document inbox",
    purpose: "GENERAL",
    address_digest: "a".repeat(64),
    address_ciphertext: "encrypted:in+opaque@inbound.dev.business.finlynq.com",
    key_version: 1,
    status: "ACTIVE",
    version: 1,
    hourly_limit: 25,
    max_payload_bytes: 10 * 1024 * 1024,
    idempotency_key: "personal-test",
    command_hash: "b".repeat(64),
    created_by: ids.user,
    created_at: new Date("2026-09-25T00:00:00Z"),
    updated_at: new Date("2026-09-25T00:00:00Z"),
    retired_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN = "inbound.dev.business.finlynq.com";
  const client = { query: mocks.query } as unknown as PoolClient;
  mocks.withTenantTransaction.mockImplementation(async (_context, work) => work(client));
});

describe("personal inbound email ownership", () => {
  it("returns only the current actor's active membership-owned alias", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [aliasRow()] });

    await expect(getPersonalEmailAlias(context, ids.membership)).resolves.toMatchObject({
      id: ids.alias,
      address: "in+opaque@inbound.dev.business.finlynq.com",
      personal: true,
    });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([ids.organization, ids.membership, ids.user]);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([ids.organization, ids.membership]);
  });

  it("rejects another membership before reading any alias", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await expect(getPersonalEmailAlias(context, ids.otherMembership)).rejects.toThrow(/membership is not active/i);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("binds configuration changes to the exact current alias as well as its version", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [aliasRow()] });

    await expect(configurePersonalEmailAlias({
      context,
      membershipId: ids.membership,
      aliasId: "10000000-0000-4000-8000-000000000099",
      expectedVersion: 1,
      connectionId: null,
      reason: "Update my personal email routing",
    })).rejects.toThrow(/changed; reload/i);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("provisions a 128-bit opaque address owned by the exact membership", async () => {
    mocks.query.mockImplementation(async (text: string, values?: unknown[]) => {
      if (text.includes("FROM organization_memberships membership")) return { rows: [{ exists: true }] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("SELECT * FROM email_ingestion_aliases")) return { rows: [] };
      if (text.includes("INSERT INTO email_ingestion_aliases")) {
        return { rows: [aliasRow({
          id: values?.[0],
          owner_membership_id: values?.[2],
          connection_id: values?.[3],
          address_digest: values?.[4],
          address_ciphertext: values?.[5],
          key_version: values?.[6],
          idempotency_key: values?.[8],
          command_hash: values?.[9],
          created_by: values?.[10],
        })] };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    const result = await provisionPersonalEmailAlias({
      context,
      membershipId: ids.membership,
      reason: "Create my personal inbound address",
    });

    expect(result.alias.address).toMatch(/^in\+[a-f0-9]{32}@inbound\.dev\.business\.finlynq\.com$/);
    const insert = mocks.query.mock.calls.find(([text]) => String(text).includes("INSERT INTO email_ingestion_aliases"));
    expect(insert?.[1]?.[2]).toBe(ids.membership);
    expect(insert?.[1]?.[10]).toBe(ids.user);
    expect(mocks.assertTenantWritesEnabled).toHaveBeenCalledWith(context);
    expect(mocks.assertWritableOrganization).toHaveBeenCalled();
  });
});
