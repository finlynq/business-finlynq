import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => {
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
  return {
    principal,
    sameOrigin: vi.fn(() => true),
    requestPrincipal: vi.fn(async () => principal as SessionPrincipal | null),
    validateSelection: vi.fn(),
  };
});

vi.mock("@/modules/identity/request-security", () => ({
  validateSameOriginMutation: mocks.sameOrigin,
}));

vi.mock("@/modules/identity/session", () => ({
  requestPrincipal: mocks.requestPrincipal,
}));

vi.mock("@/app/api/_shared/demo-session-error-response", () => ({
  demoSessionLeaseLostResponse: vi.fn(() => null),
}));

vi.mock("@/modules/workspace/entity-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/workspace/entity-context")>()),
  validateWorkspaceEntitySelection: mocks.validateSelection,
}));

import { PUT } from "@/app/api/workspace/entity-context/route";

const entity = {
  id: "20000000-0000-4000-8000-000000000001",
  code: "CA01",
  displayName: "Canada Company",
  functionalCurrency: "CAD",
  periodLabel: "August 2026",
  periodState: "OPEN",
};

function request(body: unknown): NextRequest {
  return new NextRequest("https://business.finlynq.com/api/workspace/entity-context", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requestPrincipal.mockResolvedValue(mocks.principal);
  mocks.validateSelection.mockResolvedValue(entity);
});

describe("workspace entity context API", () => {
  it("rejects unverified origins before resolving a session", async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await PUT(request({ entityId: entity.id }));
    expect(response.status).toBe(403);
    expect(mocks.requestPrincipal).not.toHaveBeenCalled();
  });

  it("requires an authenticated organization session", async () => {
    mocks.requestPrincipal.mockResolvedValue(null);
    const response = await PUT(request({ entityId: entity.id }));
    expect(response.status).toBe(401);
    expect(mocks.validateSelection).not.toHaveBeenCalled();
  });

  it("rejects malformed and cross-organization entity identifiers without a cookie", async () => {
    const malformed = await PUT(request({ entityId: "not-an-id" }));
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("set-cookie")).toBeNull();

    const callerScoped = await PUT(request({
      entityId: entity.id,
      organizationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    }));
    expect(callerScoped.status).toBe(400);
    expect(mocks.validateSelection).not.toHaveBeenCalled();

    mocks.validateSelection.mockResolvedValueOnce(null);
    const foreign = await PUT(request({ entityId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }));
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("set-cookie")).toBeNull();
  });

  it("persists only a validated choice in an HttpOnly same-site cookie", async () => {
    const response = await PUT(request({ entityId: entity.id }));
    expect(response.status).toBe(200);
    expect(mocks.validateSelection).toHaveBeenCalledWith(mocks.principal, entity.id);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`business_finlynq_entity=${entity.id}`);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Max-Age=31536000");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
