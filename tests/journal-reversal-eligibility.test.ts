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

import { reversePostedJournal } from "@/modules/ledger/journal-service";

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

beforeEach(() => {
  process.env.BUSINESS_WRITES_ENABLED = "true";
  vi.clearAllMocks();
});

afterAll(() => {
  if (previousBusinessWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousBusinessWrites;
});

describe("general-ledger reversal eligibility", () => {
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
