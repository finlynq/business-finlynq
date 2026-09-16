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
  createGlAccount,
  updateGlAccount,
} from "@/modules/ledger/chart-of-accounts-service";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  session: "10000000-0000-4000-8000-000000000003",
  ledger: "20000000-0000-4000-8000-000000000001",
  account: "20000000-0000-4000-8000-000000000002",
  entity: "20000000-0000-4000-8000-000000000003",
  combination: "20000000-0000-4000-8000-000000000004",
};

const context = {
  organizationId: ids.organization,
  actorId: ids.actor,
  sessionId: ids.session,
  sessionMode: "real" as const,
  requestId: "mcp-tool:create-gl-account",
  authMethod: "oauth2.1+pkce",
  sourceSurface: "MCP" as const,
  reason: "Create GL account 6100",
};

const createCommand = {
  context,
  ledgerId: ids.ledger,
  code: "6100",
  displayName: "Software subscriptions",
  accountClass: "EXPENSE" as const,
  controlKind: "NONE" as const,
  postable: true,
  validFrom: "2026-01-01",
  validTo: null,
  idempotencyKey: "mcp-create-gl-6100",
};

beforeEach(() => {
  vi.clearAllMocks();
  const client = { query: mocks.query } as unknown as PoolClient;
  mocks.withTenantTransaction.mockImplementation(async (_context, work) => work(client));
});

describe("chart-of-accounts command boundary", () => {
  it("keeps transaction context outside the strict create schema and preserves idempotent replay", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("FROM ledgers")) return { rows: [{ legal_entity_id: ids.entity }] };
      if (statement.includes("FROM gl_accounts")) {
        return { rows: [{
          id: ids.account,
          display_name: createCommand.displayName,
          class: createCommand.accountClass,
          control_kind: createCommand.controlKind,
          postable: createCommand.postable,
          valid_from: createCommand.validFrom,
          valid_to: null,
        }] };
      }
      throw new Error(`Unexpected chart SQL: ${statement}`);
    });

    await expect(createGlAccount(createCommand)).resolves.toEqual({
      accountId: ids.account,
      code: "6100",
      idempotentReplay: true,
    });
    expect(mocks.withTenantTransaction).toHaveBeenCalledWith(context, expect.any(Function));
  });

  it("keeps transaction context outside the strict update schema and reports real optimistic conflicts", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const updateCommand = {
      context: { ...context, requestId: "mcp-tool:update-gl-account", reason: "Rename expense account" },
      accountId: ids.account,
      displayName: "Cloud software",
      postable: true,
      active: true,
      validFrom: createCommand.validFrom,
      validTo: null,
      expected: {
        displayName: "Software subscriptions",
        postable: true,
        active: true,
        validFrom: createCommand.validFrom,
        validTo: null,
      },
      reason: "Rename expense account",
    };

    await expect(updateGlAccount(updateCommand)).rejects.toThrow(
      "Account changed after it was loaded, is outside this organization, or violates a protected mapping",
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE"),
      [ids.organization, ids.account],
    );
  });

  it("creates the default account combination atomically and reuses the same account id", async () => {
    let insertedAccountId = "";
    mocks.query.mockImplementation(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("FROM ledgers")) return { rows: [{ legal_entity_id: ids.entity }] };
      if (statement.includes("FROM gl_accounts")) return { rows: [] };
      if (statement.includes("INSERT INTO gl_accounts")) {
        insertedAccountId = String(parameters?.[0]);
        return { rows: [{ id: insertedAccountId, code: createCommand.code }] };
      }
      if (statement.includes("app.accounting_create_account_combination")) {
        expect(parameters).toEqual([ids.entity, ids.ledger, insertedAccountId]);
        return { rows: [{ id: ids.combination }] };
      }
      throw new Error(`Unexpected chart SQL: ${statement}`);
    });

    const result = await createGlAccount({
      ...createCommand,
      createDefaultCombination: true,
    });
    expect(result).toEqual({
      accountId: insertedAccountId,
      accountCombinationId: ids.combination,
      code: createCommand.code,
      idempotentReplay: false,
    });
    expect(insertedAccountId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns structured dependency evidence when a later start date would invalidate history", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        id: ids.account,
        ledger_id: ids.ledger,
        display_name: createCommand.displayName,
        postable: true,
        active: true,
        valid_from: "2025-01-01",
        valid_to: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        journal_line_count: 3,
        source_document_count: 2,
        bank_mapping_count: 1,
        earliest_conflicting_date: "2025-02-14",
      }] });

    await expect(updateGlAccount({
      context: { ...context, reason: "Move account availability later" },
      accountId: ids.account,
      displayName: createCommand.displayName,
      postable: true,
      active: true,
      validFrom: "2026-01-01",
      validTo: null,
      expected: {
        displayName: createCommand.displayName,
        postable: true,
        active: true,
        validFrom: "2025-01-01",
        validTo: null,
      },
      reason: "Move account availability later",
    })).rejects.toMatchObject({
      code: "GL_ACCOUNT_VALID_FROM_CONFLICT",
      safeDetails: {
        earliestConflictingAccountingDate: "2025-02-14",
        dependencyCounts: { journalLines: 3, sourceDocuments: 2, bankMappings: 1 },
      },
    });
  });

  it("moves an account start date earlier without replacing its combinations", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        id: ids.account,
        ledger_id: ids.ledger,
        display_name: createCommand.displayName,
        postable: true,
        active: true,
        valid_from: "2026-01-01",
        valid_to: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: ids.account,
        display_name: createCommand.displayName,
        postable: true,
        active: true,
        valid_from: "2025-01-01",
        valid_to: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: ids.combination,
        previous_valid_from: "2026-01-01",
        effective_valid_from: "2025-01-01",
      }] })
      .mockResolvedValueOnce({ rows: [{}] });

    await expect(updateGlAccount({
      context: { ...context, reason: "Expand account availability earlier" },
      accountId: ids.account,
      displayName: createCommand.displayName,
      postable: true,
      active: true,
      validFrom: "2025-01-01",
      validTo: null,
      expected: {
        displayName: createCommand.displayName,
        postable: true,
        active: true,
        validFrom: "2026-01-01",
        validTo: null,
      },
      reason: "Expand account availability earlier",
    })).resolves.toMatchObject({
      accountId: ids.account,
      validFrom: "2025-01-01",
      impactPreview: {
        combinationCount: 1,
        combinations: [{
          id: ids.combination,
          previousValidFrom: "2026-01-01",
          effectiveValidFrom: "2025-01-01",
        }],
      },
    });
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("accounting.gl_account.updated"),
      expect.arrayContaining(["2026-01-01", "2025-01-01", 1]),
    );
  });

  it("fails strict validation before opening a transaction", async () => {
    await expect(createGlAccount({
      ...createCommand,
      displayName: "",
    })).rejects.toThrow();
    expect(mocks.withTenantTransaction).not.toHaveBeenCalled();
  });
});
