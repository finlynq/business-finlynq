import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");
const caddy = readFileSync("deploy/Caddyfile.container", "utf8");

describe("consult-finlynq shared edge", () => {
  it("attaches Caddy to the external consult network", () => {
    expect(compose).toMatch(
      /edge:[\s\S]*?networks:[\s\S]*?- consult_finlynq_edge/u,
    );
    expect(compose).toMatch(
      /consult_finlynq_edge:\s*\n\s*name: consult_finlynq_edge\s*\n\s*external: true/u,
    );
  });

  it("routes the consultation hostname to its unique application alias", () => {
    expect(caddy).toContain(
      "CONSULT_FINLYNQ_HOSTNAME:consult.finlynq.com",
    );
    expect(caddy).toContain("reverse_proxy consult-finlynq-app:8080");
    expect(caddy).toContain("Permissions-Policy");
  });
});
