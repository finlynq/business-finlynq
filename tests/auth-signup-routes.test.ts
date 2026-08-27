import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  limit: vi.fn(async () => ({ allowed: true, retry_after_seconds: 0 })),
  verifyChallenge: vi.fn(async () => true),
  requestSignup: vi.fn(async () => true),
  acceptSignup: vi.fn(),
}));

vi.mock("@/modules/identity/auth-store", () => ({
  assertEmailDeliveryReady: vi.fn(async () => undefined),
  consumeRateLimit: mocks.limit,
}));
vi.mock("@/modules/identity/email-provider", () => ({
  assertAccountAuthenticationConfigured: vi.fn(),
}));
vi.mock("@/modules/identity/request-security", () => ({
  clientIp: vi.fn(() => "198.51.100.2"),
  requestFingerprints: vi.fn(() => ({ ipHash: "i".repeat(64), userAgentHash: null })),
  validateSameOriginMutation: vi.fn(() => true),
}));
vi.mock("@/modules/identity/response-timing", () => ({
  settleSensitiveResponse: vi.fn(async () => undefined),
}));
vi.mock("@/modules/identity/signup-challenge", () => ({
  assertSignupChallengeConfigured: vi.fn(),
  verifySignupChallenge: mocks.verifyChallenge,
}));
vi.mock("@/modules/identity/signup-service", () => ({
  requestOwnerSignup: mocks.requestSignup,
  acceptOwnerSignup: mocks.acceptSignup,
}));
vi.mock("@/security/identity-secret", () => ({
  normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
  emailLookupHash: vi.fn(() => "e".repeat(64)),
  identityLookupHash: vi.fn(() => "h".repeat(64)),
}));

import { POST as requestSignup } from "@/app/api/auth/signup/request/route";
import { POST as acceptSignup } from "@/app/api/auth/signup/accept/route";

const previousSignupEnabled = process.env.ACCOUNT_SIGNUP_ENABLED;
const previousLoginEnabled = process.env.ACCOUNT_LOGIN_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ACCOUNT_SIGNUP_ENABLED = "true";
  process.env.ACCOUNT_LOGIN_ENABLED = "true";
  mocks.limit.mockResolvedValue({ allowed: true, retry_after_seconds: 0 });
  mocks.verifyChallenge.mockResolvedValue(true);
  mocks.requestSignup.mockResolvedValue(true);
  mocks.acceptSignup.mockResolvedValue({ status: "invalid" });
});

afterAll(() => {
  if (previousSignupEnabled === undefined) delete process.env.ACCOUNT_SIGNUP_ENABLED;
  else process.env.ACCOUNT_SIGNUP_ENABLED = previousSignupEnabled;
  if (previousLoginEnabled === undefined) delete process.env.ACCOUNT_LOGIN_ENABLED;
  else process.env.ACCOUNT_LOGIN_ENABLED = previousLoginEnabled;
});

function request(
  path: string,
  body: unknown,
  contentType = "application/json",
  additionalHeaders: Record<string, string> = {},
) {
  return new NextRequest(`https://business.finlynq.com${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType, ...additionalHeaders },
    body: JSON.stringify(body),
  });
}

function streamedRequest(path: string, chunks: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  };
  return new NextRequest(new Request(`https://business.finlynq.com${path}`, init));
}

const validRequest = {
  email: "owner@example.com",
  displayName: "Example Owner",
  organizationName: "Example Books",
  entityCode: "CA01",
  entityName: "Example Books Inc.",
  countryCode: "CA",
  regionCode: "ON",
  fiscalYear: 2026,
  manualPostingMode: "AUTO_POST",
  termsAccepted: true,
  challengeToken: "verified-token",
};

describe("public owner signup routes", () => {
  it("keeps new signup disabled unless its independent gate is enabled", async () => {
    process.env.ACCOUNT_SIGNUP_ENABLED = "false";
    const response = await requestSignup(request("/api/auth/signup/request", validRequest));
    expect(response.status).toBe(403);
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("consumes the coarse caller budget before bot verification and provisioning", async () => {
    mocks.limit.mockResolvedValue({ allowed: false, retry_after_seconds: 91 });
    const response = await requestSignup(request("/api/auth/signup/request", validRequest));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("91");
    expect(mocks.verifyChallenge).not.toHaveBeenCalled();
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("fails closed when bot verification does not validate", async () => {
    mocks.verifyChallenge.mockResolvedValue(false);
    const response = await requestSignup(request("/api/auth/signup/request", validRequest));
    expect(response.status).toBe(400);
    expect(mocks.limit).toHaveBeenCalledTimes(1);
    expect(mocks.limit).toHaveBeenCalledWith("organization-signup-ip-hour", "i".repeat(64), 6, 3600);
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("spends the victim-specific email budget only after a valid challenge", async () => {
    mocks.limit
      .mockResolvedValueOnce({ allowed: true, retry_after_seconds: 0 })
      .mockResolvedValueOnce({ allowed: false, retry_after_seconds: 3600 });
    const response = await requestSignup(request("/api/auth/signup/request", validRequest));
    expect(response.status).toBe(202);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(mocks.verifyChallenge).toHaveBeenCalledOnce();
    expect(mocks.limit).toHaveBeenNthCalledWith(
      2,
      "organization-signup-email-day",
      "h".repeat(64),
      4,
      86400,
    );
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("returns the same accepted response when the database declines an existing email", async () => {
    mocks.requestSignup.mockResolvedValue(false);
    const response = await requestSignup(request("/api/auth/signup/request", validRequest));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      message: "If this email can start an account, a verification link will be sent shortly.",
    });
  });

  it("rejects non-JSON signup mutations", async () => {
    const response = await requestSignup(request("/api/auth/signup/request", validRequest, "text/plain"));
    expect(response.status).toBe(415);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.limit).toHaveBeenCalledTimes(1);
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized signup body after the coarse IP gate", async () => {
    const response = await requestSignup(request(
      "/api/auth/signup/request",
      validRequest,
      "application/json",
      { "Content-Length": "16385" },
    ));
    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.limit).toHaveBeenCalledTimes(1);
    expect(mocks.verifyChallenge).not.toHaveBeenCalled();
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("applies an IP budget before accepting a signup link", async () => {
    mocks.limit.mockResolvedValue({ allowed: false, retry_after_seconds: 47 });
    const response = await acceptSignup(request("/api/auth/signup/accept", {
      token: "t".repeat(48),
      password: "a sufficiently long password",
    }));
    expect(response.status).toBe(429);
    expect(mocks.acceptSignup).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed signup-accept body without a declared length", async () => {
    const response = await acceptSignup(streamedRequest("/api/auth/signup/accept", [
      `{"token":"${"t".repeat(9_000)}`,
      `${"t".repeat(9_000)}","password":"a sufficiently long password"}`,
    ]));
    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.limit).toHaveBeenCalledTimes(1);
    expect(mocks.acceptSignup).not.toHaveBeenCalled();
  });

  it("allows outstanding verification links when new signup is switched off", async () => {
    process.env.ACCOUNT_SIGNUP_ENABLED = "false";
    mocks.acceptSignup.mockResolvedValue({
      status: "accepted",
      setupToken: "setup-token",
      secret: "TOTPSECRET",
      enrollmentUri: "otpauth://example",
      organizationName: "Example Books",
    });
    const response = await acceptSignup(request("/api/auth/signup/accept", {
      token: "t".repeat(48),
      password: "a sufficiently long password",
    }));
    expect(response.status).toBe(200);
    expect(mocks.acceptSignup).toHaveBeenCalledOnce();
  });
});
