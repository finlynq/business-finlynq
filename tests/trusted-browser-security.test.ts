import { NextRequest, NextResponse } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTrustedBrowserCookie,
  isPlausibleTrustedBrowserToken,
  setTrustedBrowserCookie,
  trustedBrowserCookieName,
  trustedBrowserLabel,
} from "@/modules/identity/trusted-browser";

const previousNodeEnvironment = process.env.NODE_ENV;

afterEach(() => {
  if (previousNodeEnvironment === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
  else Object.assign(process.env, { NODE_ENV: previousNodeEnvironment });
});

describe("trusted-browser cookie boundary", () => {
  it("accepts only the exact 32-byte base64url token shape", () => {
    expect(isPlausibleTrustedBrowserToken("a".repeat(43))).toBe(true);
    expect(isPlausibleTrustedBrowserToken("a".repeat(42))).toBe(false);
    expect(isPlausibleTrustedBrowserToken("a".repeat(44))).toBe(false);
    expect(isPlausibleTrustedBrowserToken("a".repeat(42) + "=")).toBe(false);
    expect(isPlausibleTrustedBrowserToken("a".repeat(42) + ".")).toBe(false);
    expect(isPlausibleTrustedBrowserToken(undefined)).toBe(false);
  });

  it("uses a host-only hardened production cookie and an exact expiry", () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    const response = NextResponse.json({ ok: true });
    const now = Date.parse("2026-09-05T00:00:00Z");
    const expiresAt = new Date("2026-10-05T00:00:00Z");

    setTrustedBrowserCookie(response, "a".repeat(43), expiresAt, now);

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(trustedBrowserCookieName()).toBe("__Host-business_finlynq_trusted_browser");
    expect(cookie).toContain("__Host-business_finlynq_trusted_browser=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).not.toContain("Domain=");
  });

  it("clears the same hardened cookie after rejection or revocation", () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    const response = NextResponse.json({ ok: true });
    clearTrustedBrowserCookie(response);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-business_finlynq_trusted_browser=");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });

  it("derives a bounded display-only label without retaining raw User-Agent text", () => {
    const request = new NextRequest("https://business.finlynq.com/login", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
      },
    });
    expect(trustedBrowserLabel(request.headers.get("user-agent"))).toBe("Chrome on Windows");
    expect(trustedBrowserLabel("Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15")).toBe("Safari on macOS");
    expect(trustedBrowserLabel(null)).toBe("Browser on unknown device");
  });
});
