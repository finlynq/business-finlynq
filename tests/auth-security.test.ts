import { describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { consumeDummyPasswordCheck, hashPassword, verifyPassword } from "@/modules/identity/passwords";
import { isSpeculativeNavigation } from "@/modules/identity/request-security";
import { safeAppPath } from "@/modules/identity/safe-redirect";
import { createOpaqueToken, hashOpaqueToken, setSessionCookie } from "@/modules/identity/session";
import {
  decryptIdentityField,
  emailLookupHash,
  encryptIdentityField,
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

  it("hashes and verifies passwords with scrypt", async () => {
    const encoded = await hashPassword("a sufficiently long password");
    expect(encoded).not.toContain("sufficiently");
    await expect(verifyPassword("a sufficiently long password", encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", encoded)).resolves.toBe(false);
    await expect(verifyPassword("anything", "not-a-valid-hash")).resolves.toBe(false);
    await expect(consumeDummyPasswordCheck("unknown-user-password")).resolves.toBeUndefined();
  });
});

describe("session and demo navigation controls", () => {
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
});
