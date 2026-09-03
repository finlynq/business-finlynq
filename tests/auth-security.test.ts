import { describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { consumeDummyPasswordCheck, hashPassword, verifyPassword } from "@/modules/identity/passwords";
import { renderAuthenticationEmail } from "@/modules/identity/auth-email";
import { loadEmailDeliveryConfiguration, loadEmailDeliveryMetadata, sendEmail } from "@/modules/identity/email-provider";
import { configuredAppOrigin, isSpeculativeNavigation } from "@/modules/identity/request-security";
import { settleSensitiveResponse } from "@/modules/identity/response-timing";
import { safeAppPath } from "@/modules/identity/safe-redirect";
import { createOpaqueToken, hashOpaqueToken, setSessionCookie, transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import { decodeBase32, encodeBase32, totpCode, verifyTotp } from "@/modules/identity/totp";
import {
  decryptAuthPayload,
  decryptIdentityField,
  emailLookupHash,
  encryptIdentityField,
  encryptAuthPayload,
  loadIdentitySecret,
} from "@/security/identity-secret";

const identitySecret = Buffer.alloc(64, 7).toString("base64");

describe("identity encryption and credentials", () => {
  it("loads only canonical 64-byte identity secrets", () => {
    expect(loadIdentitySecret({ IDENTITY_SECRET: identitySecret, NODE_ENV: "test" })).toHaveLength(64);
    expect(() => loadIdentitySecret({ IDENTITY_SECRET: Buffer.alloc(32).toString("base64"), NODE_ENV: "test" })).toThrow(/64 bytes/);
    expect(() => loadIdentitySecret({ IDENTITY_SECRET: identitySecret, NODE_ENV: "production" })).toThrow(/IDENTITY_SECRET_FILE/);
  });

  it("encrypts identity fields with field and user binding", () => {
    const secret = Buffer.alloc(64, 7);
    const encrypted = encryptIdentityField("owner@example.com", "email", "user-1", secret);
    expect(encrypted).not.toContain("owner@example.com");
    expect(decryptIdentityField(encrypted, "email", "user-1", secret)).toBe("owner@example.com");
    expect(() => decryptIdentityField(encrypted, "display-name", "user-1", secret)).toThrow();
    expect(() => decryptIdentityField(encrypted, "email", "user-2", secret)).toThrow();
  });

  it("normalizes email blind indexes without storing the email", () => {
    const secret = Buffer.alloc(64, 7);
    const left = emailLookupHash("  Owner@Example.COM ", secret);
    expect(left).toBe(emailLookupHash("owner@example.com", secret));
    expect(left).not.toContain("owner");
  });

  it("binds encrypted authentication payloads to purpose and record", () => {
    const secret = Buffer.alloc(64, 9);
    const envelope = encryptAuthPayload('{"token":"secret"}', "email-payload", "message-1", secret);
    expect(envelope).not.toContain("secret");
    expect(decryptAuthPayload(envelope, "email-payload", "message-1", secret)).toBe('{"token":"secret"}');
    expect(() => decryptAuthPayload(envelope, "totp-secret", "message-1", secret)).toThrow();
    expect(() => decryptAuthPayload(envelope, "email-payload", "message-2", secret)).toThrow();
  });

  it("hashes and verifies passwords with scrypt", async () => {
    const encoded = await hashPassword("a sufficiently long password");
    expect(encoded).not.toContain("sufficiently");
    await expect(verifyPassword("a sufficiently long password", encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", encoded)).resolves.toBe(false);
    await expect(verifyPassword("anything", "not-a-valid-hash")).resolves.toBe(false);
    await expect(consumeDummyPasswordCheck("unknown-user-password")).resolves.toBeUndefined();
  });
});

describe("TOTP and recovery delivery", () => {
  it("matches RFC 6238 vectors and accepts only the configured time window", () => {
    const secret = encodeBase32(Buffer.from("12345678901234567890", "ascii"));
    expect(decodeBase32(secret).toString("ascii")).toBe("12345678901234567890");
    expect(totpCode(secret, 1, 8)).toBe("94287082");
    expect(totpCode(secret, 1)).toBe("287082");
    expect(verifyTotp(secret, "287082", 59_000)).toBe(1);
    expect(verifyTotp(secret, "287082", 150_000, 0)).toBeNull();
  });

  it("loads production provider credentials only from a mounted secret file", () => {
    expect(loadEmailDeliveryMetadata({
      AUTH_EMAIL_DELIVERY_ENABLED: "true", AUTH_EMAIL_PROVIDER: "resend",
      AUTH_EMAIL_FROM: "Business Finlynq <security@finlynq.com>",
    })).toMatchObject({ provider: "resend", from: "Business Finlynq <security@finlynq.com>" });
    const configuration = loadEmailDeliveryConfiguration({
      NODE_ENV: "production", AUTH_EMAIL_DELIVERY_ENABLED: "true", AUTH_EMAIL_PROVIDER: "resend",
      RESEND_API_KEY_FILE: "/run/secrets/resend", AUTH_EMAIL_FROM: "Business Finlynq <security@finlynq.com>",
    }, () => "re_test_key\n");
    expect(configuration.apiKey).toBe("re_test_key");
    expect(() => loadEmailDeliveryConfiguration({
      NODE_ENV: "production", AUTH_EMAIL_DELIVERY_ENABLED: "true", AUTH_EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_inline", AUTH_EMAIL_FROM: "security@finlynq.com",
    })).toThrow(/RESEND_API_KEY_FILE/);
    expect(() => loadEmailDeliveryConfiguration({
      NODE_ENV: "production", AUTH_EMAIL_DELIVERY_ENABLED: "false", AUTH_EMAIL_PROVIDER: "resend",
      RESEND_API_KEY_FILE: "/run/secrets/resend", AUTH_EMAIL_FROM: "security@finlynq.com",
    }, () => "re_test_key")).toThrow(/disabled/);
  });

  it("sends with provider idempotency and classifies retryable failures", async () => {
    const configuration = { provider: "resend" as const, apiKey: "re_test", from: "security@finlynq.com" };
    const successFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("business-finlynq/message-1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer re_test");
      return Response.json({ id: "provider-id" });
    };
    await expect(sendEmail({ recipient: "user@example.com", subject: "Subject", html: "<p>Text</p>", text: "Text", idempotencyKey: "business-finlynq/message-1" }, configuration, successFetch as typeof fetch)).resolves.toBe("provider-id");
    const limitedFetch = async () => new Response("limited", { status: 429 });
    await expect(sendEmail({ recipient: "user@example.com", subject: "Subject", html: "<p>Text</p>", text: "Text", idempotencyKey: "key" }, configuration, limitedFetch as typeof fetch))
      .rejects.toMatchObject({ code: "provider_http_429", retryable: true });
  });

  it("keeps reset tokens in URL fragments and pads generic responses", async () => {
    const previousOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = "https://business.finlynq.com";
    const rendered = renderAuthenticationEmail({ templateType: "PASSWORD_RESET", payload: { token: "raw-token" }, templateData: { policy: "TOTP" } });
    expect(rendered.text).toContain("/reset-password#token=raw-token");
    expect(rendered.text).not.toContain("?token=");
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin;

    const waits: number[] = [];
    await settleSensitiveResponse(1_000, { minimumMs: 400, jitterMs: 20, now: () => 1_125, wait: async (milliseconds) => { waits.push(milliseconds); } });
    expect(waits).toEqual([295]);
  });
});

describe("session and demo navigation controls", () => {
  it("allows production HTTP only for an explicitly marked loopback Playwright server", () => {
    expect(() => configuredAppOrigin({
      NODE_ENV: "production",
      APP_ORIGIN: "http://127.0.0.1:3000",
    })).toThrow(/must use HTTPS/);
    expect(() => configuredAppOrigin({
      NODE_ENV: "production",
      APP_ORIGIN: "http://127.0.0.1:3000",
      ALLOW_INSECURE_TEST_ORIGIN: "true",
    })).toThrow(/must use HTTPS/);
    expect(configuredAppOrigin({
      NODE_ENV: "production",
      APP_ORIGIN: "http://localhost:3000",
      ALLOW_INSECURE_TEST_ORIGIN: "true",
      BUSINESS_FINLYNQ_TEST_CONTEXT: "playwright",
    }).origin).toBe("http://localhost:3000");
    expect(() => configuredAppOrigin({
      NODE_ENV: "production",
      APP_ORIGIN: "http://business.finlynq.com",
      ALLOW_INSECURE_TEST_ORIGIN: "true",
      BUSINESS_FINLYNQ_TEST_CONTEXT: "playwright",
    })).toThrow(/must use HTTPS/);
    expect(() => configuredAppOrigin({
      NODE_ENV: "production",
      APP_ORIGIN: "http://192.0.2.10:3000",
      ALLOW_INSECURE_TEST_ORIGIN: "true",
      BUSINESS_FINLYNQ_TEST_CONTEXT: "playwright",
    })).toThrow(/must use HTTPS/);
  });

  it("creates random opaque tokens and stores only deterministic digests", () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();
    expect(first.raw).not.toBe(second.raw);
    expect(first.hash).toBe(hashOpaqueToken(first.raw));
    expect(first.hash).not.toContain(first.raw);
    expect(first.raw.length).toBeGreaterThanOrEqual(40);
  });

  it("accepts only internal workspace return paths", () => {
    expect(safeAppPath("/app/journals?status=open#top")).toBe("/app/journals?status=open#top");
    expect(safeAppPath("https://evil.example/app")).toBe("/app");
    expect(safeAppPath("//evil.example/app")).toBe("/app");
    expect(safeAppPath("/app\\evil")).toBe("/app");
    expect(safeAppPath("/application")).toBe("/app");
    expect(safeAppPath("/login")).toBe("/app");
  });

  it("rejects framework and browser speculative demo navigation", () => {
    expect(isSpeculativeNavigation(new NextRequest("https://business.finlynq.com/try-demo", { headers: { "next-router-prefetch": "1" } }))).toBe(true);
    expect(isSpeculativeNavigation(new NextRequest("https://business.finlynq.com/try-demo", { headers: { "sec-purpose": "prefetch;prerender" } }))).toBe(true);
    expect(isSpeculativeNavigation(new NextRequest("https://business.finlynq.com/try-demo", { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }))).toBe(false);
  });

  it("sets a host-only hardened production cookie", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousName = process.env.SESSION_COOKIE_NAME;
    Object.assign(process.env, { NODE_ENV: "production", SESSION_COOKIE_NAME: "__Host-business_finlynq_session" });
    const response = NextResponse.json({ ok: true });
    setSessionCookie(response, "opaque-token", 3600);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-business_finlynq_session=opaque-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Object.assign(process.env, { NODE_ENV: previousNodeEnv });
    if (previousName === undefined) delete process.env.SESSION_COOKIE_NAME;
    else process.env.SESSION_COOKIE_NAME = previousName;
  });

  it("reports MFA transaction provenance only inside the live step-up window", () => {
    const principal: SessionPrincipal = {
      sessionId: "session", userId: "user", organizationId: "organization", membershipId: "membership",
      organizationName: "Organization", roleLabel: "Owner", displayName: "Owner", initials: "O",
      sessionMode: "real", authMethod: "PASSWORD", expiresAt: new Date(20_000),
      mfaVerifiedAt: new Date(1_000), stepUpExpiresAt: new Date(10_000),
    };
    expect(transactionAuthMethod(principal, 9_999)).toBe("password+mfa");
    expect(transactionAuthMethod(principal, 10_000)).toBe("password");
    expect(transactionAuthMethod({ ...principal, sessionMode: "demo", authMethod: "DEMO_LINK" }, 1)).toBe("demo-link+mfa");
    expect(transactionAuthMethod({ ...principal, sessionMode: "demo", authMethod: "DEMO_LINK" }, 10_000)).toBe("demo-link");
  });
});
