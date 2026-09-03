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
      if (statement.includes("FROM ledgers")) return { rows: [{ exists: true }] };
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
      validTo: null,
      expected: {
        displayName: "Software subscriptions",
        postable: true,
        active: true,
        validTo: null,
      },
      reason: "Rename expense account",
    };

    await expect(updateGlAccount(updateCommand)).rejects.toThrow(
      "Account changed after it was loaded, is outside this organization, or violates a protected mapping",
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("AND display_name = $7"),
      expect.arrayContaining([updateCommand.expected.displayName]),
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
