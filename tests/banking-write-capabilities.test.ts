import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  actorHasActivePermission: vi.fn(async () => true),
  query: vi.fn(async () => ({ rows: [] })),
}));

vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: mocks.actorHasActivePermission,
}));
vi.mock("@/modules/workspace/tenant-read", () => ({
  withWorkspaceTenantRead: vi.fn(async (
    _context: unknown,
    _path: string,
    work: (client: PoolClient) => Promise<unknown>,
  ) => work({ query: mocks.query } as unknown as PoolClient)),
}));
vi.mock("@/security/organization-key-store", () => ({
  loadActiveOrganizationKey: vi.fn(),
}));

import { loadBankingWorkspace } from "@/modules/banking/banking-workspace";

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Disabled tenant",
  roleLabel: "Owner",
  displayName: "Owner",
  initials: "OW",
  sessionMode: "real",
  authMethod: "PASSWORD",
  organizationWritesEnabled: false,
  expiresAt: new Date("2026-09-01T00:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

const previousBusinessWrites = process.env.BUSINESS_WRITES_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BUSINESS_WRITES_ENABLED = "true";
});

afterAll(() => {
  if (previousBusinessWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousBusinessWrites;
});

describe("banking workspace activation capabilities", () => {
  it("keeps tenant reads while removing every mutation capability after disable", async () => {
    const workspace = await loadBankingWorkspace(principal);

    expect(workspace.permissions).toEqual({
      read: true,
      connect: false,
      sync: false,
      reconcilePrepare: false,
      reconcileReview: false,
      rules: false,
    });
    expect(mocks.actorHasActivePermission).toHaveBeenCalledTimes(6);
    expect(mocks.query).toHaveBeenCalled();
  });
});
