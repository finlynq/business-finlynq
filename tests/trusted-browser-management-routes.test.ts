import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestPrincipal: vi.fn(),
  requestFingerprints: vi.fn(),
  sameOrigin: vi.fn(),
  consumeRateLimit: vi.fn(),
  list: vi.fn(),
  revokeOne: vi.fn(),
  revokeAll: vi.fn(),
  logoutAll: vi.fn(),
  clearSessionCookie: vi.fn(),
  clearTrustedBrowserCookie: vi.fn(),
  identityLookupHash: vi.fn(),
}));

vi.mock("@/modules/identity/auth-store", () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  trustedBrowsersForSession: mocks.list,
  revokeTrustedBrowser: mocks.revokeOne,
  revokeAllTrustedBrowsers: mocks.revokeAll,
  logoutAllSessions: mocks.logoutAll,
}));
vi.mock("@/modules/identity/request-security", () => ({
  requestFingerprints: mocks.requestFingerprints,
  validateSameOriginMutation: mocks.sameOrigin,
}));
vi.mock("@/modules/identity/session", () => ({
  requestPrincipal: mocks.requestPrincipal,
  clearSessionCookie: mocks.clearSessionCookie,
}));
vi.mock("@/modules/identity/trusted-browser", () => ({
  clearTrustedBrowserCookie: mocks.clearTrustedBrowserCookie,
}));
vi.mock("@/security/identity-secret", () => ({
  identityLookupHash: mocks.identityLookupHash,
}));

import {
  DELETE as revokeAllBrowsers,
  GET as listBrowsers,
} from "@/app/api/auth/trusted-browsers/route";
import { DELETE as revokeBrowser } from "@/app/api/auth/trusted-browsers/[browserId]/route";
import { DELETE as logoutAllDevices } from "@/app/api/auth/sessions/route";

const requestId = "10000000-0000-4000-8000-000000000001";
const browserId = "20000000-0000-4000-8000-000000000001";
const outsiderBrowserId = "20000000-0000-4000-8000-000000000002";
const principal = {
  sessionId: "30000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000002",
  organizationId: "30000000-0000-4000-8000-000000000003",
  membershipId: "30000000-0000-4000-8000-000000000004",
  organizationName: "Tenant",
  roleLabel: "Owner",
  displayName: "Owner",
  initials: "OW",
  sessionMode: "real",
  authMethod: "PASSWORD",
  organizationWritesEnabled: true,
  expiresAt: new Date("2026-10-01T00:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
} as const;

function request(path: string, method = "GET"): NextRequest {
  return new NextRequest("https://business.finlynq.com" + path, {
    method,
    headers: {
      Origin: "https://business.finlynq.com",
      "x-request-id": requestId,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestPrincipal.mockResolvedValue(principal);
  mocks.requestFingerprints.mockReturnValue({
    ipHash: "i".repeat(64),
    userAgentHash: "u".repeat(64),
  });
  mocks.sameOrigin.mockReturnValue(true);
  mocks.consumeRateLimit.mockResolvedValue({
    allowed: true,
    retry_after_seconds: 0,
  });
  mocks.identityLookupHash.mockReturnValue("h".repeat(64));
  mocks.list.mockResolvedValue([
    {
      id: browserId,
      browser_label: "Chrome on Linux",
      created_at: new Date("2026-09-01T00:00:00Z"),
      last_used_at: null,
      expires_at: new Date("2026-10-01T00:00:00Z"),
    },
  ]);
  mocks.revokeOne.mockResolvedValue(true);
  mocks.revokeAll.mockResolvedValue(2);
  mocks.logoutAll.mockResolvedValue(3);
});

describe("trusted-browser management routes", () => {
  it("lists only records returned for the active real session and keeps the response private", async () => {
    const response = await listBrowsers(
      request("/api/auth/trusted-browsers"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      browsers: [
        {
          id: browserId,
          label: "Chrome on Linux",
          createdAt: "2026-09-01T00:00:00.000Z",
          lastUsedAt: null,
          expiresAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    expect(mocks.list).toHaveBeenCalledWith(principal.sessionId, requestId);
  });

  it("rejects unauthenticated listing before reading trusted-browser state", async () => {
    mocks.requestPrincipal.mockResolvedValue(null);
    const response = await listBrowsers(
      request("/api/auth/trusted-browsers"),
    );
    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("uses the same generic 404 for a missing or cross-organization browser", async () => {
    mocks.revokeOne.mockResolvedValue(false);
    const response = await revokeBrowser(
      request(
        "/api/auth/trusted-browsers/" + outsiderBrowserId,
        "DELETE",
      ),
      { params: Promise.resolve({ browserId: outsiderBrowserId }) },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "The trusted browser is unavailable.",
    });
    expect(mocks.revokeOne).toHaveBeenCalledWith({
      sessionId: principal.sessionId,
      trustedBrowserId: outsiderBrowserId,
      requestId,
    });
    expect(mocks.clearTrustedBrowserCookie).not.toHaveBeenCalled();
  });

  it("requires same-origin mutation before resolving a session", async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await revokeAllBrowsers(
      request("/api/auth/trusted-browsers", "DELETE"),
    );
    expect(response.status).toBe(403);
    expect(mocks.requestPrincipal).not.toHaveBeenCalled();
    expect(mocks.revokeAll).not.toHaveBeenCalled();
  });

  it("revokes all trusted browsers for the session boundary and clears this browser proof", async () => {
    const response = await revokeAllBrowsers(
      request("/api/auth/trusted-browsers", "DELETE"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      revoked: 2,
    });
    expect(mocks.revokeAll).toHaveBeenCalledWith({
      sessionId: principal.sessionId,
      requestId,
    });
    expect(mocks.clearTrustedBrowserCookie).toHaveBeenCalledWith(response);
  });

  it("logout-all revokes through the active session and clears both browser cookies", async () => {
    const response = await logoutAllDevices(
      request("/api/auth/sessions", "DELETE"),
    );
    expect(response.status).toBe(200);
    expect(mocks.logoutAll).toHaveBeenCalledWith({
      sessionId: principal.sessionId,
      requestId,
    });
    expect(mocks.clearSessionCookie).toHaveBeenCalledWith(response);
    expect(mocks.clearTrustedBrowserCookie).toHaveBeenCalledWith(response);
  });
});
