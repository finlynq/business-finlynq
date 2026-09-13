import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  assertPermission: vi.fn(),
  assertRole: vi.fn(),
  assertWritable: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: vi.fn(async (_context, work) => work({ query: mocks.query })),
}));
vi.mock("@/modules/identity/authorization", () => ({
  assertActorHasActivePermission: mocks.assertPermission,
  assertActorHasActiveOrganizationRole: mocks.assertRole,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: vi.fn(),
  assertWritableOrganization: mocks.assertWritable,
}));

import {
  deleteJournal,
  unpostJournal,
} from "@/modules/ledger/journal-administration-service";
import { PERMISSIONS } from "@/modules/identity/permissions";

const context = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000002",
  sessionId: "10000000-0000-4000-8000-000000000003",
  sessionMode: "real" as const,
  requestId: "request-1",
  authMethod: "oidc+mfa",
  sourceSurface: "API" as const,
  reason: "Correct a duplicated manual posting",
};
const journalId = "10000000-0000-4000-8000-000000000004";
const idempotencyKey = "10000000-0000-4000-8000-000000000005";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue(undefined);
  mocks.assertRole.mockResolvedValue(undefined);
  mocks.assertWritable.mockResolvedValue(undefined);
});

describe("journal owner/admin controls", () => {
  it("repeats permission enforcement inside the transaction and unposts idempotently", async () => {
    mocks.query.mockResolvedValue({ rows: [{
      journal_id: journalId,
      result_status: "DRAFT",
      journal_number: null,
      idempotent_replay: true,
    }] });

    await expect(unpostJournal({
      context,
      journalId,
      reason: context.reason,
      idempotencyKey,
    })).resolves.toEqual({
      journalId,
      status: "DRAFT",
      journalNumber: null,
      idempotentReplay: true,
    });
    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: PERMISSIONS.administerJournal,
    });
    expect(mocks.assertRole).toHaveBeenCalledWith(expect.anything(), {
      organizationId: context.organizationId,
      actorId: context.actorId,
      roleKeys: ["OWNER", "ORGANIZATION_ADMIN"],
    });
    expect(mocks.query).toHaveBeenCalledWith(
      "SELECT * FROM app.admin_control_journal_transaction($1,$2,$3,$4)",
      ["UNPOST", journalId, context.reason, idempotencyKey],
    );
  });

  it("tombstones a journal without reporting a physical delete", async () => {
    mocks.query.mockResolvedValue({ rows: [{
      journal_id: journalId,
      result_status: "DELETED",
      journal_number: null,
      idempotent_replay: false,
    }] });
    await expect(deleteJournal({
      context,
      journalId,
      reason: context.reason,
      idempotencyKey,
    })).resolves.toMatchObject({ status: "DELETED", idempotentReplay: false });
  });

  it("denies password, demo, and stale/unassured OIDC sessions before database mutation", async () => {
    for (const authMethod of ["password", "oidc", "demo-link+mfa"]) {
      await expect(unpostJournal({
        context: {
          ...context,
          authMethod,
          sessionMode: authMethod.startsWith("demo") ? "demo" : "real",
        },
        journalId,
        reason: context.reason,
        idempotencyKey,
      })).rejects.toThrow(/current MFA assurance/);
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("denies ordinary members when their live permission lookup fails", async () => {
    mocks.assertPermission.mockRejectedValueOnce(new Error("permission denied"));
    await expect(deleteJournal({
      context,
      journalId,
      reason: context.reason,
      idempotencyKey,
    })).rejects.toThrow(/permission denied/);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("denies a custom role even if someone attached the permission", async () => {
    mocks.assertRole.mockRejectedValueOnce(new Error("owner or administrator role is required"));
    await expect(deleteJournal({
      context,
      journalId,
      reason: context.reason,
      idempotencyKey,
    })).rejects.toThrow(/owner or administrator/);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
