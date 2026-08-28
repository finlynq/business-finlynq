import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  cookieValue: "20000000-0000-4000-8000-000000000002",
  query: vi.fn(),
  cookies: vi.fn(),
  withWorkspaceTenantRead: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@/modules/workspace/tenant-read", () => ({
  withWorkspaceTenantRead: mocks.withWorkspaceTenantRead,
}));

import {
  currentWorkspaceEntityContext,
  loadWorkspaceEntityOptions,
  selectWorkspaceEntity,
  validateWorkspaceEntitySelection,
  type WorkspaceEntityOption,
} from "@/modules/workspace/entity-context";

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Context tenant",
  roleLabel: "Owner",
  displayName: "Owner",
  initials: "OW",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-09-01T00:00:00Z"),
  mfaVerifiedAt: new Date("2026-08-27T00:00:00Z"),
  stepUpExpiresAt: null,
};

const options: readonly WorkspaceEntityOption[] = [
  {
    id: "20000000-0000-4000-8000-000000000001",
    code: "CA01",
    displayName: "Canada Company",
    functionalCurrency: "CAD",
    periodLabel: "August 2026",
    periodState: "OPEN",
  },
  {
    id: "20000000-0000-4000-8000-000000000002",
    code: "US01",
    displayName: "United States Company",
    functionalCurrency: "USD",
    periodLabel: "August 2026",
    periodState: "OPEN",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue({
    get: vi.fn(() => ({ value: mocks.cookieValue })),
  });
  mocks.withWorkspaceTenantRead.mockImplementation(async (
    _context: unknown,
    _path: string,
    work: (client: { query: typeof mocks.query }) => Promise<unknown>,
  ) => work({ query: mocks.query }));
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM organization_memberships")) return { rows: [{ active: true }] };
    if (sql.includes("FROM legal_entities")) {
      return {
        rows: options.map((entity) => ({
          id: entity.id,
          code: entity.code,
          display_name: entity.displayName,
          functional_currency: entity.functionalCurrency,
          period_label: entity.periodLabel,
          period_state: entity.periodState,
        })),
      };
    }
    throw new Error(`Unexpected entity-context query: ${sql}`);
  });
});

describe("workspace entity presentation context", () => {
  it("loads only active organization entities after rechecking the live membership", async () => {
    const loaded = await loadWorkspaceEntityOptions(principal);

    expect(loaded).toEqual(options);
    expect(mocks.withWorkspaceTenantRead).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: principal.organizationId,
        actorId: principal.userId,
        sessionId: principal.sessionId,
      }),
      "/app",
      expect.any(Function),
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("membership.organization_id = $1"),
      [principal.organizationId, principal.membershipId, principal.userId],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE entity.organization_id = $1"),
      [principal.organizationId, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)],
    );
  });

  it("uses a valid HttpOnly preference and safely falls back when it is stale", async () => {
    const current = await currentWorkspaceEntityContext(principal);
    expect(current.selectedEntity?.code).toBe("US01");

    expect(selectWorkspaceEntity(options, "ffffffff-ffff-4fff-8fff-ffffffffffff"))
      .toEqual(options[0]);
    expect(selectWorkspaceEntity([], options[0]?.id)).toBeNull();
  });

  it("never accepts an entity identifier outside the authenticated option set", async () => {
    await expect(validateWorkspaceEntitySelection(principal, options[0]!.id))
      .resolves.toEqual(options[0]);
    await expect(validateWorkspaceEntitySelection(
      principal,
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    )).resolves.toBeNull();
  });

  it("fails closed when active organization membership disappears", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(loadWorkspaceEntityOptions(principal)).rejects.toThrow(
      "active organization membership",
    );
  });
});
