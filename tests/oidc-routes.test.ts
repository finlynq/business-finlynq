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
    resolveOidcIdentity: vi.fn(),
    requestPrincipal: vi.fn(),
    setSessionCookie: vi.fn(),
    setOidcLoginCookie: vi.fn(),
    clearOidcLoginCookie: vi.fn(),
    setOidcSignupCookie: vi.fn(),
    clearOidcSignupCookie: vi.fn(),
    createOidcSignupProof: vi.fn(),
    loadOidcConfiguration: vi.fn(),
    createOidcAuthorization: vi.fn(),
    consumeOidcLoginAttempt: vi.fn(),
    exchangeOidcAuthorizationCode: vi.fn(),
    verifyOidcPrincipal: vi.fn(),
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
  resolveOidcIdentity: mocks.resolveOidcIdentity,
}));
vi.mock("@/modules/identity/email-provider", () => ({
  assertAccountAuthenticationConfigured: vi.fn(),
}));
vi.mock("@/modules/identity/oidc", () => ({
  OidcAuthenticationError: mocks.OidcAuthenticationError,
  oidcLoginCookieName: () => "business_finlynq_oidc_login",
  setOidcLoginCookie: mocks.setOidcLoginCookie,
  clearOidcLoginCookie: mocks.clearOidcLoginCookie,
  oidcSignupEnabled: () => process.env.AUTH_OIDC_SIGNUP_ENABLED === "true",
  setOidcSignupCookie: mocks.setOidcSignupCookie,
  clearOidcSignupCookie: mocks.clearOidcSignupCookie,
  createOidcSignupProof: mocks.createOidcSignupProof,
  loadOidcConfiguration: mocks.loadOidcConfiguration,
  createOidcAuthorization: mocks.createOidcAuthorization,
  consumeOidcLoginAttempt: mocks.consumeOidcLoginAttempt,
  exchangeOidcAuthorizationCode: mocks.exchangeOidcAuthorizationCode,
  verifyOidcPrincipal: mocks.verifyOidcPrincipal,
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
const previousOidcSignup = process.env.AUTH_OIDC_SIGNUP_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ACCOUNT_LOGIN_ENABLED = "true";
  process.env.AUTH_OIDC_ENABLED = "true";
  process.env.AUTH_OIDC_SIGNUP_ENABLED = "true";
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
    intent: "login",
  });
  mocks.exchangeOidcAuthorizationCode.mockResolvedValue("id-token");
  mocks.verifyOidcPrincipal.mockResolvedValue({
    issuer: "https://issuer.example.test",
    externalTenantId: "external-tenant",
    externalPrincipalId: "external-principal",
    credentialHash: "c".repeat(64),
    mappedIdentity: {
      userId: "10000000-0000-4000-8000-000000000001",
      organizationId: "10000000-0000-4000-8000-000000000002",
      membershipId: "10000000-0000-4000-8000-000000000003",
    },
  });
  mocks.resolveOidcIdentity.mockResolvedValue(null);
  mocks.createOidcSignupProof.mockReturnValue("encrypted-signup-proof");
  mocks.issueOidcUserSession.mockResolvedValue("10000000-0000-4000-8000-000000000004");
});

afterAll(() => {
  if (previousLogin === undefined) delete process.env.ACCOUNT_LOGIN_ENABLED;
  else process.env.ACCOUNT_LOGIN_ENABLED = previousLogin;
  if (previousOidc === undefined) delete process.env.AUTH_OIDC_ENABLED;
  else process.env.AUTH_OIDC_ENABLED = previousOidc;
  if (previousOidcSignup === undefined) delete process.env.AUTH_OIDC_SIGNUP_ENABLED;
  else process.env.AUTH_OIDC_SIGNUP_ENABLED = previousOidcSignup;
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
    mocks.verifyOidcPrincipal.mockResolvedValue({
      issuer: "https://issuer.example.test",
      externalTenantId: "external-tenant",
      externalPrincipalId: "unassigned-principal",
      credentialHash: "d".repeat(64),
      mappedIdentity: null,
    });
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

  it("turns a verified unassigned Microsoft principal into a short-lived signup proof", async () => {
    mocks.consumeOidcLoginAttempt.mockReturnValue({
      nonce: "nonce",
      verifier: "verifier",
      next: "/app",
      intent: "signup",
    });
    mocks.verifyOidcPrincipal.mockResolvedValue({
      issuer: "https://issuer.example.test",
      externalTenantId: "external-tenant",
      externalPrincipalId: "new-principal",
      credentialHash: "e".repeat(64),
      mappedIdentity: null,
    });
    const response = await callback(new NextRequest(
      "https://business.finlynq.com/api/auth/oidc/callback?code=authorization-code&state=state",
      { headers: { Cookie: "business_finlynq_oidc_login=attempt" } },
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://business.finlynq.com/signup?method=microsoft");
    expect(mocks.createOidcSignupProof).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ externalPrincipalId: "new-principal" }),
    );
    expect(mocks.setOidcSignupCookie).toHaveBeenCalledWith(response, "encrypted-signup-proof");
    expect(mocks.issueOidcUserSession).not.toHaveBeenCalled();
  });

  it("starts Microsoft signup under its independent gate and rate budget", async () => {
    const response = await start(new NextRequest(
      "https://business.finlynq.com/api/auth/oidc/start?intent=signup",
      { headers: { "sec-fetch-site": "same-origin" } },
    ));

    expect(response.status).toBe(303);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith("oidc-signup-ip-minute", "i".repeat(64), 10, 60);
    expect(mocks.createOidcAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      "/app",
      { intent: "signup" },
    );
  });

  it("reconfirms Microsoft identity before accepting a contact-email link", async () => {
    mocks.consumeOidcLoginAttempt.mockReturnValue({
      nonce: "nonce",
      verifier: "verifier",
      next: "/complete-signup?method=microsoft",
      intent: "signup-accept",
    });
    const response = await callback(new NextRequest(
      "https://business.finlynq.com/api/auth/oidc/callback?code=authorization-code&state=state",
      { headers: { Cookie: "business_finlynq_oidc_login=attempt" } },
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://business.finlynq.com/complete-signup?method=microsoft&identity=verified",
    );
    expect(mocks.setOidcSignupCookie).toHaveBeenCalledWith(response, "encrypted-signup-proof");
    expect(mocks.resolveOidcIdentity).not.toHaveBeenCalled();
    expect(mocks.issueOidcUserSession).not.toHaveBeenCalled();
  });
});
