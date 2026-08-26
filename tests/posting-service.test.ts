import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transactionMocks = vi.hoisted(() => ({
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: transactionMocks.withTenantTransaction,
}));

import { postJournal } from "@/modules/ledger/posting-service";

const previousWritesSetting = process.env.BUSINESS_WRITES_ENABLED;
const canonicalHash = "a".repeat(64);
const ids = {
  organization: "11111111-1111-4111-8111-111111111111",
  actor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  journal: "99999999-9999-4999-8999-999999999991",
  ledger: "44444444-4444-4444-8444-444444444444",
};

const context = {
  organizationId: ids.organization,
  actorId: ids.actor,
  requestId: "posting-unit-test",
  authMethod: "password+mfa",
  sourceSurface: "UI" as const,
};

function fakeClient(input: Readonly<{
  permissionAllowed?: boolean;
  status?: "DRAFT" | "SUBMITTED" | "APPROVED" | "POSTED" | "REVERSED";
  databaseHash?: string | null;
  storedHash?: string | null;
  journalNumber?: number | null;
}> = {}) {
  const status = input.status ?? "DRAFT";
  const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
    void parameters;
    if (statement.includes("FROM organization_memberships")) {
      return { rows: input.permissionAllowed === false ? [] : [{ allowed: true }] };
    }
    if (statement.includes("FROM journal_entries")) {
      return {
        rows: [{
          id: ids.journal,
          organization_id: ids.organization,
          ledger_id: ids.ledger,
          status,
          content_hash: input.storedHash ?? null,
          journal_number: input.journalNumber ?? null,
        }],
      };
    }
    if (statement.includes("app.compute_journal_content_hash")) {
      return { rows: [{ content_hash: input.databaseHash ?? canonicalHash }] };
    }
    if (statement.includes("UPDATE journal_entries")) {
      return { rows: [{ id: ids.journal, journal_number: 42 }] };
    }
    throw new Error(`Unexpected SQL in posting test: ${statement}`);
  });

  return { client: { query } as unknown as PoolClient, query };
}

beforeEach(() => {
  process.env.BUSINESS_WRITES_ENABLED = "true";
  transactionMocks.withTenantTransaction.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (previousWritesSetting === undefined) {
    delete process.env.BUSINESS_WRITES_ENABLED;
  } else {
    process.env.BUSINESS_WRITES_ENABLED = previousWritesSetting;
  }
});

describe("posting service authorization and content integrity", () => {
  it("fails closed before opening a transaction unless writes are explicitly enabled", async () => {
    delete process.env.BUSINESS_WRITES_ENABLED;

    await expect(postJournal({ context, journalId: ids.journal })).rejects.toThrow(
      "Business writes are disabled",
    );
    expect(transactionMocks.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("resolves posting permission from active database membership", async () => {
    const { client, query } = fakeClient({ permissionAllowed: false });
    transactionMocks.withTenantTransaction.mockImplementation(
      async (_context, work: (transactionClient: PoolClient) => Promise<unknown>) => work(client),
    );

    const commandWithForgedLegacyPermission = {
      context,
      journalId: ids.journal,
      actorPermissions: new Set(["ledger.journal.post"]),
    } as unknown as Parameters<typeof postJournal>[0];

    await expect(postJournal(commandWithForgedLegacyPermission)).rejects.toThrow(
      "Posting permission is required for an active organization member",
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      ids.organization,
      ids.actor,
      "ledger.journal.post",
    ]);
  });

  it("posts using only the canonical database hash", async () => {
    const { client, query } = fakeClient();
    transactionMocks.withTenantTransaction.mockImplementation(
      async (_context, work: (transactionClient: PoolClient) => Promise<unknown>) => work(client),
    );

    await expect(
      postJournal({
        context,
        journalId: ids.journal,
        expectedContentHash: canonicalHash.toUpperCase(),
      }),
    ).resolves.toEqual({
      journalId: ids.journal,
      journalNumber: 42,
      status: "POSTED",
      idempotentReplay: false,
    });

    const updateCall = query.mock.calls.find(([statement]) =>
      statement.includes("UPDATE journal_entries"),
    );
    expect(updateCall?.[1]).toEqual([
      canonicalHash,
      ids.journal,
      ids.organization,
      "DRAFT",
    ]);
  });

  it("rejects an optimistic hash mismatch before allocating a journal number", async () => {
    const { client, query } = fakeClient();
    transactionMocks.withTenantTransaction.mockImplementation(
      async (_context, work: (transactionClient: PoolClient) => Promise<unknown>) => work(client),
    );

    await expect(
      postJournal({
        context,
        journalId: ids.journal,
        expectedContentHash: "b".repeat(64),
      }),
    ).rejects.toThrow("Journal content changed");
    expect(query.mock.calls.some(([statement]) => statement.includes("UPDATE journal_entries"))).toBe(false);
  });

  it("validates canonical content again for an idempotent replay", async () => {
    const { client } = fakeClient({
      status: "POSTED",
      storedHash: canonicalHash,
      journalNumber: 42,
    });
    transactionMocks.withTenantTransaction.mockImplementation(
      async (_context, work: (transactionClient: PoolClient) => Promise<unknown>) => work(client),
    );

    await expect(postJournal({ context, journalId: ids.journal })).resolves.toMatchObject({
      journalNumber: 42,
      idempotentReplay: true,
    });
  });
});
