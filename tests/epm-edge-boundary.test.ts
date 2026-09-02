import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");
const containerCaddy = readFileSync("deploy/Caddyfile.container", "utf8");
const caddyfiles = [
  containerCaddy,
  readFileSync("deploy/Caddyfile.example", "utf8"),
];

describe("shared edge isolation", () => {
  it("uses the unique production alias and attaches Caddy to the external EPM network", () => {
    expect(containerCaddy).toContain("reverse_proxy production-app:3000");
    expect(containerCaddy).not.toMatch(/reverse_proxy\s+app:3000/u);
    expect(compose).toMatch(/edge:[\s\S]*?networks:[\s\S]*?- epm_finlynq_edge/u);
    expect(compose).toMatch(/epm_finlynq_edge:\s*\n\s*name: epm_finlynq_edge\s*\n\s*external: true/u);
    expect(compose).toContain("/home/deploy/epm-finlynq/secrets/external-basic-auth.caddy:/etc/caddy/epm-basic-auth:ro");
  });

  it.each(caddyfiles)("protects the EPM console while preserving bearer API routing", (caddyfile) => {
    expect(caddyfile).toContain("epm.finlynq.com");
    expect(caddyfile).toMatch(/@planning_agent_api\s+path \/v1\/\*/u);
    expect(caddyfile).toMatch(/reverse_proxy\s+(?:epm-finlynq-api|127\.0\.0\.1):7100/u);
    expect(caddyfile).toMatch(/basic_auth\s*\{\s*import \/etc\/caddy\/epm-basic-auth\s*\}/u);
    expect(caddyfile).toMatch(/reverse_proxy\s+(?:epm-finlynq-console|127\.0\.0\.1):7090[\s\S]*?header_up -Authorization/u);
    for (const header of ["X-Tenant-Id", "X-Principal-Id", "X-Planning-Principal-Id", "X-Policy", "X-Executor"]) {
      expect(caddyfile).toContain(`header_up -${header}`);
    }
  });
});
