import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class OidcAuthenticationError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  return {
    OidcAuthenticationError,
    consumeRateLimit: vi.fn(),
    issueOidcUserSession: vi.fn(),
    requestPrincipal: vi.fn(),
    setSessionCookie: vi.fn(),
    setOidcLoginCookie: vi.fn(),
    clearOidcLoginCookie: vi.fn(),
    loadOidcConfiguration: vi.fn(),
    createOidcAuthorization: vi.fn(),
    consumeOidcLoginAttempt: vi.fn(),
    exchangeOidcAuthorizationCode: vi.fn(),
    verifyOidcIdToken: vi.fn(),
  };
});

vi.mock("@/app/api/_shared/route-failure-log", () => ({
  logRouteAccess: vi.fn(),
  logRouteFailure: vi.fn(),
}));
vi.mock("@/modules/identity/auth-store", () => ({
  assertEmailDeliveryReady: vi.fn(async () => undefined),
  consumeRateLimit: mocks.consumeRateLimit,
  issueOidcUserSession: mocks.issueOidcUserSession,
}));
vi.mock("@/modules/identity/email-provider", () => ({
  assertAccountAuthenticationConfigured: vi.fn(),
}));
vi.mock("@/modules/identity/oidc", () => ({
  OidcAuthenticationError: mocks.OidcAuthenticationError,
  oidcLoginCookieName: () => "business_finlynq_oidc_login",
  setOidcLoginCookie: mocks.setOidcLoginCookie,
  clearOidcLoginCookie: mocks.clearOidcLoginCookie,
  loadOidcConfiguration: mocks.loadOidcConfiguration,
  createOidcAuthorization: mocks.createOidcAuthorization,
  consumeOidcLoginAttempt: mocks.consumeOidcLoginAttempt,
  exchangeOidcAuthorizationCode: mocks.exchangeOidcAuthorizationCode,
  verifyOidcIdToken: mocks.verifyOidcIdToken,
}));
vi.mock("@/modules/identity/request-security", () => ({
  configuredAppOrigin: () => new URL("https://business.finlynq.com"),
  isSpeculativeNavigation: () => false,
  requestFingerprints: () => ({ ipHash: "i".repeat(64), userAgentHash: "u".repeat(64) }),
}));
vi.mock("@/modules/identity/session", () => ({
  createOpaqueToken: () => ({ raw: "new-oidc-session", hash: "new-oidc-session-hash" }),
  hashOpaqueToken: (value: string) => `hashed:${value}`,
  requestPrincipal: mocks.requestPrincipal,
  sessionCookieName: () => "business_finlynq_session",
  setSessionCookie: mocks.setSessionCookie,
}));

import { GET as callback } from "@/app/api/auth/oidc/callback/route";
import { GET as start } from "@/app/api/auth/oidc/start/route";

const previousLogin = process.env.ACCOUNT_LOGIN_ENABLED;
const previousOidc = process.env.AUTH_OIDC_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ACCOUNT_LOGIN_ENABLED = "true";
  process.env.AUTH_OIDC_ENABLED = "true";
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true, retry_after_seconds: 0 });
  mocks.requestPrincipal.mockResolvedValue(null);
  mocks.loadOidcConfiguration.mockReturnValue({ issuer: "https://issuer.example.test" });
  mocks.createOidcAuthorization.mockReturnValue({
    location: "https://login.example.test/authorize?state=state",
    loginCookie: "encrypted-login-attempt",
  });
  mocks.consumeOidcLoginAttempt.mockReturnValue({
    nonce: "nonce",
    verifier: "verifier",
    next: "/app/receivables",
  });
  mocks.exchangeOidcAuthorizationCode.mockResolvedValue("id-token");
  mocks.verifyOidcIdToken.mockResolvedValue({
    userId: "10000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000002",
    membershipId: "10000000-0000-4000-8000-000000000003",
    credentialHash: "c".repeat(64),
  });
  mocks.issueOidcUserSession.mockResolvedValue("10000000-0000-4000-8000-000000000004");
});

afterAll(() => {
  if (previousLogin === undefined) delete process.env.ACCOUNT_LOGIN_ENABLED;
  else process.env.ACCOUNT_LOGIN_ENABLED = previousLogin;
  if (previousOidc === undefined) delete process.env.AUTH_OIDC_ENABLED;
  else process.env.AUTH_OIDC_ENABLED = previousOidc;
});

describe("OIDC routes", () => {
  it("starts a rate-limited, browser-bound authorization request", async () => {
    const response = await start(new NextRequest(
      "https://business.finlynq.com/api/auth/oidc/start?next=%2Fapp%2Freceivables",
      { headers: { "sec-fetch-site": "same-origin" } },
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://login.example.test/authorize?state=state");
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith("oidc-login-ip-minute", "i".repeat(64), 10, 60);
    expect(mocks.setOidcLoginCookie).toHaveBeenCalledWith(response, "encrypted-login-attempt");
  });

  it("verifies the callback and atomically replaces an existing demo session", async () => {
    mocks.requestPrincipal.mockResolvedValue({ sessionMode: "demo" });
    const response = await callback(new NextRequest(
      "https://business.finlynq.com/api/auth/oidc/callback?code=authorization-code&state=state&iss=https%3A%2F%2Fissuer.example.test",
      { headers: { Cookie: "business_finlynq_oidc_login=attempt; business_finlynq_session=demo-session" } },
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://business.finlynq.com/app/receivables");
    expect(mocks.exchangeOidcAuthorizationCode).toHaveBeenCalledWith(
      expect.anything(),
      "authorization-code",
      "verifier",
    );
    expect(mocks.issueOidcUserSession).toHaveBeenCalledWith(expect.objectContaining({
      tokenHash: "new-oidc-session-hash",
      credentialHash: "c".repeat(64),
      replacedDemoSessionTokenHash: "hashed:demo-session",
    }));
    expect(mocks.setSessionCookie).toHaveBeenCalledWith(response, "new-oidc-session", 24 * 60 * 60);
    expect(mocks.clearOidcLoginCookie).toHaveBeenCalledWith(response);
  });

  it("keeps an unassigned identity out of the application", async () => {
    mocks.issueOidcUserSession.mockResolvedValue(null);
    const response = await callback(new NextRequest(
      "https://business.finlynq.com/api/auth/oidc/callback?code=authorization-code&state=state",
      { headers: { Cookie: "business_finlynq_oidc_login=attempt" } },
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://business.finlynq.com/login?ssoError=unassigned",
    );
    expect(mocks.setSessionCookie).not.toHaveBeenCalled();
  });
});
