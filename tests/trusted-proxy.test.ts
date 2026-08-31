import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { clientIp } from "@/modules/identity/request-security";

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest("https://business.finlynq.com/api/auth/login", { headers });
}

describe("trusted proxy request-IP boundary", () => {
  it("ignores forwarding headers when no proxy trust is configured", () => {
    expect(clientIp(request({
      "x-forwarded-for": "198.51.100.42",
      "x-real-ip": "203.0.113.17",
    }), {})).toBe("unknown");
    expect(clientIp(request({ "x-forwarded-for": "198.51.100.42" }), {
      TRUSTED_PROXY_HOPS: "0",
    })).toBe("unknown");
    expect(clientIp(request({ "x-real-ip": "203.0.113.17" }), {
      TRUSTED_PROXY_HOPS: "1",
    })).toBe("unknown");
  });

  it("selects the rightmost untrusted boundary instead of a spoofed leftmost value", () => {
    expect(clientIp(request({
      "x-forwarded-for": "192.0.2.250, 198.51.100.42",
    }), { TRUSTED_PROXY_HOPS: "1" })).toBe("198.51.100.42");
  });

  it("moves left only for each explicitly trusted appending proxy", () => {
    const forwarded = request({
      "x-forwarded-for": "192.0.2.250, 198.51.100.42, 203.0.113.17",
    });
    expect(clientIp(forwarded, { TRUSTED_PROXY_HOPS: "1" })).toBe("203.0.113.17");
    expect(clientIp(forwarded, { TRUSTED_PROXY_HOPS: "2" })).toBe("198.51.100.42");
  });

  it("fails safely for malformed, incomplete, or unsupported proxy settings", () => {
    expect(clientIp(request({ "x-forwarded-for": "198.51.100.42, not-an-ip" }), {
      TRUSTED_PROXY_HOPS: "1",
    })).toBe("unknown");
    expect(clientIp(request({ "x-forwarded-for": "198.51.100.42,,203.0.113.17" }), {
      TRUSTED_PROXY_HOPS: "1",
    })).toBe("unknown");
    expect(clientIp(request({ "x-forwarded-for": "198.51.100.42" }), {
      TRUSTED_PROXY_HOPS: "2",
    })).toBe("unknown");
    expect(clientIp(request({ "x-forwarded-for": "198.51.100.42" }), {
      TRUSTED_PROXY_HOPS: "01",
    })).toBe("unknown");
  });

  it("fails safely for overlong forwarding chains", () => {
    const tooManyAddresses = Array.from({ length: 17 }, (_, index) => `192.0.2.${index + 1}`).join(", ");
    expect(clientIp(request({ "x-forwarded-for": tooManyAddresses }), {
      TRUSTED_PROXY_HOPS: "1",
    })).toBe("unknown");
    expect(clientIp(request({ "x-forwarded-for": `198.51.100.42,${" ".repeat(1_025)}` }), {
      TRUSTED_PROXY_HOPS: "1",
    })).toBe("unknown");
  });

  it("keeps both reviewed Caddy deployments on one explicit trusted hop", () => {
    const root = process.cwd();
    const environmentExample = readFileSync(join(root, ".env.example"), "utf8");
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
    const deploymentGuide = readFileSync(join(root, "docs/deployment/vps.md"), "utf8");
    const caddyfiles = ["deploy/Caddyfile.container", "deploy/Caddyfile.example"]
      .map((path) => readFileSync(join(root, path), "utf8"));

    expect(environmentExample).toMatch(/^TRUSTED_PROXY_HOPS=0$/m);
    expect(compose).toContain("TRUSTED_PROXY_HOPS: ${TRUSTED_PROXY_HOPS:-0}");
    expect(deploymentGuide).toContain("set `TRUSTED_PROXY_HOPS=1` for either reviewed Caddy arrangement");
    expect(deploymentGuide).toContain("`X-Real-IP` is never a fallback");
    for (const caddyfile of caddyfiles) expect(caddyfile).toMatch(/reverse_proxy\s+\S+\s*\{/);
  });
});
