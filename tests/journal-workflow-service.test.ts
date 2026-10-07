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
}));

import {
  approveSubmittedJournal,
  submitJournalForApproval,
  withdrawSubmittedJournal,
  rejectSubmittedJournal,
} from "@/modules/ledger/journal-workflow-service";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  maker: "10000000-0000-4000-8000-000000000003",
  journal: "20000000-0000-4000-8000-000000000001",
  ledger: "20000000-0000-4000-8000-000000000002",
};

const contentHash = "a".repeat(64);
const facts = {
  id: ids.journal, status: "DRAFT", content_hash: null, canonical_hash: contentHash,
  approval_version: null, created_by: ids.maker, owner_module: "ledger", journal_type_key: "ledger.manual",
  manual_mode: "REVIEW_REQUIRED", period_state: "OPEN", purpose: "ROUTINE", ledger_active: true,
  has_dependencies: false, valid_lines: true, has_approval: false, deleted: false,
};
const submitContext = {
  organizationId: ids.organization,
  actorId: ids.actor,
  requestId: "mcp-tool:submit-journal",
  authMethod: "oauth2.1+pkce",
  sourceSurface: "MCP" as const,
  reason: "Submit journal for approval",
};

beforeEach(() => {
  vi.clearAllMocks();
  const client = { query: mocks.query } as unknown as PoolClient;
  mocks.withTenantTransaction.mockImplementation(async (_context, work) => work(client));
});

describe("journal workflow command boundary", () => {
  it("keeps internal transaction context outside strict submit parsing and preserves replay", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("AS has_dependencies")) return { rows: [facts] };
      if (statement.includes("FOR UPDATE OF entry")) {
        return { rows: [{
          id: ids.journal,
          status: "DRAFT",
          content_hash: null,
          approval_version: 1,
          owner_module: "ledger",
          journal_type_key: "ledger.manual",
        }] };
      }
      if (statement.includes("compute_journal_content_hash")) {
        return { rows: [{ content_hash: contentHash }] };
      }
      if (statement.includes("UPDATE journal_entries SET status = 'SUBMITTED'")) {
        return { rows: [{ content_hash: contentHash, approval_version: 2 }] };
      }
      throw new Error(`Unexpected journal workflow SQL: ${statement}`);
    });

    await expect(submitJournalForApproval({
      context: submitContext,
      journalId: ids.journal,
      expectedContentHash: contentHash,
    })).resolves.toEqual({
      journalId: ids.journal,
      status: "SUBMITTED",
      contentHash,
      approvalVersion: 2,
      idempotentReplay: false,
    });
    expect(mocks.withTenantTransaction).toHaveBeenCalledWith(submitContext, expect.any(Function));

    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: ids.journal,
      status: "SUBMITTED",
      content_hash: contentHash,
      approval_version: 2,
      owner_module: "ledger",
      journal_type_key: "ledger.manual",
    }] });
    await expect(submitJournalForApproval({
      context: { ...submitContext, requestId: "mcp-tool:submit-journal-replay" },
      journalId: ids.journal,
      expectedContentHash: contentHash,
    })).resolves.toMatchObject({
      journalId: ids.journal,
      status: "SUBMITTED",
      idempotentReplay: true,
    });
  });

  it("normalizes approval context without weakening maker-checker controls", async () => {
    const reason = "Approve the reviewed journal";
    const context = { ...submitContext, actorId: ids.actor, reason };
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("AS has_dependencies")) return { rows: [{ ...facts, status: "SUBMITTED", content_hash: contentHash, approval_version: 2 }] };
      if (statement.includes("FROM journal_entries") && statement.includes("FOR UPDATE")) {
        return { rows: [{
          id: ids.journal,
          ledger_id: ids.ledger,
          status: "SUBMITTED",
          content_hash: contentHash,
          approval_version: 2,
          created_by: ids.maker,
          approved_by: null,
        }] };
      }
      if (statement.includes("INSERT INTO journal_approvals")) return { rows: [] };
      if (statement.includes("SET status = 'APPROVED'")) {
        return { rows: [{ content_hash: contentHash, approval_version: 2 }] };
      }
      throw new Error(`Unexpected journal approval SQL: ${statement}`);
    });

    await expect(approveSubmittedJournal({
      context,
      journalId: ids.journal,
      expectedContentHash: contentHash,
      expectedApprovalVersion: 2,
      reason,
    })).resolves.toMatchObject({
      journalId: ids.journal,
      status: "APPROVED",
      idempotentReplay: false,
    });
    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ids.organization,
      actorId: ids.actor,
      permission: "ledger.journal.approve",
    });
  });

  it("still rejects unsupported client-owned fields", async () => {
    await expect(submitJournalForApproval({
      context: submitContext,
      journalId: ids.journal,
      unsupportedClientField: "must-not-pass",
    } as never)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "unrecognized_keys" })],
    });
    expect(mocks.withTenantTransaction).not.toHaveBeenCalled();
  });
});


describe("submitted journal recovery", () => {
  const reason = "Return the reviewed journal for correction";
  const idempotencyKey = "abcdefab-0000-4000-8000-000000000004";
  const command = { journalId: ids.journal, expectedContentHash: contentHash, expectedApprovalVersion: 2, reason, idempotencyKey };
  function mockRecovery(overrides: Partial<typeof facts> = {}) {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("journal_workflow_recovery_replayed")) return { rows: [{ replayed: false }] };
      if (statement.includes("AS has_dependencies")) return { rows: [{ ...facts, status: "SUBMITTED", content_hash: contentHash, approval_version: 2, ...overrides }] };
      if (statement.includes("FROM journal_entries") && statement.includes("FOR UPDATE")) return { rows: [{ id: ids.journal, ledger_id: ids.ledger, status: "SUBMITTED", content_hash: contentHash, approval_version: 2 }] };
      if (statement.includes("UPDATE journal_entries")) return { rows: [{ content_hash: null, approval_version: null }] };
      return { rows: [] };
    });
  }
  it("withdraws the creator's frozen submission in place and binds audit metadata", async () => {
    mockRecovery();
    const context = { ...submitContext, actorId: ids.maker, reason };
    expect(await withdrawSubmittedJournal({ context, ...command })).toMatchObject({ status: "DRAFT", idempotentReplay: false });
    const audit = mocks.query.mock.calls.find(([sql]) => sql.includes("set_config('app.journal_workflow_command'"));
    expect(JSON.parse(audit![1][0])).toMatchObject({ action: "withdraw", expectedApprovalVersion: 2, expectedContentHash: contentHash, idempotencyKey });
    expect(mocks.query.mock.calls.some(([sql]) => /DELETE FROM|INSERT INTO journal_entries/.test(sql))).toBe(false);
  });
  it("records independent rejection as an immutable approval decision before recovery", async () => {
    mockRecovery();
    expect(await rejectSubmittedJournal({ context: { ...submitContext, reason }, ...command })).toMatchObject({ status: "DRAFT" });
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("'REJECTED'"))).toBe(true);
  });
  it.each([
    ["creator", { created_by: ids.actor }, "CREATOR_CANNOT_APPROVE"],
    ["closed period", { period_state: "HARD_CLOSED" }, "PERIOD_CLOSED"],
    ["dependent journal", { has_dependencies: true }, "HAS_DEPENDENCIES"],
  ])("denies rejection for %s without changing the journal", async (_name, overrides, code) => {
    mockRecovery(overrides as Partial<typeof facts>);
    await expect(rejectSubmittedJournal({ context: { ...submitContext, reason }, ...command })).rejects.toMatchObject({ code });
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("UPDATE journal_entries"))).toBe(false);
  });
  it("rejects unsupported UUID versions before opening a recovery transaction", async () => {
    await expect(withdrawSubmittedJournal({ context: { ...submitContext, actorId: ids.maker, reason }, ...command,
      idempotencyKey: "abcdefab-0000-7000-8000-000000000004",
    })).rejects.toHaveProperty("issues");
    expect(mocks.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("rejects a stale approval version before creating evidence", async () => {
    mockRecovery();
    await expect(withdrawSubmittedJournal({ context: { ...submitContext, actorId: ids.maker, reason }, ...command, expectedApprovalVersion: 1 })).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("UPDATE journal_entries"))).toBe(false);
  });
  it("replays the original recovery without withdrawing a later submission", async () => {
    mockRecovery();
    const context = { ...submitContext, actorId: ids.maker, reason };
    await withdrawSubmittedJournal({ context, ...command });
    const audit = mocks.query.mock.calls.find(([sql]) => sql.includes("set_config('app.journal_workflow_command'"));
    const metadata = JSON.parse(audit![1][0]);
    mocks.query.mockReset();
    mocks.query.mockImplementation(async (statement: string, params: string[]) => {
      if (statement.includes("FROM journal_entries")) return { rows: [{ id: ids.journal, status: "SUBMITTED", content_hash: contentHash, approval_version: 3 }] };
      if (statement.includes("journal_workflow_recovery_replayed")) {
        if (params[3] !== metadata.commandHash) throw Object.assign(new Error("Conflicting replay"), { code: "23505" });
        return { rows: [{ replayed: true }] };
      }
      return { rows: [] };
    });
    expect(await withdrawSubmittedJournal({ context, ...command, idempotencyKey: command.idempotencyKey.toUpperCase() })).toMatchObject({ status: "SUBMITTED", approvalVersion: 3, idempotentReplay: true });
    expect(mocks.query.mock.calls.find(([sql]) => sql.includes("journal_workflow_recovery_replayed"))?.[1][2]).toBe(command.idempotencyKey.toLowerCase());
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("UPDATE journal_entries"))).toBe(false);
    await expect(withdrawSubmittedJournal({ context: { ...context, reason: "Different recovery reason" }, ...command, reason: "Different recovery reason" })).rejects.toMatchObject({ code: "STALE_VERSION" });
  });
});
