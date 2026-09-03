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

  it("allows only the validated OAuth callback origin during consent", () => {
    const callback = "https://chatgpt.com/connector_platform_oauth_redirect?private=value";
    const response = proxy(new NextRequest(
      `https://business.finlynq.com/oauth/authorize?redirect_uri=${encodeURIComponent(callback)}`,
    ));
    const policy = response.headers.get("content-security-policy");

    expect(policy).toContain("form-action 'self' https://chatgpt.com");
    expect(policy).not.toContain("connector_platform_oauth_redirect");
    expect(policy).not.toContain("private=value");

    const unrelated = proxy(new NextRequest(
      `https://business.finlynq.com/login?redirect_uri=${encodeURIComponent(callback)}`,
    ));
    expect(unrelated.headers.get("content-security-policy")).toContain("form-action 'self';");
    expect(unrelated.headers.get("content-security-policy")).not.toContain("https://chatgpt.com");
  });

  it("does not add unsafe OAuth callback schemes to form-action", () => {
    const response = proxy(new NextRequest(
      "https://business.finlynq.com/oauth/authorize?redirect_uri=http%3A%2F%2Fexample.com%2Fcallback",
    ));

    expect(response.headers.get("content-security-policy")).toContain("form-action 'self';");
    expect(response.headers.get("content-security-policy")).not.toContain("http://example.com");
  });

  it("runs on HTML and API routes while excluding immutable asset routes", () => {
    expect(config.matcher).toEqual([
      "/((?!_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)",
    ]);
  });

  it("assigns and returns a UUID request ID for direct requests", () => {
    const request = new NextRequest("https://business.finlynq.com/api/live", {
      headers: { "X-Request-Id": "not-a-uuid" },
    });
    const response = proxy(request);

    expect(response.headers.get("X-Request-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("forces the public Caddy edge to replace correlation and internal markers", () => {
    for (const path of ["deploy/Caddyfile.container", "deploy/Caddyfile.example"]) {
      const caddyfile = readFileSync(join(process.cwd(), path), "utf8");
      expect(caddyfile).toContain("header_up -X-Request-Id");
      expect(caddyfile).toContain("header_up X-Request-Id {http.request.uuid}");
      expect(caddyfile).toContain('X-Request-Id "{http.request.uuid}"');
      expect(caddyfile).toContain("log_append request_id {http.request.uuid}");
      expect(caddyfile).toContain("header_up -X-Business-Finlynq-Internal-Metrics");
    }
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
