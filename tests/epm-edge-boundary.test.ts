import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");
const containerCaddy = readFileSync("deploy/Caddyfile.container", "utf8");
const hostCaddy = readFileSync("deploy/Caddyfile.example", "utf8");
const caddyfiles = [containerCaddy, hostCaddy];

describe("shared edge isolation", () => {
  it("uses the unique production alias and attaches Caddy to the external EPM network", () => {
    expect(containerCaddy).toContain("reverse_proxy production-app:3000");
    expect(containerCaddy).not.toMatch(/reverse_proxy\s+app:3000/u);
    expect(compose).toMatch(/edge:[\s\S]*?networks:[\s\S]*?- epm_finlynq_edge/u);
    expect(compose).toMatch(/epm_finlynq_edge:\s*\n\s*name: epm_finlynq_edge\s*\n\s*external: true/u);
    expect(compose).not.toContain("epm-basic-auth");
  });

  it.each(caddyfiles)("delegates console authentication to OIDC while preserving bearer API routing", (caddyfile) => {
    expect(caddyfile).toContain("epm.finlynq.com");
    expect(caddyfile).toMatch(/@planning_agent_api\s+path \/v1\/\*/u);
    expect(caddyfile).toMatch(/reverse_proxy\s+(?:epm-finlynq-api|127\.0\.0\.1):7100/u);
    expect(caddyfile).toMatch(/reverse_proxy\s+(?:epm-finlynq-api|127\.0\.0\.1):7100[\s\S]*?header_up -Cookie/u);
    expect(caddyfile).toMatch(/reverse_proxy\s+(?:epm-finlynq-api|127\.0\.0\.1):7100[\s\S]*?header_up -Proxy-Authorization/u);
    expect(caddyfile).toMatch(/reverse_proxy\s+(?:epm-finlynq-api|127\.0\.0\.1):7100[\s\S]*?header_down -Set-Cookie/u);
    expect(caddyfile).not.toMatch(/basic_auth|epm-basic-auth/u);
    expect(caddyfile).toMatch(/reverse_proxy\s+(?:epm-finlynq-console|127\.0\.0\.1):7090[\s\S]*?header_up -Authorization/u);
    expect(caddyfile).toContain('Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()"');
    for (const header of ["X-Tenant-Id", "X-Principal-Id", "X-Planning-Principal-Id", "X-Policy", "X-Executor"]) {
      expect(caddyfile).toContain(`header_up -${header}`);
    }
  });

  it.each(caddyfiles)("omits EPM OIDC callbacks from access logs, including sensitive query values", (caddyfile) => {
    const epmSite = caddyfile.slice(caddyfile.indexOf("epm.finlynq.com"));
    const callbackWithSecrets = new URL(
      "https://epm.finlynq.com/auth/callback?code=private-code&state=private-state",
    );

    expect(epmSite).toMatch(new RegExp(`\\n\\s*log_skip ${callbackWithSecrets.pathname}\\s*\\n\\s*log\\s*\\{`, "u"));
  });

  it("does not retain the retired EPM password include in either edge variant", () => {
    expect(containerCaddy).not.toContain("epm-basic-auth");
    expect(hostCaddy).not.toContain("epm-basic-auth");
  });
});
