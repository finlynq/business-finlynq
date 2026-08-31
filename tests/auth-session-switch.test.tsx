import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const demoPrincipal = {
    sessionId: "20000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    organizationId: "20000000-0000-4000-8000-000000000003",
    membershipId: "20000000-0000-4000-8000-000000000004",
    organizationName: "Northstar Demo Sandbox 001",
    roleLabel: "Demo owner",
    displayName: "Demo owner",
    initials: "DO",
    sessionMode: "demo" as const,
    authMethod: "DEMO_LINK" as const,
    expiresAt: new Date("2026-08-28T08:15:00Z"),
    mfaVerifiedAt: null,
    stepUpExpiresAt: null,
  };
  const realPrincipal = {
    ...demoPrincipal,
    sessionMode: "real" as const,
    authMethod: "PASSWORD" as const,
  };
  const identity = {
    user_id: "30000000-0000-4000-8000-000000000001",
    password_hash: "password-hash",
    email_ciphertext: "encrypted-email",
    display_name_ciphertext: "encrypted-name",
    email_verified_at: new Date("2026-08-27T00:00:00Z"),
    mfa_required: true,
    mfa_factor_id: "30000000-0000-4000-8000-000000000002",
    mfa_secret_ciphertext: "encrypted-totp",
    mfa_last_accepted_counter: 100,
    organization_id: "30000000-0000-4000-8000-000000000003",
    organization_name: "Private business",
    membership_id: "30000000-0000-4000-8000-000000000004",
    role_label: "Owner",
  };
  return {
    demoPrincipal,
    realPrincipal,
    identity,
    currentPrincipal: vi.fn(),
    requestPrincipal: vi.fn(),
    consumeRateLimit: vi.fn(),
    lookupLogin: vi.fn(),
    issueMfaUserSession: vi.fn(),
    issuePasswordUserSession: vi.fn(),
    recordLoginFailure: vi.fn(),
    verifyPassword: vi.fn(),
    setSessionCookie: vi.fn(),
  };
});

vi.mock("@/modules/identity/session", () => ({
  currentPrincipal: mocks.currentPrincipal,
  requestPrincipal: mocks.requestPrincipal,
  createOpaqueToken: () => ({ raw: "new-real-session-token", hash: "new-real-session-hash" }),
  hashOpaqueToken: (raw: string) => `hashed:${raw}`,
  sessionCookieName: () => "business_finlynq_session",
  setSessionCookie: mocks.setSessionCookie,
}));
vi.mock("@/modules/identity/auth-store", () => ({
  assertEmailDeliveryReady: vi.fn(async () => undefined),
  consumeRateLimit: mocks.consumeRateLimit,
  lookupLogin: mocks.lookupLogin,
  issueMfaUserSession: mocks.issueMfaUserSession,
  issuePasswordUserSession: mocks.issuePasswordUserSession,
  recordLoginFailure: mocks.recordLoginFailure,
}));
vi.mock("@/modules/identity/email-provider", () => ({
  assertAccountAuthenticationConfigured: vi.fn(),
}));
vi.mock("@/modules/identity/passwords", () => ({
  consumeDummyPasswordCheck: vi.fn(),
  verifyPassword: mocks.verifyPassword,
}));
vi.mock("@/modules/identity/request-security", () => ({
  requestFingerprints: (request: { headers: Headers }) => ({
    ipHash: "i".repeat(64),
    userAgentHash: `user-agent-hash:${(request.headers.get("user-agent") ?? "").slice(0, 1000)}`,
  }),
  validateSameOriginMutation: () => true,
}));
vi.mock("@/modules/identity/totp", () => ({ verifyTotp: () => 101 }));
vi.mock("@/security/identity-secret", () => ({
  decryptAuthPayload: () => "JBSWY3DPEHPK3PXP",
  emailLookupHash: () => "e".repeat(64),
  identityLookupHash: () => "f".repeat(64),
}));

import LoginPage from "@/app/(auth)/login/page";
import { POST as login } from "@/app/api/auth/login/route";

const previousAccountLoginEnabled = process.env.ACCOUNT_LOGIN_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ACCOUNT_LOGIN_ENABLED = "true";
  mocks.currentPrincipal.mockResolvedValue(mocks.demoPrincipal);
  mocks.requestPrincipal.mockResolvedValue(null);
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true, retry_after_seconds: 0 });
  mocks.lookupLogin.mockResolvedValue([mocks.identity]);
  mocks.verifyPassword.mockResolvedValue(true);
  mocks.issueMfaUserSession.mockResolvedValue("40000000-0000-4000-8000-000000000001");
  mocks.issuePasswordUserSession.mockResolvedValue("40000000-0000-4000-8000-000000000002");
});

afterAll(() => {
  if (previousAccountLoginEnabled === undefined) delete process.env.ACCOUNT_LOGIN_ENABLED;
  else process.env.ACCOUNT_LOGIN_ENABLED = previousAccountLoginEnabled;
});

function loginRequest(cookieToken = "existing-demo-session-token") {
  return new NextRequest("https://business.finlynq.com/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `business_finlynq_session=${cookieToken}`,
    },
    body: JSON.stringify({
      email: "owner@example.com",
      password: "a sufficiently long password",
      otp: "123456",
      next: "/app/receivables/invoices",
    }),
  });
}

describe("demo-to-real account session switching", () => {
  it("lets an active demo user reach the real-account sign-in form", async () => {
    const page = await LoginPage({ searchParams: Promise.resolve({}) });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Sign in to switch from the public demo to your private organization.");
    expect(markup).toContain("<form");
    expect(markup).toContain("Sign in");
  });

  it("replaces the demo session only after successful password and MFA verification", async () => {
    mocks.requestPrincipal.mockResolvedValue(mocks.demoPrincipal);

    const response = await login(loginRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      next: "/app/receivables/invoices",
    });
    expect(mocks.issueMfaUserSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: mocks.identity.user_id,
      userAgentHash: "user-agent-hash:",
      replacedDemoSessionTokenHash: "hashed:existing-demo-session-token",
      totpCounter: 101,
    }));
    expect(mocks.setSessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      "new-real-session-token",
      24 * 60 * 60,
    );
  });

  it("issues a password-only session when the user intentionally skipped MFA", async () => {
    mocks.requestPrincipal.mockResolvedValue(mocks.demoPrincipal);
    mocks.lookupLogin.mockResolvedValue([{
      ...mocks.identity,
      mfa_required: false,
      mfa_factor_id: null,
      mfa_secret_ciphertext: null,
      mfa_last_accepted_counter: null,
    }]);

    const response = await login(loginRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      next: "/app/receivables/invoices",
    });
    expect(mocks.issuePasswordUserSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: mocks.identity.user_id,
      userAgentHash: "user-agent-hash:",
      replacedDemoSessionTokenHash: "hashed:existing-demo-session-token",
    }));
    expect(mocks.issueMfaUserSession).not.toHaveBeenCalled();
    expect(mocks.setSessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      "new-real-session-token",
      24 * 60 * 60,
    );
  });

  it("keeps the demo session when real-account credentials are rejected", async () => {
    mocks.requestPrincipal.mockResolvedValue(mocks.demoPrincipal);
    mocks.verifyPassword.mockResolvedValue(false);

    const response = await login(loginRequest());

    expect(response.status).toBe(401);
    expect(mocks.issueMfaUserSession).not.toHaveBeenCalled();
    expect(mocks.setSessionCookie).not.toHaveBeenCalled();
  });

  it("preserves the existing short-circuit for an authenticated real user", async () => {
    mocks.requestPrincipal.mockResolvedValue(mocks.realPrincipal);

    const response = await login(loginRequest("existing-real-session-token"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, next: "/app" });
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.issueMfaUserSession).not.toHaveBeenCalled();
  });
});
