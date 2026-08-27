import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const principal = {
    sessionId: "20000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    organizationId: "20000000-0000-4000-8000-000000000003",
    membershipId: "20000000-0000-4000-8000-000000000004",
    organizationName: "Rate-limit tenant",
    roleLabel: "Owner",
    displayName: "Owner",
    initials: "OW",
    sessionMode: "real" as const,
    authMethod: "PASSWORD" as const,
    expiresAt: new Date("2026-08-27T00:00:00Z"),
    mfaVerifiedAt: new Date("2026-08-26T18:00:00Z"),
    stepUpExpiresAt: null,
  };
  const allowed = { allowed: true, retry_after_seconds: 0 };
  const blocked = { allowed: false, retry_after_seconds: 47 };
  return {
    principal,
    allowed,
    blocked,
    requestPrincipal: vi.fn(async () => principal),
    requestFingerprints: vi.fn(() => ({ ipHash: "i".repeat(64), userAgentHash: null })),
    consumeIp: vi.fn(async () => allowed),
    consumeStepUp: vi.fn(async () => blocked),
    consumeReset: vi.fn(async () => blocked),
    consumeEscalation: vi.fn(async () => blocked),
    consumeApproval: vi.fn(async () => blocked),
    consumeEnrollment: vi.fn(async () => blocked),
    totpForSession: vi.fn(),
    passwordResetChallenge: vi.fn(),
    approveRecovery: vi.fn(),
    mfaSetupChallenge: vi.fn(),
    escalatePasswordReset: vi.fn(),
  };
});

vi.mock("@/modules/identity/request-security", () => ({
  validateSameOriginMutation: vi.fn(() => true),
  requestFingerprints: mocks.requestFingerprints,
}));
vi.mock("@/modules/identity/session", () => ({
  requestPrincipal: mocks.requestPrincipal,
  hashOpaqueToken: vi.fn(() => "t".repeat(64)),
}));
vi.mock("@/modules/identity/email-provider", () => ({
  assertAccountAuthenticationConfigured: vi.fn(),
}));
vi.mock("@/modules/identity/passwords", () => ({ hashPassword: vi.fn() }));
vi.mock("@/modules/identity/totp", () => ({
  createTotpSecret: vi.fn(),
  totpEnrollmentUri: vi.fn(),
  verifyTotp: vi.fn(),
}));
vi.mock("@/security/identity-secret", () => ({
  decryptAuthPayload: vi.fn(),
  decryptIdentityField: vi.fn(),
  encryptAuthPayload: vi.fn(),
}));
vi.mock("@/modules/identity/auth-store", () => ({
  assertEmailDeliveryReady: vi.fn(async () => undefined),
  consumeRateLimit: mocks.consumeIp,
  consumeMfaStepUpLimits: mocks.consumeStepUp,
  consumePasswordResetLimits: mocks.consumeReset,
  consumePasswordResetEscalationLimits: mocks.consumeEscalation,
  consumeRecoveryApprovalLimits: mocks.consumeApproval,
  consumeMfaEnrollmentLimits: mocks.consumeEnrollment,
  markStepUp: vi.fn(),
  totpForSession: mocks.totpForSession,
  authorizePasswordResetTotp: vi.fn(),
  finishPasswordReset: vi.fn(),
  finishPasswordResetWithMfa: vi.fn(),
  passwordResetChallenge: mocks.passwordResetChallenge,
  prepareRecoveryMfa: vi.fn(),
  approveRecovery: mocks.approveRecovery,
  finishMfaEnrollment: vi.fn(),
  mfaSetupChallenge: mocks.mfaSetupChallenge,
  escalatePasswordReset: mocks.escalatePasswordReset,
}));

import { POST as stepUp } from "@/app/api/auth/mfa/step-up/route";
import { POST as confirmEnrollment } from "@/app/api/auth/mfa/enroll/confirm/route";
import { POST as confirmReset } from "@/app/api/auth/password-reset/confirm/route";
import { POST as escalateReset } from "@/app/api/auth/password-reset/escalate/route";
import { POST as approveRecovery } from "@/app/api/auth/recovery/approve/route";

const previousAccountLoginEnabled = process.env.ACCOUNT_LOGIN_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ACCOUNT_LOGIN_ENABLED = "true";
  mocks.consumeIp.mockResolvedValue(mocks.allowed);
  mocks.consumeStepUp.mockResolvedValue(mocks.blocked);
  mocks.consumeReset.mockResolvedValue(mocks.blocked);
  mocks.consumeEscalation.mockResolvedValue(mocks.blocked);
  mocks.consumeApproval.mockResolvedValue(mocks.blocked);
  mocks.consumeEnrollment.mockResolvedValue(mocks.blocked);
});

afterAll(() => {
  if (previousAccountLoginEnabled === undefined) delete process.env.ACCOUNT_LOGIN_ENABLED;
  else process.env.ACCOUNT_LOGIN_ENABLED = previousAccountLoginEnabled;
});

function jsonRequest(path: string, body: unknown, ip: string): NextRequest {
  return new NextRequest(`https://business.finlynq.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify(body),
  });
}

describe("authentication principal and token rate-limit route gates", () => {
  it("blocks the same MFA session even when the caller rotates IPs", async () => {
    for (const ip of ["198.51.100.1", "203.0.113.9"]) {
      const response = await stepUp(jsonRequest("/api/auth/mfa/step-up", { otp: "000000" }, ip));
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("47");
    }
    expect(mocks.consumeStepUp).toHaveBeenCalledTimes(2);
    expect(mocks.consumeStepUp).toHaveBeenCalledWith(mocks.principal.sessionId);
    expect(mocks.totpForSession).not.toHaveBeenCalled();
  });

  it("stops reset confirmation and factor replacement at the hashed-token budget", async () => {
    const response = await confirmReset(jsonRequest("/api/auth/password-reset/confirm", {
      token: "r".repeat(48), password: "a sufficiently long replacement password", otp: "000000",
    }, "198.51.100.2"));
    expect(response.status).toBe(429);
    expect(mocks.consumeReset).toHaveBeenCalledWith("t".repeat(64));
    expect(mocks.passwordResetChallenge).not.toHaveBeenCalled();
  });

  it("binds co-owner approval attempts to both the session and recovery request", async () => {
    const recoveryRequestId = "30000000-0000-4000-8000-000000000001";
    const response = await approveRecovery(jsonRequest("/api/auth/recovery/approve", {
      recoveryRequestId, otp: "000000",
    }, "198.51.100.3"));
    expect(response.status).toBe(429);
    expect(mocks.consumeApproval).toHaveBeenCalledWith(mocks.principal.sessionId, recoveryRequestId);
    expect(mocks.totpForSession).not.toHaveBeenCalled();
  });

  it("blocks enrollment by setup-token budget before reading the encrypted factor", async () => {
    const response = await confirmEnrollment(jsonRequest("/api/auth/mfa/enroll/confirm", {
      setupToken: "s".repeat(48), otp: "000000",
    }, "198.51.100.4"));
    expect(response.status).toBe(429);
    expect(mocks.consumeEnrollment).toHaveBeenCalledWith("t".repeat(64));
    expect(mocks.mfaSetupChallenge).not.toHaveBeenCalled();
  });

  it("binds factor-loss escalation to the reset token instead of the IP", async () => {
    const response = await escalateReset(jsonRequest("/api/auth/password-reset/escalate", {
      token: "e".repeat(48),
    }, "198.51.100.5"));
    expect(response.status).toBe(429);
    expect(mocks.consumeEscalation).toHaveBeenCalledWith("t".repeat(64));
    expect(mocks.escalatePasswordReset).not.toHaveBeenCalled();
  });
});
