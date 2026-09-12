import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const compose = read("docker-compose.yml");
const verifier = read("deploy/edge/verify-external-edge.sh");
const reconciler = read("deploy/edge/reconcile-shared-edge.sh");
const developmentDeployer = read("deploy/development/deploy-development.sh");
const developmentInstaller = read("deploy/development/install-development.sh");
const productionInstaller = read("deploy/production/install-initial-production.sh");
const release = read("deploy/release/run-release.sh");
const rollback = read("deploy/release/run-application-rollback.sh");
const continuousDeployment = read("deploy/continuous-deployment/deploy-main.sh");
const productionMonitor = read("deploy/monitoring/check-production.sh");
const observabilityDrill = read("deploy/monitoring/run-observability-drill.sh");
const boundaryReadme = read("deploy/edge/README.md");
const legacyReconciler = read("deploy/edge/legacy/reconcile-shared-edge-v0.sh");
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const bashExecutable =
  process.platform === "win32" ? (existsSync(gitBash) ? gitBash : null) : "/bin/bash";

const extractShellFunction = (source: string, name: string) => {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`missing shell function: ${name}`);
  const end = source.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`unterminated shell function: ${name}`);
  return source.slice(start, end + 3);
};

const checkHeader = (headers: Buffer, name: string, value: string) =>
  spawnSync(
    bashExecutable ?? "/bin/bash",
    [
      "-c",
      `
set -Eeuo pipefail
${extractShellFunction(verifier, "header_value_is_exact")}
header_value_is_exact "$FIXTURE_HEADERS" "$HEADER_NAME" "$HEADER_VALUE"
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FIXTURE_HEADERS: headers.toString("utf8"),
        HEADER_NAME: name,
        HEADER_VALUE: value,
      },
    },
  );

describe("shared-edge contract v1 ownership", () => {
  it("removes public Caddy, public ports, and shared Caddy volumes from application Compose", () => {
    expect(compose).not.toMatch(/^  edge:\s*$/mu);
    expect(compose).not.toContain('"80:80"');
    expect(compose).not.toContain('"443:443"');
    expect(compose).not.toContain("business_finlynq_caddy_data:");
    expect(compose).not.toContain("business_finlynq_caddy_config:");
    expect(compose).not.toContain("deploy/Caddyfile.container");
    expect(compose).toMatch(
      /business_finlynq_edge:\s*\n\s*name: \$\{BUSINESS_FINLYNQ_EDGE_NETWORK:-business_finlynq_edge\}\s*\n\s*external: true/u,
    );
  });

  it("preserves the exact Business upstream aliases and ports", () => {
    expect(compose).toContain("BUSINESS_FINLYNQ_APP_NETWORK_ALIAS:-production-app");
    expect(compose).toContain('"127.0.0.1:${BUSINESS_FINLYNQ_APP_PORT:-3100}:3000"');
    expect(developmentInstaller).toContain("BUSINESS_FINLYNQ_APP_NETWORK_ALIAS=development-app");
    expect(developmentInstaller).toContain("BUSINESS_FINLYNQ_APP_PORT=3200");
    expect(verifier).toContain('readonly production_network="business_finlynq_edge"');
    expect(verifier).toContain('readonly development_network="business_finlynq_development_edge"');
    expect(verifier).toContain('readonly production_alias="production-app"');
    expect(verifier).toContain('readonly development_alias="development-app"');
  });

  it("recognizes only the central runtime identity and contract-v1 labels", () => {
    expect(verifier).toContain('readonly central_project="finlynq-shared-edge"');
    expect(verifier).toContain('readonly central_container_name="finlynq-shared-edge-edge-1"');
    expect(verifier).toContain('com.finlynq.edge-owner');
    expect(verifier).toContain('com.finlynq.edge-contract');
    expect(verifier).not.toContain("epm-finlynq-edge-1");
    expect(verifier).not.toContain('com.business-finlynq.edge-owner');
    expect(verifier).not.toContain("expected_full_edge_networks");
  });

  it("keeps verification read-only and free of route, mount, config, and log ownership", () => {
    for (const forbidden of [
      "caddy reload",
      "docker compose up",
      "docker compose down",
      "docker restart",
      "docker rm",
      "business-finlynq-routes.caddy",
      ".Mounts",
      "docker logs",
      "/etc/caddy/Caddyfile",
      "ACTIVE_CONFIG_SHA256",
    ]) {
      expect(verifier).not.toContain(forbidden);
      expect(reconciler).not.toContain(forbidden);
    }
    expect(reconciler).toContain("verify-external-edge.sh");
    expect(continuousDeployment).not.toContain("reconcile-shared-edge.sh");
    expect(continuousDeployment.match(/verify-external-edge\.sh/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps application deployment and rollback off the legacy edge overlay", () => {
    for (const source of [developmentDeployer, productionInstaller, release, rollback]) {
      expect(source).not.toContain("deploy/edge/docker-compose.external.yml");
      expect(source).not.toContain("Caddyfile.business-external");
    }
    expect(developmentInstaller).not.toContain("docker network create");
    expect(productionInstaller).not.toContain("docker network create");
    expect(productionInstaller).not.toContain("business-finlynq-routes.caddy");
    expect(productionInstaller).not.toContain("BUSINESS_FINLYNQ_CADDY_DATA_VOLUME");
    expect(productionInstaller).not.toContain("BUSINESS_FINLYNQ_CADDY_CONFIG_VOLUME");
  });

  it("documents unchanged rollback-only legacy input outside active paths", () => {
    expect(boundaryReadme).toContain("retained unchanged as rollback input");
    expect(boundaryReadme.replace(/\s+/gu, " ")).toContain(
      "not referenced by current application deployment or rollback paths",
    );
    expect(legacyReconciler).toContain("caddy validate");
    expect(legacyReconciler).toContain(
      "compose_timed 3m --profile edge up --detach --no-deps --no-build",
    );
    expect(legacyReconciler).toContain("--wait --wait-timeout 120 edge");
  });

  it("accepts exact headers framed with real CRLF bytes", () => {
    const crlfHeaders = Buffer.from(
      [
        "HTTP/2 302",
        "Location: https://business.finlynq.com/app",
        "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
        "",
        "",
      ].join("\r\n"),
      "utf8",
    );
    expect(checkHeader(crlfHeaders, "location", "https://business.finlynq.com/app").status).toBe(0);
    expect(
      checkHeader(
        crlfHeaders,
        "permissions-policy",
        "camera=(), microphone=(), geolocation=(), payment=()",
      ).status,
    ).toBe(0);
    expect(crlfHeaders.includes(0x0d)).toBe(true);
    expect(crlfHeaders.includes(0x0a)).toBe(true);
  });

  it("rejects duplicate or altered CRLF-framed headers", () => {
    const duplicated = Buffer.from(
      ["Location: /app", "Location: /app", "", ""].join("\r\n"),
      "utf8",
    );
    const altered = Buffer.from(["Location: https://attacker.example/", "", ""].join("\r\n"));
    expect(checkHeader(duplicated, "location", "/app").status).not.toBe(0);
    expect(checkHeader(altered, "location", "/app").status).not.toBe(0);
  });

  it("does not use grep's backslash-r escape as a carriage-return check", () => {
    for (const source of [verifier, productionMonitor, observabilityDrill]) {
      expect(source).not.toMatch(/grep[^\n]*\\r/u);
      expect(source).toContain('sprintf("%c", 13)');
    }
  });
});
