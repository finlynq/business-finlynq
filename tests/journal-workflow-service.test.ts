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
} from "@/modules/ledger/journal-workflow-service";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  maker: "10000000-0000-4000-8000-000000000003",
  journal: "20000000-0000-4000-8000-000000000001",
  ledger: "20000000-0000-4000-8000-000000000002",
};

const contentHash = "a".repeat(64);
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
