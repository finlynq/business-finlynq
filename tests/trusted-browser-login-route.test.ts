import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestPrincipal: vi.fn(),
  consumeRateLimit: vi.fn(),
  lookupLogin: vi.fn(),
  recordLoginFailure: vi.fn(),
  issuePasswordUserSession: vi.fn(),
  issueMfaUserSession: vi.fn(),
  issueMfaUserSessionWithTrust: vi.fn(),
  issueTrustedBrowserUserSession: vi.fn(),
  verifyPassword: vi.fn(),
  verifyTotp: vi.fn(),
  createOpaqueToken: vi.fn(),
  setSessionCookie: vi.fn(),
  setTrustedBrowserCookie: vi.fn(),
  clearTrustedBrowserCookie: vi.fn(),
}));

vi.mock("@/modules/identity/auth-store", () => ({
  assertEmailDeliveryReady: vi.fn(async () => undefined),
  consumeRateLimit: mocks.consumeRateLimit,
  lookupLogin: mocks.lookupLogin,
  recordLoginFailure: mocks.recordLoginFailure,
  issuePasswordUserSession: mocks.issuePasswordUserSession,
  issueMfaUserSession: mocks.issueMfaUserSession,
  issueMfaUserSessionWithTrust: mocks.issueMfaUserSessionWithTrust,
  issueTrustedBrowserUserSession: mocks.issueTrustedBrowserUserSession,
}));
vi.mock("@/modules/identity/email-provider", () => ({
  assertAccountAuthenticationConfigured: vi.fn(),
}));
vi.mock("@/modules/identity/passwords", () => ({
  consumeDummyPasswordCheck: vi.fn(async () => undefined),
  verifyPassword: mocks.verifyPassword,
}));
vi.mock("@/modules/identity/request-security", () => ({
  requestFingerprints: vi.fn(() => ({
    ipHash: "i".repeat(64),
    userAgentHash: "u".repeat(64),
  })),
  validateSameOriginMutation: vi.fn(() => true),
}));
vi.mock("@/modules/identity/session", () => ({
  createOpaqueToken: mocks.createOpaqueToken,
  hashOpaqueToken: vi.fn((raw: string) => "digest:" + raw),
  requestPrincipal: mocks.requestPrincipal,
  sessionCookieName: vi.fn(() => "business_finlynq_session"),
  setSessionCookie: mocks.setSessionCookie,
}));
vi.mock("@/modules/identity/trusted-browser", () => ({
  clearTrustedBrowserCookie: mocks.clearTrustedBrowserCookie,
  isPlausibleTrustedBrowserToken: vi.fn((raw: string | undefined) => raw?.length === 43),
  setTrustedBrowserCookie: mocks.setTrustedBrowserCookie,
  trustedBrowserCookieName: vi.fn(() => "business_finlynq_trusted_browser"),
  trustedBrowserLabel: vi.fn(() => "Chrome on Linux"),
}));
vi.mock("@/modules/identity/totp", () => ({
  verifyTotp: mocks.verifyTotp,
}));
vi.mock("@/security/identity-secret", () => ({
  decryptAuthPayload: vi.fn(() => "JBSWY3DPEHPK3PXP"),
  emailLookupHash: vi.fn(() => "e".repeat(64)),
  identityLookupHash: vi.fn(() => "l".repeat(64)),
}));

import { POST as login } from "@/app/api/auth/login/route";

const previousLoginEnabled = process.env.ACCOUNT_LOGIN_ENABLED;
const identity = {
  user_id: "10000000-0000-4000-8000-000000000001",
  password_hash: "scrypt-hash",
  email_ciphertext: "ciphertext",
  display_name_ciphertext: null,
  email_verified_at: new Date("2026-09-01T00:00:00Z"),
  mfa_required: true,
  mfa_factor_id: "10000000-0000-4000-8000-000000000002",
  mfa_secret_ciphertext: "factor-ciphertext",
  mfa_last_accepted_counter: 41,
  organization_id: "10000000-0000-4000-8000-000000000003",
  organization_name: "Tenant",
  membership_id: "10000000-0000-4000-8000-000000000004",
  role_label: "Owner",
  trusted_browser_enabled: true,
  trusted_browser_duration_days: 30,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ACCOUNT_LOGIN_ENABLED = "true";
  mocks.requestPrincipal.mockResolvedValue(null);
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true, retry_after_seconds: 0 });
  mocks.lookupLogin.mockResolvedValue([identity]);
  mocks.verifyPassword.mockResolvedValue(true);
  mocks.verifyTotp.mockReturnValue(42);
  let tokenNumber = 0;
  mocks.createOpaqueToken.mockImplementation(() => {
    tokenNumber += 1;
    return {
      raw: String(tokenNumber).repeat(43),
      hash: String(tokenNumber).repeat(64),
    };
  });
  mocks.issuePasswordUserSession.mockResolvedValue("20000000-0000-4000-8000-000000000001");
  mocks.issueMfaUserSession.mockResolvedValue("20000000-0000-4000-8000-000000000002");
  mocks.issueMfaUserSessionWithTrust.mockResolvedValue({
    sessionId: "20000000-0000-4000-8000-000000000003",
    trustedBrowserId: "30000000-0000-4000-8000-000000000001",
    trustedBrowserExpiresAt: new Date("2026-10-05T00:00:00Z"),
  });
  mocks.issueTrustedBrowserUserSession.mockResolvedValue(null);
});

afterAll(() => {
  if (previousLoginEnabled === undefined) delete process.env.ACCOUNT_LOGIN_ENABLED;
  else process.env.ACCOUNT_LOGIN_ENABLED = previousLoginEnabled;
});

function request(input: {
  otp?: string;
  trustBrowser?: boolean;
  trustedCookie?: string;
} = {}): NextRequest {
  const cookie = input.trustedCookie
    ? "business_finlynq_trusted_browser=" + input.trustedCookie
    : undefined;
  return new NextRequest("https://business.finlynq.com/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 Chrome/140.0 Linux",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({
      email: "owner@example.com",
      password: "correct password",
      otp: input.otp,
      trustBrowser: input.trustBrowser,
      next: "/app",
    }),
  });
}

describe("trusted-browser login route", () => {
  it("reveals the opt-in and duration only after the password is valid", async () => {
    const response = await login(request());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      mfaRequired: true,
      trustedBrowserAllowed: true,
      trustedBrowserDurationDays: 30,
    });
    expect(mocks.issueMfaUserSession).not.toHaveBeenCalled();
  });

  it("keeps the policy-approved opt-in visible after an invalid authenticator code", async () => {
    mocks.verifyTotp.mockReturnValue(null);
    const response = await login(request({ otp: "000000", trustBrowser: true }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid email address, password, or authenticator code.",
      mfaRequired: true,
      trustedBrowserAllowed: true,
      trustedBrowserDurationDays: 30,
    });
    expect(mocks.recordLoginFailure).toHaveBeenCalledTimes(1);
    expect(mocks.issueMfaUserSessionWithTrust).not.toHaveBeenCalled();
  });

  it("creates trust only when the user opts in after successful MFA", async () => {
    const response = await login(request({ otp: "123456", trustBrowser: true }));
    expect(response.status).toBe(200);
    expect(mocks.issueMfaUserSessionWithTrust).toHaveBeenCalledWith(expect.objectContaining({
      trustedBrowserTokenHash: "2".repeat(64),
      userAgentHash: "u".repeat(64),
      browserLabel: "Chrome on Linux",
      totpCounter: 42,
    }));
    expect(mocks.issueMfaUserSession).not.toHaveBeenCalled();
    expect(mocks.setTrustedBrowserCookie).toHaveBeenCalledWith(
      response,
      "2".repeat(43),
      new Date("2026-10-05T00:00:00Z"),
    );
  });

  it("rotates a valid trusted token and skips only login MFA", async () => {
    mocks.issueTrustedBrowserUserSession.mockResolvedValue({
      sessionId: "20000000-0000-4000-8000-000000000004",
      trustedBrowserId: "30000000-0000-4000-8000-000000000001",
      trustedBrowserExpiresAt: new Date("2026-10-05T00:00:00Z"),
    });
    const rawTrust = "t".repeat(43);
    const response = await login(request({ trustedCookie: rawTrust }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authentication: "PASSWORD_TRUSTED_BROWSER",
    });
    expect(mocks.issueTrustedBrowserUserSession).toHaveBeenCalledWith(expect.objectContaining({
      trustedBrowserTokenHash: "digest:" + rawTrust,
      replacementTrustedBrowserTokenHash: "2".repeat(64),
      sessionTokenHash: "1".repeat(64),
      userAgentHash: "u".repeat(64),
    }));
    expect(mocks.verifyTotp).not.toHaveBeenCalled();
    expect(mocks.setTrustedBrowserCookie).toHaveBeenCalledWith(
      response,
      "2".repeat(43),
      new Date("2026-10-05T00:00:00Z"),
    );
  });

  it("fails a copied, replayed, expired, or revoked token closed into the normal MFA challenge", async () => {
    const response = await login(request({ trustedCookie: "x".repeat(43) }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      mfaRequired: true,
      trustedBrowserAllowed: true,
    });
    expect(mocks.clearTrustedBrowserCookie).toHaveBeenCalledWith(response);
    expect(mocks.issueMfaUserSession).not.toHaveBeenCalled();
  });

  it("does not expose tenant trust policy when the password is rejected", async () => {
    mocks.verifyPassword.mockResolvedValue(false);
    const response = await login(request());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid email address or password.",
    });
    expect(mocks.issueTrustedBrowserUserSession).not.toHaveBeenCalled();
  });

  it("does not offer or honor trust when the tenant policy is disabled", async () => {
    mocks.lookupLogin.mockResolvedValue([{
      ...identity,
      trusted_browser_enabled: false,
      trusted_browser_duration_days: 30,
    }]);
    const challenge = await login(request());
    await expect(challenge.json()).resolves.toMatchObject({
      mfaRequired: true,
      trustedBrowserAllowed: false,
    });

    const completed = await login(request({ otp: "123456", trustBrowser: true }));
    expect(completed.status).toBe(200);
    expect(mocks.issueMfaUserSession).toHaveBeenCalled();
    expect(mocks.issueMfaUserSessionWithTrust).not.toHaveBeenCalled();
    expect(mocks.setTrustedBrowserCookie).not.toHaveBeenCalled();
  });
});
