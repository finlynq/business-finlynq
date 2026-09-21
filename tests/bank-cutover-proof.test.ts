import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTenantTransaction: vi.fn(),
  assertPermission: vi.fn(async () => undefined),
  assertWrites: vi.fn(),
  assertWritable: vi.fn(async () => ({ isDemo: false })),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/identity/authorization", () => ({
  assertActorHasActivePermission: mocks.assertPermission,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: mocks.assertWrites,
  assertWritableOrganization: mocks.assertWritable,
  principalCanWrite: () => true,
  mutationContext: (principal: { organizationId: string; userId: string }, requestId: string, details: { reason: string; sourceSurface: string }) => ({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    requestId,
    authMethod: "oauth2.1+pkce",
    ...details,
  }),
}));

import {
  commitBankAccountCutover,
  previewBankAccountCutover,
} from "@/modules/banking/cutover-service";

function uuid(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

const ids = {
  organization: uuid(1),
  actor: uuid(2),
  membership: uuid(3),
  reconciliation: uuid(4),
  entity: uuid(5),
  ledger: uuid(6),
  predecessor: uuid(7),
  successor: uuid(8),
  predecessorMigration: uuid(9),
  successorMigration: uuid(10),
};

const principal = {
  sessionId: uuid(11),
  userId: ids.actor,
  organizationId: ids.organization,
  membershipId: ids.membership,
  organizationName: "Cutover fixture",
  roleLabel: "Accountant",
  displayName: "Test accountant",
  initials: "TA",
  sessionMode: "real" as const,
  authMethod: "OIDC" as const,
  expiresAt: new Date("2026-09-22T00:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

function line(id: string, accountingDate: string, amount: string) {
  return { id, journalId: uuid(900 + Number(id.slice(-3))), accountingDate, amount };
}

const predecessorAmounts = ["242.89", ...Array.from({ length: 9 }, () => "16.39")];
const successorAmounts = ["-226.50", ...Array.from({ length: 11 }, () => "-16.39")];
const predecessorLines = predecessorAmounts.map((amount, index) => line(uuid(100 + index), `2025-${String(index + 3).padStart(2, "0")}-07`, amount));
const successorLines = successorAmounts.map((amount, index) => line(uuid(200 + index), `2025-${String(index + 1).padStart(2, "0")}-18`, amount));
const positiveObservations = predecessorAmounts.map((amount, index) => ({
  id: uuid(300 + index),
  postedOn: index === 5 ? "2025-08-06" : predecessorLines[index]!.accountingDate,
  amount,
}));
const negativeObservations = successorAmounts.map((amount, index) => ({ id: uuid(400 + index), postedOn: successorLines[index]!.accountingDate, amount }));
const observations = [...positiveObservations, ...negativeObservations];
const migrationLines = [
  { ...line(ids.predecessorMigration, "2025-12-31", "-390.40"), accountCombinationId: ids.predecessor },
  { ...line(ids.successorMigration, "2025-12-31", "390.40"), accountCombinationId: ids.successor },
];
const allocations = [
  ...positiveObservations.map((observation, index) => ({
    id: uuid(500 + index),
    observationVersionId: observation.id,
    observationPostedOn: observation.postedOn,
    observationAmount: observation.amount,
    journalLineId: ids.successorMigration,
    journalLineAccountCombinationId: ids.successor,
    journalLineAmount: "390.40",
    allocatedAmount: observation.amount,
  })),
  ...negativeObservations.map((observation, index) => ({
    id: uuid(600 + index),
    observationVersionId: observation.id,
    observationPostedOn: observation.postedOn,
    observationAmount: observation.amount,
    journalLineId: successorLines[index]!.id,
    journalLineAccountCombinationId: ids.successor,
    journalLineAmount: successorLines[index]!.amount,
    allocatedAmount: observation.amount.slice(1),
  })),
];

function installFixture(overrides: Readonly<{
  observations?: typeof observations;
  predecessorLines?: typeof predecessorLines;
  successorLines?: typeof successorLines;
  migrationLines?: typeof migrationLines;
  allocations?: typeof allocations;
}> = {}) {
  let committed: Readonly<{
    id: string;
    command_hash: string;
    confirmation_hash: string;
    version: number;
    state: string;
  }> | undefined;
  let insertCount = 0;
  const fixture = {
    observations: overrides.observations ?? observations,
    predecessorLines: overrides.predecessorLines ?? predecessorLines,
    successorLines: overrides.successorLines ?? successorLines,
    migrationLines: overrides.migrationLines ?? migrationLines,
    allocations: overrides.allocations ?? allocations,
  };
  mocks.query.mockImplementation(async (statement: string, parameters?: readonly unknown[]) => {
    if (statement.includes("SELECT id, command_hash, confirmation_hash, version, state FROM bank_account_cutovers")) {
      return { rows: committed ? [committed] : [] };
    }
    if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (statement.includes("SELECT id FROM bank_account_cutovers cutover")) return { rows: [] };
    if (statement.includes("INSERT INTO bank_account_cutovers")) {
      insertCount += 1;
      committed = {
        id: String(parameters?.[0]),
        command_hash: String(parameters?.[11]),
        confirmation_hash: String(parameters?.[8]),
        version: 1,
        state: "ACTIVE",
      };
      return { rows: [] };
    }
    if (statement.includes("FROM bank_reconciliation_sessions reconciliation")) {
      return { rows: [{
        id: ids.reconciliation,
        status: "DRAFT",
        legal_entity_id: ids.entity,
        ledger_id: ids.ledger,
        successor_id: ids.successor,
        currency_code: "CAD",
        statement_start_on: "2025-01-01",
        statement_end_on: "2026-07-21",
      }] };
    }
    if (statement.includes("SELECT combination.id, account.class")) {
      return { rows: [{ id: ids.predecessor, account_class: "LIABILITY", code: "2100" }] };
    }
    if (statement.includes("SELECT account.class::text")) {
      return { rows: [{ account_class: "LIABILITY", code: "2110" }] };
    }
    if (statement.includes("WITH latest AS")) return { rows: fixture.observations };
    if (statement.includes("line.id=ANY")) return { rows: fixture.migrationLines };
    if (statement.includes("FROM bank_match_allocations allocation") && statement.includes("JOIN bank_observation_versions")) {
      return { rows: fixture.allocations };
    }
    if (statement.includes("line.account_combination_id=$2") && statement.includes("AND EXISTS")) {
      return { rows: fixture.successorLines };
    }
    if (statement.includes("line.account_combination_id=$2")) return { rows: fixture.predecessorLines };
    throw new Error(`Unexpected cutover SQL: ${statement}`);
  });
  return {
    get insertCount() { return insertCount; },
  };
}

async function preview() {
  return previewBankAccountCutover({
    principal,
    requestId: `cutover-preview-${randomUUID()}`,
    reconciliationId: ids.reconciliation,
    predecessorAccountCombinationId: ids.predecessor,
    effectiveOn: "2025-12-31",
    migrationJournalLineIds: [ids.predecessorMigration, ids.successorMigration],
    reason: "Migrate corporate card account permanently",
  });
}

async function commit(confirmationHash: string, idempotencyKey: string) {
  return commitBankAccountCutover({
    principal,
    requestId: `cutover-commit-${randomUUID()}`,
    reconciliationId: ids.reconciliation,
    predecessorAccountCombinationId: ids.predecessor,
    effectiveOn: "2025-12-31",
    migrationJournalLineIds: [ids.predecessorMigration, ids.successorMigration],
    reason: "Migrate corporate card account permanently",
    expectedVersion: 0,
    confirmationHash,
    idempotencyKey,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  const client = { query: mocks.query } as unknown as PoolClient;
  mocks.withTenantTransaction.mockImplementation(async (_context, work) => work(client));
});

describe("bank cutover proof population", () => {
  it("reconciles mixed predecessor and allocated-successor activity without changing allocations", async () => {
    installFixture();
    const first = await preview();
    const second = await preview();

    expect(first.confirmationHash).toBe(second.confirmationHash);
    expect(first.writesPerformed).toBe(false);
    expect(first.proof).toMatchObject({
      grossObservationCount: 22,
      activeAllocationCount: 22,
      matchedObservationCount: 22,
      matchedLedgerLineCount: 22,
      predecessorLedgerLineCount: 10,
      successorLedgerLineCount: 12,
      unmatchedObservationCount: 0,
      unmatchedPredecessorLedgerLineCount: 0,
      unmatchedSuccessorLedgerLineCount: 0,
      observationNet: "-16.39",
      predecessorLedgerNet: "390.40",
      successorLedgerNet: "-406.79",
      authorizedLedgerNet: "-16.39",
      predecessorMigrationNet: "-390.40",
      successorMigrationNet: "390.40",
      migrationAllocationLineageNet: "390.40",
      remainingDifference: "0.00",
      exceptions: [],
    });
    expect(first.proof.predecessorLineDispositions).toHaveLength(10);
    expect(first.proof.predecessorLineDispositions.every((item) => (
      item.disposition === "MIGRATION_ALLOCATION_LINEAGE" &&
      item.allocationIds.length === 1 &&
      item.migrationJournalLineId === ids.successorMigration
    ))).toBe(true);
    expect(first.proof.predecessorLineDispositions).toEqual(expect.arrayContaining([
      expect.objectContaining({ dateDifferenceDays: 1 }),
    ]));
    expect(first.proof.existingAllocations).toEqual(allocations);
  });

  it("preserves a zero-difference gross control cutover with no existing allocations", async () => {
    const controlPredecessor = [line(uuid(700), "2025-01-30", "100.00")];
    const controlObservations = [{ id: uuid(701), postedOn: "2025-01-30", amount: "100.00" }];
    const controlMigration = [
      { ...line(ids.predecessorMigration, "2025-12-31", "-100.00"), accountCombinationId: ids.predecessor },
      { ...line(ids.successorMigration, "2025-12-31", "100.00"), accountCombinationId: ids.successor },
    ];
    installFixture({
      observations: controlObservations,
      predecessorLines: controlPredecessor,
      successorLines: [],
      migrationLines: controlMigration,
      allocations: [],
    });

    const result = await preview();
    expect(result.proof).toMatchObject({
      remainingDifference: "0.00",
      predecessorLedgerNet: "100.00",
      successorLedgerNet: "0.00",
      predecessorMigrationNet: "-100.00",
      successorMigrationNet: "100.00",
      exceptions: [],
    });
    expect(result.proof.predecessorLineDispositions).toEqual([
      expect.objectContaining({ disposition: "GROSS_POPULATION" }),
    ]);
  });

  it("keeps unmatched lineage exception-bearing so commit cannot accept its hash", async () => {
    installFixture({ allocations: allocations.slice(1) });
    const result = await preview();
    expect(result.proof.unmatchedObservationCount).toBe(1);
    expect(result.proof.unmatchedPredecessorLedgerLineCount).toBe(1);
    expect(result.proof.exceptions).toEqual(expect.arrayContaining([
      "Every in-range observation must be fully represented by active allocations.",
      "Every predecessor ledger line must have an explicit direct or migration-allocation lineage disposition.",
    ]));
  });

  it("commits only the exact clean proof once without rewriting journals or allocations", async () => {
    const fixture = installFixture();
    const reviewed = await preview();

    const created = await commit(reviewed.confirmationHash, "card-cutover-fixture-v1");
    const replayed = await commit(reviewed.confirmationHash, "card-cutover-fixture-v1");

    expect(created).toMatchObject({
      version: 1,
      state: "ACTIVE",
      confirmationHash: reviewed.confirmationHash,
      idempotentReplay: false,
    });
    expect(replayed).toMatchObject({
      cutoverId: created.cutoverId,
      version: 1,
      state: "ACTIVE",
      confirmationHash: reviewed.confirmationHash,
      idempotentReplay: true,
    });
    expect(fixture.insertCount).toBe(1);
    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements.filter((statement) => statement.includes("INSERT INTO bank_account_cutovers"))).toHaveLength(1);
    expect(statements.some((statement) => /(?:UPDATE|DELETE)\s+(?:journal_|bank_match_)/u.test(statement))).toBe(false);
    expect(allocations).toHaveLength(22);
  });

  it("rejects stale and exception-bearing confirmation hashes before persistence", async () => {
    const cleanFixture = installFixture();
    await expect(commit("f".repeat(64), "stale-card-cutover-fixture"))
      .rejects.toMatchObject({ code: "CUTOVER_CONFIRMATION_CONFLICT" });
    expect(cleanFixture.insertCount).toBe(0);

    const incompleteFixture = installFixture({ allocations: allocations.slice(1) });
    const incomplete = await preview();
    expect(incomplete.proof.exceptions.length).toBeGreaterThan(0);
    await expect(commit(incomplete.confirmationHash, "incomplete-card-cutover-fixture"))
      .rejects.toMatchObject({ code: "CUTOVER_PROOF_INCOMPLETE" });
    expect(incompleteFixture.insertCount).toBe(0);
  });
});
