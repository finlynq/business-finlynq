import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestPrincipal: vi.fn(),
  consumeRateLimit: vi.fn(),
  consumeMfaEnrollmentLimits: vi.fn(),
  skipMfaEnrollment: vi.fn(),
  beginSessionMfaEnrollment: vi.fn(),
  finishSessionMfaEnrollment: vi.fn(),
  mfaSetupChallenge: vi.fn(),
  passwordForSession: vi.fn(),
  recordSessionReauthenticationFailure: vi.fn(),
  verifyPassword: vi.fn(),
  setSessionCookie: vi.fn(),
  validateSameOriginMutation: vi.fn(),
}));

vi.mock("@/modules/identity/auth-store", () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  consumeMfaEnrollmentLimits: mocks.consumeMfaEnrollmentLimits,
  skipMfaEnrollment: mocks.skipMfaEnrollment,
  beginSessionMfaEnrollment: mocks.beginSessionMfaEnrollment,
  finishSessionMfaEnrollment: mocks.finishSessionMfaEnrollment,
  mfaSetupChallenge: mocks.mfaSetupChallenge,
  passwordForSession: mocks.passwordForSession,
  recordSessionReauthenticationFailure: mocks.recordSessionReauthenticationFailure,
}));
vi.mock("@/modules/identity/authenticator-qr", () => ({
  authenticatorQrCodeDataUrl: vi.fn(async () => "data:image/png;base64,qr"),
}));
vi.mock("@/modules/identity/email-provider", () => ({
  assertAccountAuthenticationConfigured: vi.fn(),
}));
vi.mock("@/modules/identity/passwords", () => ({
  verifyPassword: mocks.verifyPassword,
}));
vi.mock("@/modules/identity/request-security", () => ({
  requestFingerprints: vi.fn(() => ({ ipHash: "i".repeat(64), userAgentHash: "u".repeat(64) })),
  validateSameOriginMutation: mocks.validateSameOriginMutation,
}));
vi.mock("@/modules/identity/session", () => ({
  createOpaqueToken: vi.fn(() => ({ raw: "r".repeat(43), hash: "h".repeat(64) })),
  hashOpaqueToken: vi.fn(() => "h".repeat(64)),
  requestPrincipal: mocks.requestPrincipal,
  setSessionCookie: mocks.setSessionCookie,
}));
vi.mock("@/modules/identity/totp", () => ({
  createTotpSecret: vi.fn(() => "JBSWY3DPEHPK3PXP"),
  totpEnrollmentUri: vi.fn(() => "otpauth://totp/Business%20Finlynq%3AOwner?secret=JBSWY3DPEHPK3PXP"),
  verifyTotp: vi.fn(() => 12345),
}));
vi.mock("@/security/identity-secret", () => ({
  decryptAuthPayload: vi.fn(() => "JBSWY3DPEHPK3PXP"),
  encryptAuthPayload: vi.fn(() => `authv1:${"e".repeat(64)}`),
  identityLookupHash: vi.fn(() => "l".repeat(64)),
}));

import { POST as enableEnrollment } from "@/app/api/auth/mfa/enroll/enable/route";
import { POST as skipEnrollment } from "@/app/api/auth/mfa/enroll/skip/route";
import { POST as startEnrollment } from "@/app/api/auth/mfa/enroll/start/route";

const previousLoginEnabled = process.env.ACCOUNT_LOGIN_ENABLED;
const principal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Example Books",
  roleLabel: "Owner",
  displayName: "Example Owner",
  initials: "EO",
  sessionMode: "real" as const,
  authMethod: "PASSWORD" as const,
  expiresAt: new Date("2026-09-01T00:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ACCOUNT_LOGIN_ENABLED = "true";
  mocks.requestPrincipal.mockResolvedValue(principal);
  mocks.validateSameOriginMutation.mockReturnValue(true);
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true, retry_after_seconds: 0 });
  mocks.consumeMfaEnrollmentLimits.mockResolvedValue({ allowed: true, retry_after_seconds: 0 });
  mocks.skipMfaEnrollment.mockResolvedValue(true);
  mocks.beginSessionMfaEnrollment.mockResolvedValue(true);
  mocks.finishSessionMfaEnrollment.mockResolvedValue(true);
  mocks.passwordForSession.mockResolvedValue({
    user_id: principal.userId,
    password_hash: "scrypt-password-hash",
  });
  mocks.recordSessionReauthenticationFailure.mockResolvedValue(undefined);
  mocks.verifyPassword.mockResolvedValue(true);
  mocks.mfaSetupChallenge.mockResolvedValue({
    user_id: principal.userId,
    organization_id: principal.organizationId,
    factor_id: "20000000-0000-4000-8000-000000000001",
    factor_secret_ciphertext: `authv1:${"e".repeat(64)}`,
  });
});

afterAll(() => {
  if (previousLoginEnabled === undefined) delete process.env.ACCOUNT_LOGIN_ENABLED;
  else process.env.ACCOUNT_LOGIN_ENABLED = previousLoginEnabled;
});

function request(path: string, body?: unknown) {
  return new NextRequest(`https://business.finlynq.com${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("optional authenticator enrollment routes", () => {
  const protectedRoutes = [
    [skipEnrollment, "/api/auth/mfa/enroll/skip", { setupToken: "s".repeat(43) }],
    [startEnrollment, "/api/auth/mfa/enroll/start", { currentPassword: "correct horse battery staple" }],
    [enableEnrollment, "/api/auth/mfa/enroll/enable", { setupToken: "s".repeat(43), otp: "123456" }],
  ] as const;

  it("fails every enrollment mutation closed on a cross-site request", async () => {
    mocks.validateSameOriginMutation.mockReturnValue(false);
    for (const [handler, path, body] of protectedRoutes) {
      expect((await handler(request(path, body))).status).toBe(403);
    }
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.skipMfaEnrollment).not.toHaveBeenCalled();
    expect(mocks.beginSessionMfaEnrollment).not.toHaveBeenCalled();
    expect(mocks.finishSessionMfaEnrollment).not.toHaveBeenCalled();
  });

  it("rate-limits every enrollment mutation before changing authentication state", async () => {
    mocks.consumeRateLimit.mockResolvedValue({ allowed: false, retry_after_seconds: 90 });
    for (const [handler, path, body] of protectedRoutes) {
      const response = await handler(request(path, body));
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("90");
    }
    expect(mocks.skipMfaEnrollment).not.toHaveBeenCalled();
    expect(mocks.beginSessionMfaEnrollment).not.toHaveBeenCalled();
    expect(mocks.finishSessionMfaEnrollment).not.toHaveBeenCalled();
  });

  it("activates a first-time account in explicit password-only mode", async () => {
    const response = await skipEnrollment(request("/api/auth/mfa/enroll/skip", {
      setupToken: "s".repeat(43),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      authentication: "PASSWORD_ONLY",
    });
    expect(mocks.skipMfaEnrollment).toHaveBeenCalledWith("h".repeat(64), expect.any(String));
  });

  it("starts later enrollment and returns a locally generated QR image", async () => {
    const response = await startEnrollment(request("/api/auth/mfa/enroll/start", {
      currentPassword: "correct horse battery staple",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      setupToken: "r".repeat(43),
      secret: "JBSWY3DPEHPK3PXP",
      qrCodeDataUrl: "data:image/png;base64,qr",
      organizationName: "Example Books",
    });
    expect(mocks.beginSessionMfaEnrollment).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: principal.sessionId,
      setupTokenHash: "h".repeat(64),
    }));
    expect(mocks.verifyPassword).toHaveBeenCalledWith(
      "correct horse battery staple",
      "scrypt-password-hash",
    );
  });

  it("confirms later enrollment against the signed-in session", async () => {
    const response = await enableEnrollment(request("/api/auth/mfa/enroll/enable", {
      setupToken: "s".repeat(43),
      otp: "123456",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      stepUpExpiresInSeconds: 600,
    });
    expect(mocks.finishSessionMfaEnrollment).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: principal.sessionId,
      factorId: "20000000-0000-4000-8000-000000000001",
      counter: 12345,
      replacementSessionTokenHash: "h".repeat(64),
    }));
    expect(mocks.setSessionCookie).toHaveBeenCalledWith(
      response,
      "r".repeat(43),
      expect.any(Number),
    );
  });

  it("does not return a replacement bearer when atomic MFA activation fails", async () => {
    mocks.finishSessionMfaEnrollment.mockResolvedValue(false);
    const response = await enableEnrollment(request("/api/auth/mfa/enroll/enable", {
      setupToken: "s".repeat(43),
      otp: "123456",
    }));

    expect(response.status).toBe(401);
    expect(mocks.setSessionCookie).not.toHaveBeenCalled();
  });

  it("does not expose account enrollment to an unauthenticated browser", async () => {
    mocks.requestPrincipal.mockResolvedValue(null);
    const response = await startEnrollment(request("/api/auth/mfa/enroll/start", {
      currentPassword: "correct horse battery staple",
    }));
    expect(response.status).toBe(401);
    expect(mocks.beginSessionMfaEnrollment).not.toHaveBeenCalled();
  });

  it("rejects a wrong current password before creating an authenticator secret", async () => {
    mocks.verifyPassword.mockResolvedValue(false);
    const response = await startEnrollment(request("/api/auth/mfa/enroll/start", {
      currentPassword: "wrong password",
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "The current password is incorrect." });
    expect(mocks.recordSessionReauthenticationFailure).toHaveBeenCalledWith(
      principal.sessionId,
      expect.any(String),
    );
    expect(mocks.beginSessionMfaEnrollment).not.toHaveBeenCalled();
  });
});
