import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeLimits: vi.fn(),
  hashPassword: vi.fn(async () => "password-hash"),
  acceptSignup: vi.fn(),
}));

vi.mock("@/modules/identity/signup-store", () => ({
  consumeSignupAcceptLimits: mocks.consumeLimits,
  acceptOrganizationSignup: mocks.acceptSignup,
  beginOrganizationSignup: vi.fn(),
}));
vi.mock("@/modules/identity/passwords", () => ({ hashPassword: mocks.hashPassword }));
vi.mock("@/modules/identity/session", () => ({
  hashOpaqueToken: vi.fn(() => "t".repeat(64)),
  createOpaqueToken: vi.fn(() => ({ raw: "raw-setup-token", hash: "s".repeat(64) })),
}));
vi.mock("@/modules/identity/totp", () => ({
  createTotpSecret: vi.fn(() => "TOTPSECRET"),
  totpEnrollmentUri: vi.fn(() => "otpauth://example"),
}));
vi.mock("@/security/identity-secret", () => ({
  encryptAuthPayload: vi.fn(() => "encrypted-totp"),
  decryptIdentityField: vi.fn(() => "owner@example.com"),
  emailLookupHash: vi.fn(),
  encryptIdentityField: vi.fn(),
  identityDerivedUuid: vi.fn(),
  loadIdentitySecret: vi.fn(),
  normalizeEmail: vi.fn(),
}));
vi.mock("@/security/organization-encryption", () => ({
  LocalRootKeyProvider: vi.fn(),
  generateOrganizationDek: vi.fn(),
  serializeWrappedKey: vi.fn(),
}));
vi.mock("@/security/root-secret", () => ({ loadOrganizationRootKek: vi.fn() }));

import { acceptOwnerSignup } from "@/modules/identity/signup-service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consumeLimits.mockResolvedValue({ eligible: false, allowed: false, retry_after_seconds: 3600 });
  mocks.acceptSignup.mockResolvedValue(null);
});

describe("signup acceptance cost controls", () => {
  it("does not run scrypt for an unknown or expired token", async () => {
    await expect(acceptOwnerSignup({
      token: "raw-token",
      password: "a sufficiently long password",
      requestId: "request",
    })).resolves.toEqual({ status: "invalid" });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.acceptSignup).not.toHaveBeenCalled();
  });

  it("does not run scrypt after the token or principal budget is exhausted", async () => {
    mocks.consumeLimits.mockResolvedValue({ eligible: true, allowed: false, retry_after_seconds: 73 });
    await expect(acceptOwnerSignup({
      token: "raw-token",
      password: "a sufficiently long password",
      requestId: "request",
    })).resolves.toEqual({ status: "rate-limited", retryAfterSeconds: 73 });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
  });

  it("hashes only after both durable budgets admit the request", async () => {
    mocks.consumeLimits.mockResolvedValue({ eligible: true, allowed: true, retry_after_seconds: 0 });
    mocks.acceptSignup.mockResolvedValue({
      user_id: "user-id",
      email_ciphertext: "encrypted-email",
      organization_name: "Example Books",
      factor_id: "factor-id",
    });
    await expect(acceptOwnerSignup({
      token: "raw-token",
      password: "a sufficiently long password",
      requestId: "request",
    })).resolves.toMatchObject({ status: "accepted", organizationName: "Example Books" });
    expect(mocks.hashPassword).toHaveBeenCalledOnce();
    expect(mocks.acceptSignup).toHaveBeenCalledOnce();
  });
});
