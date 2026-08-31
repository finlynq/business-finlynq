import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("request-scoped content security policy", () => {
  it("adds a fresh nonce without allowing arbitrary inline scripts", () => {
    vi.stubEnv("NODE_ENV", "production");
    const first = proxy(new NextRequest("https://business.finlynq.com/signup"));
    const second = proxy(new NextRequest("https://business.finlynq.com/signup"));
    const firstPolicy = first.headers.get("content-security-policy");
    const secondPolicy = second.headers.get("content-security-policy");

    expect(firstPolicy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(firstPolicy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(firstPolicy).toContain("upgrade-insecure-requests");
    expect(secondPolicy).not.toBe(firstPolicy);
  });

  it("keeps workspace authentication redirects under the same policy", () => {
    const response = proxy(new NextRequest("https://business.finlynq.com/app/journals?state=draft"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://business.finlynq.com/login?next=%2Fapp%2Fjournals%3Fstate%3Ddraft",
    );
    expect(response.headers.get("content-security-policy")).toContain("'nonce-");
  });

  it("runs on HTML pages while excluding API and immutable asset routes", () => {
    expect(config.matcher).toEqual([
      "/((?!api|_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)",
    ]);
  });

  it("passes the request nonce to the third-party Turnstile script", () => {
    const signupPage = readFileSync(
      join(process.cwd(), "src", "app", "(auth)", "signup", "page.tsx"),
      "utf8",
    );
    const signupForm = readFileSync(
      join(process.cwd(), "src", "app", "(auth)", "_components", "signup-form.client.tsx"),
      "utf8",
    );

    expect(signupPage).toContain('(await headers()).get("x-nonce")');
    expect(signupPage).toContain("<SignupForm challenge={challenge} nonce={nonce} />");
    expect(signupForm).toContain("nonce={nonce}");
  });
});
