import { createHash } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertActorHasActivePermission: vi.fn(async () => undefined),
  assertWritableOrganization: vi.fn(async () => undefined),
  postJournalInTransaction: vi.fn(),
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: vi.fn(),
  assertActorHasActivePermission: mocks.assertActorHasActivePermission,
}));
vi.mock("@/modules/ledger/posting-service", () => ({
  postJournalInTransaction: mocks.postJournalInTransaction,
}));
vi.mock("@/modules/workspace/write-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/workspace/write-policy")>()),
  assertWritableOrganization: mocks.assertWritableOrganization,
}));

import {
  createManualJournal,
  reversePostedJournal,
} from "@/modules/ledger/journal-service";

const previousBusinessWrites = process.env.BUSINESS_WRITES_ENABLED;
const command = {
  context: {
    organizationId: "10000000-0000-4000-8000-000000000001",
    actorId: "10000000-0000-4000-8000-000000000002",
    requestId: "reversal-eligibility-test",
    authMethod: "password",
    sourceSurface: "UI" as const,
    reason: "Correct the accounting entry through an audited reversal",
  },
  originalJournalId: "10000000-0000-4000-8000-000000000003",
  periodId: "10000000-0000-4000-8000-000000000004",
  accountingDate: "2026-08-27",
  description: "Audited full reversal",
  reason: "Correct the accounting entry through an audited reversal",
  idempotencyKey: "reversal-eligibility-1",
};

function legacyReversalFingerprint(): string {
  return createHash("sha256").update(JSON.stringify({
    originalJournalId: command.originalJournalId,
    periodId: command.periodId,
    accountingDate: command.accountingDate,
    description: command.description,
    reason: command.reason,
    idempotencyKey: command.idempotencyKey,
  }), "utf8").digest("hex");
}

const originalManualJournal = {
  id: command.originalJournalId,
  ledger_id: "10000000-0000-4000-8000-000000000005",
  legal_entity_id: "10000000-0000-4000-8000-000000000006",
  functional_currency: "CAD",
  status: "POSTED",
  owner_module: "ledger",
  journal_type_key: "ledger.manual",
};

const manualCommand = {
  context: command.context,
  ledgerId: "10000000-0000-4000-8000-000000000005",
  legalEntityId: "10000000-0000-4000-8000-000000000006",
  periodId: command.periodId,
  accountingDate: "2026-08-27",
  purpose: "ROUTINE" as const,
  origin: "USER" as const,
  description: "Legacy replay manual journal",
  idempotencyKey: "manual-journal-legacy-1",
  lines: [
    {
      accountCombinationId: "10000000-0000-4000-8000-000000000008",
      debitFunctional: "100.00",
      creditFunctional: "0",
      transactionCurrency: "CAD",
      debitTransaction: "100.00",
      creditTransaction: "0",
      fxRate: "1",
      fxRateSource: "FUNCTIONAL",
      fxRateEffectiveAt: "2026-08-27T12:00:00.000Z",
      memo: "Debit",
    },
    {
      accountCombinationId: "10000000-0000-4000-8000-000000000009",
      debitFunctional: "0",
      creditFunctional: "100.00",
      transactionCurrency: "CAD",
      debitTransaction: "0",
      creditTransaction: "100.00",
      fxRate: "1",
      fxRateSource: "FUNCTIONAL",
      fxRateEffectiveAt: "2026-08-27T12:00:00.000Z",
      memo: "Credit",
    },
  ],
};

function legacyManualJournalFingerprint(): string {
  const { context: _context, ...payload } = manualCommand;
  void _context;
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

beforeEach(() => {
  process.env.BUSINESS_WRITES_ENABLED = "true";
  vi.clearAllMocks();
});

afterAll(() => {
  if (previousBusinessWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousBusinessWrites;
});

describe("general-ledger reversal eligibility", () => {
  it("persists every manual-journal line in one parameterized batch without changing line order", async () => {
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("FROM ledgers ledger")) {
        return { rows: [{
          functional_currency: "CAD",
          period_state: "OPEN",
          starts_on: "2026-08-01",
          ends_on: "2026-08-31",
          journal_type_definition_id: "10000000-0000-4000-8000-000000000010",
          journal_type_version: 1,
          manual_mode: "REVIEW_REQUIRED",
        }] };
      }
      if (statement.includes("FROM account_combinations combination")) {
        return { rows: manualCommand.lines.map((line) => ({ id: line.accountCombinationId })) };
      }
      if (statement.includes("INSERT INTO journal_entries")) {
        return { rows: [{
          id: parameters?.[0],
          command_hash: parameters?.[9],
          status: "DRAFT",
          journal_number: null,
        }] };
      }
      if (statement.includes("INSERT INTO journal_lines")) return { rows: [] };
      throw new Error(`Unexpected batched manual-journal SQL: ${statement}`);
    });
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    const created = await createManualJournal(manualCommand);

    const lineInserts = query.mock.calls.filter(([statement]) => (
      statement.includes("INSERT INTO journal_lines")
    ));
    expect(lineInserts).toHaveLength(1);
    expect(lineInserts[0]?.[0]).toContain("FROM unnest(");
    expect(lineInserts[0]?.[1]?.slice(0, 3)).toEqual([
      command.context.organizationId,
      manualCommand.ledgerId,
      created.journalId,
    ]);
    expect(lineInserts[0]?.[1]?.[3]).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    ]);
    expect(lineInserts[0]?.[1]?.[4]).toEqual([1, 2]);
    expect(lineInserts[0]?.[1]?.[5]).toEqual(
      manualCommand.lines.map((line) => line.accountCombinationId),
    );
    expect(lineInserts[0]?.[1]?.[6]).toEqual(["100.00", "0"]);
    expect(lineInserts[0]?.[1]?.[7]).toEqual(["0", "100.00"]);
    expect(lineInserts[0]?.[1]?.[14]).toEqual(["Debit", "Credit"]);
    expect(created).toMatchObject({
      status: "DRAFT",
      idempotentReplay: false,
      autoPosted: false,
    });
    expect(mocks.postJournalInTransaction).not.toHaveBeenCalled();
  });

  it("accepts the exact legacy manual-journal fingerprint during replay transition", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("FROM ledgers ledger")) {
        return { rows: [{
          functional_currency: "CAD",
          period_state: "OPEN",
          starts_on: "2026-08-01",
          ends_on: "2026-08-31",
          journal_type_definition_id: "10000000-0000-4000-8000-000000000010",
          journal_type_version: 1,
          manual_mode: "REVIEW_REQUIRED",
        }] };
      }
      if (statement.includes("FROM account_combinations combination")) {
        return { rows: manualCommand.lines.map((line) => ({ id: line.accountCombinationId })) };
      }
      if (statement.includes("INSERT INTO journal_entries")) return { rows: [] };
      if (statement.includes("FROM journal_entries") && statement.includes("idempotency_key")) {
        return { rows: [{
          id: "10000000-0000-4000-8000-000000000011",
          command_hash: legacyManualJournalFingerprint(),
          status: "DRAFT",
          journal_number: null,
        }] };
      }
      throw new Error(`Unexpected legacy manual-journal replay SQL: ${statement}`);
    });
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    await expect(createManualJournal(manualCommand)).resolves.toEqual({
      journalId: "10000000-0000-4000-8000-000000000011",
      status: "DRAFT",
      journalNumber: null,
      idempotentReplay: true,
      autoPosted: false,
    });
    expect(mocks.postJournalInTransaction).not.toHaveBeenCalled();
  });

  it("accepts the exact legacy reversal fingerprint during replay transition", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("FROM journal_entries entry")) return { rows: [originalManualJournal] };
      if (statement.includes("FROM journal_entry_relations relation")) {
        return { rows: [{
          id: "10000000-0000-4000-8000-000000000007",
          command_hash: legacyReversalFingerprint(),
          status: "POSTED",
          journal_number: 108,
        }] };
      }
      throw new Error(`Unexpected legacy reversal replay SQL: ${statement}`);
    });
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    await expect(reversePostedJournal(command)).resolves.toEqual({
      journalId: "10000000-0000-4000-8000-000000000007",
      status: "POSTED",
      journalNumber: 108,
      idempotentReplay: true,
      autoPosted: false,
    });
    expect(mocks.postJournalInTransaction).not.toHaveBeenCalled();
  });

  it("rejects a reversal replay with a conflicting fingerprint", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("FROM journal_entries entry")) return { rows: [originalManualJournal] };
      if (statement.includes("FROM journal_entry_relations relation")) {
        return { rows: [{
          id: "10000000-0000-4000-8000-000000000007",
          command_hash: "f".repeat(64),
          status: "POSTED",
          journal_number: 108,
        }] };
      }
      throw new Error(`Unexpected conflicting reversal replay SQL: ${statement}`);
    });
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    await expect(reversePostedJournal(command)).rejects.toThrow(
      "Journal already has a different full reversal",
    );
    expect(mocks.postJournalInTransaction).not.toHaveBeenCalled();
  });

  it.each(["ledger.reversal", "ledger.closing", "ledger.system-generated"])(
    "rejects posted ledger-owned %s journals before creating another reversal",
    async (journalTypeKey) => {
      const query = vi.fn(async (statement: string) => {
        if (statement.includes("FROM journal_entries entry")) {
          return { rows: [{
            id: command.originalJournalId,
            ledger_id: "10000000-0000-4000-8000-000000000005",
            legal_entity_id: "10000000-0000-4000-8000-000000000006",
            functional_currency: "CAD",
            status: "POSTED",
            owner_module: "ledger",
            journal_type_key: journalTypeKey,
          }] };
        }
        throw new Error(`Unexpected reversal SQL: ${statement}`);
      });
      mocks.withTenantTransaction.mockImplementation(async (
        _context: unknown,
        work: (client: PoolClient) => Promise<unknown>,
      ) => work({ query } as unknown as PoolClient));

      await expect(reversePostedJournal(command)).rejects.toThrow(
        "Only a posted ledger.manual journal can be reversed",
      );
      expect(query).toHaveBeenCalledTimes(1);
      expect(mocks.postJournalInTransaction).not.toHaveBeenCalled();
    },
  );
});
