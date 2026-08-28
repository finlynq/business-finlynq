import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  withTenantTransaction: vi.fn(),
  hasRecentStepUp: vi.fn(() => true),
  assertPermission: vi.fn(async () => undefined),
  assertWrites: vi.fn(),
  assertWritableOrganization: vi.fn(async () => ({ isDemo: false })),
  demoWritesEnabled: vi.fn(() => true),
  mutationContext: vi.fn((principal: SessionPrincipal, requestId: string, options: { reason: string }) => ({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    requestId,
    authMethod: "password+mfa",
    sourceSurface: "API" as const,
    reason: options.reason,
  })),
}));

vi.mock("@/db/transaction", () => ({ withTenantTransaction: mocks.withTenantTransaction }));
vi.mock("@/modules/identity/authorization", () => ({
  assertActorHasActivePermission: mocks.assertPermission,
}));
vi.mock("@/modules/identity/session", () => ({ hasRecentStepUp: mocks.hasRecentStepUp }));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: mocks.assertWrites,
  assertWritableOrganization: mocks.assertWritableOrganization,
  demoWritesEnabled: mocks.demoWritesEnabled,
  mutationContext: mocks.mutationContext,
}));

import {
  changeLedgerPostingPolicy,
  postingPolicyChangeSchema,
} from "@/modules/ledger/posting-policy-service";

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Tenant",
  roleLabel: "Owner",
  displayName: "Owner",
  initials: "OW",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-08-27T23:00:00Z"),
  mfaVerifiedAt: new Date("2026-08-27T22:00:00Z"),
  stepUpExpiresAt: new Date("2026-08-27T23:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasRecentStepUp.mockReturnValue(true);
});

describe("ledger posting-policy administration", () => {
  it("requires a recent MFA step-up before opening a real-business transaction", async () => {
    mocks.hasRecentStepUp.mockReturnValue(false);
    await expect(changeLedgerPostingPolicy({
      principal,
      requestId: "policy-change",
      ledgerId: "20000000-0000-4000-8000-000000000001",
      manualMode: "AUTO_POST",
      expectedVersion: 2,
      reason: "Approve simpler owner posting",
    })).rejects.toMatchObject({ status: 428, code: "MFA_STEP_UP_REQUIRED" });
    expect(mocks.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("passes reason, optimistic version, tenant permission, and exact mode to the existing service", async () => {
    const ledgerId = "20000000-0000-4000-8000-000000000001";
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (statement.includes("FROM ledgers ledger")) return { rows: [{ allowed: true }] };
      if (statement.includes("FROM ledger_posting_policies")) {
        return { rows: [{ manual_mode: "REVIEW_REQUIRED", version: 2 }] };
      }
      if (statement.includes("UPDATE ledger_posting_policies")) {
        return { rows: [{ manual_mode: "AUTO_POST", version: 3 }] };
      }
      throw new Error(`Unexpected posting-policy SQL: ${statement}`);
    });
    mocks.withTenantTransaction.mockImplementation(async (
      context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => {
      expect(context).toMatchObject({
        organizationId: principal.organizationId,
        requestId: "policy-change",
        sourceSurface: "API",
        reason: "Approve simpler owner posting",
      });
      return work({ query } as unknown as PoolClient);
    });

    await expect(changeLedgerPostingPolicy({
      principal,
      requestId: "policy-change",
      ledgerId,
      manualMode: "AUTO_POST",
      expectedVersion: 2,
      reason: "Approve simpler owner posting",
    })).resolves.toEqual({ ledgerId, manualMode: "AUTO_POST", version: 3 });
    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: "ledger.posting_policy.manage",
    });
    const update = query.mock.calls.find(([statement]) => statement.includes("UPDATE ledger_posting_policies"));
    expect(update?.[1]).toEqual([
      "AUTO_POST",
      principal.userId,
      principal.organizationId,
      ledgerId,
      2,
    ]);
  });

  it("validates a meaningful audit reason and installs append-only policy-change audit evidence", () => {
    expect(postingPolicyChangeSchema.safeParse({
      ledgerId: "20000000-0000-4000-8000-000000000001",
      manualMode: "REVIEW_REQUIRED",
      expectedVersion: 3,
      reason: "short",
    }).success).toBe(false);
    const migration = readFileSync(join(process.cwd(), "migrations/drizzle/0020_accounting_configuration.sql"), "utf8");
    expect(migration).toContain("ledger.posting_policy.changed");
    expect(migration).toContain("AFTER UPDATE OF manual_mode ON ledger_posting_policies");
    expect(migration).toContain("app.append_tenant_business_audit");
  });
});
