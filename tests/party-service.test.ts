import type { PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertActorHasActivePermission: vi.fn(async () => undefined),
  assertWritableOrganization: vi.fn(async () => undefined),
  loadActiveOrganizationKey: vi.fn(async () => ({ dek: Buffer.alloc(32, 7), keyVersion: 3 })),
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/identity/authorization", () => ({
  assertActorHasActivePermission: mocks.assertActorHasActivePermission,
}));
vi.mock("@/modules/workspace/write-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/workspace/write-policy")>()),
  assertWritableOrganization: mocks.assertWritableOrganization,
}));
vi.mock("@/security/organization-key-store", () => ({
  loadActiveOrganizationKey: mocks.loadActiveOrganizationKey,
}));
vi.mock("@/security/organization-encryption", () => ({
  createBlindIndex: vi.fn(() => "blind-index"),
  decryptField: vi.fn(() => "Maple Studio"),
  encryptField: vi.fn(() => ({ protected: "ciphertext" })),
  parseEncryptedField: vi.fn(() => ({ protected: "ciphertext" })),
  serializeEncryptedField: vi.fn(() => "serialized-ciphertext"),
}));

import { createParty } from "@/modules/parties/party-service";

const previousBusinessWrites = process.env.BUSINESS_WRITES_ENABLED;
const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  entity: "10000000-0000-4000-8000-000000000003",
  ledger: "10000000-0000-4000-8000-000000000004",
  control: "10000000-0000-4000-8000-000000000005",
  party: "10000000-0000-4000-8000-000000000006",
  partyAccount: "10000000-0000-4000-8000-000000000007",
};
const command = {
  context: {
    organizationId: ids.organization,
    actorId: ids.actor,
    requestId: "party-service-test",
    authMethod: "password",
    sourceSurface: "UI" as const,
  },
  partyNumber: "cust-1001",
  displayName: "Maple Studio",
  idempotencyKey: "party-service-1",
  account: {
    legalEntityId: ids.entity,
    ledgerId: ids.ledger,
    role: "CUSTOMER" as const,
    accountNumber: "c-ca-1001",
    controlAccountId: ids.control,
    transactionCurrency: null,
  },
};

function partyRow(commandHash: string) {
  return {
    id: ids.party,
    party_number: "CUST-1001",
    display_name_ciphertext: "serialized-ciphertext",
    display_name_key_version: 3,
    active: true,
    internal_legal_entity_id: null,
    command_hash: commandHash,
  };
}

const partyAccountRow = {
  id: ids.partyAccount,
  legal_entity_id: ids.entity,
  ledger_id: ids.ledger,
  role: "CUSTOMER" as const,
  account_number: "C-CA-1001",
  control_account_id: ids.control,
  transaction_currency: null,
};

beforeEach(() => {
  process.env.BUSINESS_WRITES_ENABLED = "true";
  vi.clearAllMocks();
  mocks.loadActiveOrganizationKey.mockImplementation(async () => ({
    dek: Buffer.alloc(32, 7),
    keyVersion: 3,
  }));
});

afterAll(() => {
  if (previousBusinessWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousBusinessWrites;
});

describe("encrypted party and AR/AP account creation", () => {
  it("atomically creates an encrypted party with a validated customer control account", async () => {
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("INSERT INTO parties")) {
        return { rows: [partyRow(String(parameters?.[6]))] };
      }
      if (statement.includes("FROM legal_entities entity")) return { rows: [{ allowed: true }] };
      if (statement.includes("INSERT INTO party_accounts")) return { rows: [partyAccountRow] };
      throw new Error(`Unexpected party-service SQL: ${statement}`);
    });
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    await expect(createParty(command)).resolves.toEqual({
      party: {
        id: ids.party,
        partyNumber: "CUST-1001",
        displayName: "Maple Studio",
        active: true,
        internalLegalEntityId: null,
      },
      partyAccount: {
        id: ids.partyAccount,
        legalEntityId: ids.entity,
        ledgerId: ids.ledger,
        role: "CUSTOMER",
        accountNumber: "C-CA-1001",
        controlAccountId: ids.control,
        transactionCurrency: null,
      },
      idempotentReplay: false,
    });
    const setup = query.mock.calls.find(([statement]) => statement.includes("FROM legal_entities entity"));
    expect(setup?.[1]).toEqual([
      ids.organization,
      ids.entity,
      ids.ledger,
      "CUSTOMER",
      ids.control,
      null,
    ]);
    const insertedAccount = query.mock.calls.find(([statement]) => statement.includes("INSERT INTO party_accounts"));
    expect(insertedAccount?.[1]?.slice(1)).toEqual([
      ids.organization,
      ids.entity,
      ids.ledger,
      ids.party,
      "CUSTOMER",
      "C-CA-1001",
      ids.control,
      null,
    ]);
  });

  it("rejects a role/control mismatch without creating a party account", async () => {
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("INSERT INTO parties")) return { rows: [partyRow(String(parameters?.[6]))] };
      if (statement.includes("FROM legal_entities entity")) return { rows: [] };
      throw new Error(`Unexpected party-service SQL: ${statement}`);
    });
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    await expect(createParty({
      ...command,
      account: { ...command.account, role: "SUPPLIER" },
    })).rejects.toThrow(/active AR\/AP configuration/i);
    expect(query.mock.calls.some(([statement]) => statement.includes("INSERT INTO party_accounts"))).toBe(false);
  });
});
