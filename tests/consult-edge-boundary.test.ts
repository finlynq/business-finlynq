import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");
const caddy = readFileSync("deploy/Caddyfile.container", "utf8");

describe("consult-finlynq shared edge", () => {
  it("does not own Caddy or the external Consult network", () => {
    expect(compose).not.toMatch(/^  edge:\s*$/mu);
    expect(compose).not.toContain("consult_finlynq_edge");
  });

  it("retains the legacy consultation route as rollback input", () => {
    expect(caddy).toContain(
      "CONSULT_FINLYNQ_HOSTNAME:consult.finlynq.com",
    );
    expect(caddy).toContain("reverse_proxy consult-finlynq-app:8080");
    expect(caddy).toContain("Permissions-Policy");
  });
});
