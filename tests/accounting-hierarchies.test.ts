import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTenantTransaction: vi.fn(),
  withWorkspaceTenantRead: vi.fn(),
  assertPermission: vi.fn<(
    client: unknown,
    request: Readonly<{ organizationId: string; actorId: string; permission: string }>,
  ) => Promise<void>>(async () => undefined),
  hasPermission: vi.fn<(
    client: unknown,
    request: Readonly<{ organizationId: string; actorId: string; permission: string }>,
  ) => Promise<boolean>>(async (_client, request) => request.permission === "mcp.ledger.read"),
  hasRecentStepUp: vi.fn(() => true),
  assertWrites: vi.fn(),
  assertWritable: vi.fn(async () => ({ isDemo: false })),
}));

vi.mock("@/db/transaction", () => ({ withTenantTransaction: mocks.withTenantTransaction }));
vi.mock("@/modules/workspace/tenant-read", () => ({
  withWorkspaceTenantRead: mocks.withWorkspaceTenantRead,
}));
vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: mocks.hasPermission,
  assertActorHasActivePermission: mocks.assertPermission,
}));
vi.mock("@/modules/identity/session", () => ({
  hasRecentStepUp: mocks.hasRecentStepUp,
  transactionAuthMethod: vi.fn(() => "password+mfa"),
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: mocks.assertWrites,
  assertWritableOrganization: mocks.assertWritable,
  mutationContext: vi.fn((principal: SessionPrincipal, requestId: string, options: { reason: string }) => ({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId,
    authMethod: "password+mfa",
    sourceSurface: "API",
    reason: options.reason,
  })),
}));

import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  accountingHierarchyNodeInputSchema,
  createAccountingHierarchy,
  createAccountingHierarchySchema,
  loadAccountingHierarchies,
  publishAccountingHierarchy,
  saveAccountingHierarchy,
} from "@/modules/ledger/accounting-hierarchies";

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Hierarchy tenant",
  roleLabel: "Owner",
  displayName: "Owner",
  initials: "OW",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-08-28T23:00:00Z"),
  mfaVerifiedAt: new Date("2026-08-28T22:00:00Z"),
  stepUpExpiresAt: new Date("2026-08-28T23:00:00Z"),
};

const hierarchyId = "20000000-0000-4000-8000-000000000001";
const ledgerId = "20000000-0000-4000-8000-000000000002";
const node = {
  id: "20000000-0000-4000-8000-000000000003",
  parentId: null,
  code: "ASSETS",
  displayName: "Assets",
  sortOrder: 100,
  statementClass: "ASSET" as const,
  memberType: null,
  memberId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPermission.mockImplementation(async (_client, request) => (
    request.permission === PERMISSIONS.readMcpLedger
  ));
  mocks.hasRecentStepUp.mockReturnValue(true);
  const client = { query: mocks.query } as unknown as PoolClient;
  mocks.withTenantTransaction.mockImplementation(async (_context, work) => work(client));
  mocks.withWorkspaceTenantRead.mockImplementation(async (_context, _path, work) => work(client));
});

describe("accounting reporting hierarchies", () => {
  it("loads hierarchy metadata only after the active ledger-read permission check", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM accounting_hierarchies")) return { rows: [{
        id: hierarchyId,
        dimension_key: "account",
        ledger_id: ledgerId,
        code: "PRIMARY_REPORTING",
        display_name: "Primary reporting",
        version: 1,
        revision: 2,
        status: "PUBLISHED",
        based_on_hierarchy_id: null,
        effective_from: "2026-01-01",
        created_at: "2026-01-01T00:00:00Z",
        published_at: "2026-01-01T00:00:00Z",
      }] };
      if (sql.includes("FROM accounting_hierarchy_nodes")) return { rows: [{
        id: node.id,
        hierarchy_id: hierarchyId,
        parent_id: null,
        code: node.code,
        display_name: node.displayName,
        sort_order: node.sortOrder,
        statement_class: node.statementClass,
        member_type: null,
        member_id: null,
      }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(loadAccountingHierarchies(principal)).resolves.toEqual([
      expect.objectContaining({ id: hierarchyId, nodes: [expect.objectContaining({ code: "ASSETS" })] }),
    ]);
    expect(mocks.hasPermission).toHaveBeenCalledWith(expect.anything(), {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readMcpLedger,
    });
  });

  it("keeps accounting settings available to organization administrators without ledger transaction access", async () => {
    mocks.hasPermission.mockImplementation(async (_client, request) => (
      request.permission === PERMISSIONS.manageOrganizationSettings
    ));
    mocks.query.mockResolvedValue({ rows: [] });

    await expect(loadAccountingHierarchies(principal)).resolves.toEqual([]);
    expect(mocks.hasPermission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      permission: PERMISSIONS.manageOrganizationSettings,
    }));
    expect(mocks.query).toHaveBeenCalled();
  });

  it("fails before reading hierarchy tables when no settings or ledger permission is active", async () => {
    mocks.hasPermission.mockResolvedValue(false);

    await expect(loadAccountingHierarchies(principal))
      .rejects.toThrow("Accounting hierarchy metadata permission is required");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("requires manage-segments inside each draft mutation and preserves optimistic revisions", async () => {
    mocks.query.mockImplementation(async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.includes("accounting_create_hierarchy_draft")) {
        expect(parameters).toEqual(["account", ledgerId, "PRIMARY_REPORTING", "Primary reporting", null]);
        return { rows: [{ id: hierarchyId, version: 1, revision: 1 }] };
      }
      if (sql.includes("accounting_replace_hierarchy_draft")) {
        expect(parameters?.[2]).toContain('"statementClass":"ASSET"');
        return { rows: [{ revision: 2 }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(createAccountingHierarchy({
      principal,
      requestId: "create-hierarchy",
      dimensionKey: "account",
      ledgerId,
      code: "PRIMARY_REPORTING",
      displayName: "Primary reporting",
      basedOnHierarchyId: null,
      nodes: [node],
      reason: "Create the primary hierarchy",
    })).resolves.toEqual({ id: hierarchyId, version: 1, revision: 2 });

    mocks.query.mockResolvedValueOnce({ rows: [{ revision: 4 }] });
    await expect(saveAccountingHierarchy({
      principal,
      requestId: "save-hierarchy",
      hierarchyId,
      expectedRevision: 3,
      nodes: [node],
      reason: "Refine the statement tree",
    })).resolves.toEqual({ revision: 4 });
    expect(mocks.assertPermission).toHaveBeenCalledTimes(2);
    for (const call of mocks.assertPermission.mock.calls) {
      expect(call[1]).toEqual({
        organizationId: principal.organizationId,
        actorId: principal.userId,
        permission: PERMISSIONS.manageSegments,
      });
    }
    expect(mocks.assertWritable).toHaveBeenCalledTimes(2);
  });

  it("requires recent step-up before publication opens a transaction", async () => {
    mocks.hasRecentStepUp.mockReturnValue(false);
    await expect(publishAccountingHierarchy({
      principal,
      requestId: "publish-hierarchy",
      hierarchyId,
      expectedRevision: 2,
      effectiveFrom: "2026-09-01",
      reason: "Publish approved statement tree",
    })).rejects.toMatchObject({ status: 428, code: "MFA_STEP_UP_REQUIRED" });
    expect(mocks.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("checks manage-segments in the tenant transaction before publishing", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ version: 2, effective_from: "2026-09-01" }] });
    await expect(publishAccountingHierarchy({
      principal,
      requestId: "publish-hierarchy",
      hierarchyId,
      expectedRevision: 4,
      effectiveFrom: "2026-09-01",
      reason: "Publish approved statement tree",
    })).resolves.toEqual({ version: 2, effectiveFrom: "2026-09-01" });
    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.manageSegments,
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("app.accounting_publish_hierarchy"),
      [hierarchyId, 4, "2026-09-01"],
    );
  });

  it("validates entity as its own dimension and rejects malformed member bindings", () => {
    expect(createAccountingHierarchySchema.safeParse({
      dimensionKey: "entity",
      ledgerId: null,
      code: "LEGAL_ENTITY",
      displayName: "Legal entity hierarchy",
      basedOnHierarchyId: null,
      nodes: [],
      reason: "Create legal entity rollup",
    }).success).toBe(true);
    expect(createAccountingHierarchySchema.safeParse({
      dimensionKey: "entity",
      ledgerId,
      code: "LEGAL_ENTITY",
      displayName: "Legal entity hierarchy",
      basedOnHierarchyId: null,
      nodes: [],
      reason: "Create invalid scoped hierarchy",
    }).success).toBe(false);
    expect(accountingHierarchyNodeInputSchema.safeParse({
      ...node,
      statementClass: null,
      memberType: "ENTITY",
      memberId: null,
    }).success).toBe(false);
  });

  it("installs immutable tenant-scoped SQL, typed member checks, reset coverage, and least privilege grants", () => {
    const migration = readFileSync(join(process.cwd(), "migrations/drizzle/0024_accounting_hierarchies.sql"), "utf8");
    const runtime = readFileSync(join(process.cwd(), "deploy/postgres/010-runtime-role.sh"), "utf8");
    const demoSeed = readFileSync(join(process.cwd(), "src/modules/onboarding/demo-bootstrap.ts"), "utf8");
    const settings = readFileSync(join(process.cwd(), "src/app/_components/accounting-settings.client.tsx"), "utf8");
    const journal = JSON.parse(readFileSync(
      join(process.cwd(), "migrations/drizzle/meta/_journal.json"),
      "utf8",
    )) as { entries: { idx: number; tag: string }[] };
    expect(migration).toContain("'entity', 'account', 'subaccount', 'department', 'intercompany'");
    expect(migration).toContain("ALTER TABLE accounting_hierarchies FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE accounting_hierarchy_nodes FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("Published accounting hierarchies are immutable");
    expect(migration).toContain("Only draft hierarchy nodes can be changed");
    expect(migration).toContain("Published hierarchy members must be assigned below a group");
    expect(migration).toContain("ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("account.ledger_id = selected_hierarchy.ledger_id");
    expect(migration.match(/account\.active\s+AND account\.postable/g)).toHaveLength(2);
    expect(migration.match(/selected_expected_revision IS NULL/g)).toHaveLength(2);
    expect(migration).toContain("hierarchy.revision = selected_expected_revision");
    expect(migration).toContain("selected_definition_key IS DISTINCT FROM selected_hierarchy.dimension_key");
    expect(migration).toContain("selected_hierarchy.dimension_key IN ('entity', 'intercompany')");
    expect(migration.match(/organization_admin_authorize\('ledger\.segments\.manage', false\)/g)).toHaveLength(2);
    expect(migration).toContain("organization_admin_authorize('ledger.segments.manage', true)");
    expect(migration).toContain("('accounting_hierarchy_nodes', 44)");
    expect(migration).toContain("('accounting_hierarchies', 45)");
    expect(runtime).toContain("'accounting_hierarchies', 'accounting_hierarchy_nodes'");
    expect(runtime).toContain("app.accounting_publish_hierarchy(uuid,integer,date)");
    expect(demoSeed).toContain("seedPublishedAccountHierarchies");
    expect(demoSeed).toContain("defaultFinancialStatementGroups");
    expect(settings).toContain("Reporting hierarchies");
    expect(settings).toContain("PRIMARY_REPORTING");
    expect(journal.entries.at(-1)).toEqual(expect.objectContaining({
      idx: 24,
      tag: "0024_accounting_hierarchies",
    }));
  });
});
