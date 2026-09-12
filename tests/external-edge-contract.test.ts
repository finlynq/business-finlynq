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
const releaseRouter = read("deploy/release/router/Caddyfile");
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

const checkCacheControl = (headers: Buffer) =>
  spawnSync(
    bashExecutable ?? "/bin/bash",
    [
      "-c",
      `
set -Eeuo pipefail
${extractShellFunction(verifier, "cache_control_is_safe_no_store")}
cache_control_is_safe_no_store "$FIXTURE_HEADERS"
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FIXTURE_HEADERS: headers.toString("utf8"),
      },
    },
  );

const resolveDevelopmentPublicContract = (
  durableMode: "active" | "maintenance",
  allowMaintenance: boolean,
  expectLiveUncommitted: boolean,
) =>
  spawnSync(
    bashExecutable ?? "/bin/bash",
    [
      "-c",
      `
set -Eeuo pipefail
fail() { printf '%s\n' "$*" >&2; exit 1; }
${extractShellFunction(verifier, "resolve_development_public_contract")}
allow_development_router_maintenance="$ALLOW_MAINTENANCE"
expect_development_live_uncommitted="$EXPECT_LIVE_UNCOMMITTED"
resolve_development_public_contract "$DURABLE_MODE"
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ALLOW_MAINTENANCE: String(allowMaintenance),
        EXPECT_LIVE_UNCOMMITTED: String(expectLiveUncommitted),
        DURABLE_MODE: durableMode,
      },
    },
  );

const resolveProductionPublicContract = (
  durableMode: "active" | "maintenance",
  allowMaintenance: boolean,
  allowForwardRepair: boolean,
  expectLiveUncommitted: boolean,
) =>
  spawnSync(
    bashExecutable ?? "/bin/bash",
    [
      "-c",
      `
set -Eeuo pipefail
fail() { printf '%s\n' "$*" >&2; exit 1; }
${extractShellFunction(verifier, "resolve_production_public_contract")}
allow_production_router_maintenance="$ALLOW_MAINTENANCE"
allow_first_router_forward_repair="$ALLOW_FORWARD_REPAIR"
expect_production_live_uncommitted="$EXPECT_LIVE_UNCOMMITTED"
resolve_production_public_contract "$DURABLE_MODE"
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ALLOW_MAINTENANCE: String(allowMaintenance),
        ALLOW_FORWARD_REPAIR: String(allowForwardRepair),
        EXPECT_LIVE_UNCOMMITTED: String(expectLiveUncommitted),
        DURABLE_MODE: durableMode,
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

  it("maps only the explicit production deployment boundary to its live route", () => {
    const maintenance = resolveProductionPublicContract("maintenance", true, false, false);
    expect(maintenance.status, maintenance.stderr).toBe(0);
    expect(maintenance.stdout).toBe("maintenance");

    const forwardRepair = resolveProductionPublicContract("maintenance", false, true, false);
    expect(forwardRepair.status, forwardRepair.stderr).toBe(0);
    expect(forwardRepair.stdout).toBe("maintenance");

    const forwardRepairWithoutMaintenance = resolveProductionPublicContract(
      "active",
      false,
      true,
      false,
    );
    expect(forwardRepairWithoutMaintenance.status).not.toBe(0);
    expect(forwardRepairWithoutMaintenance.stderr).toContain(
      "forward-repair verification requires durable maintenance mode",
    );

    const transition = resolveProductionPublicContract("maintenance", false, false, true);
    expect(transition.status, transition.stderr).toBe(0);
    expect(transition.stdout).toBe("active");

    const alreadyCommitted = resolveProductionPublicContract("active", false, false, true);
    expect(alreadyCommitted.status).not.toBe(0);
    expect(alreadyCommitted.stderr).toContain("requires durable maintenance mode");

    const ambiguous = resolveProductionPublicContract("maintenance", true, false, true);
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain("flags are ambiguous");

    expect(release.match(/--expect-production-live-uncommitted/gu)).toHaveLength(1);
    expect(rollback.match(/--expect-production-live-uncommitted/gu)).toHaveLength(1);
    expect(verifier).toContain(
      'production_public_contract="$(resolve_production_public_contract "$production_mode")"',
    );
  });

  it("binds forward-repair edge verification to the exact protected journal and stopped anchor", () => {
    expect(verifier).toContain(
      'readonly first_router_recovery_journal="$release_recovery_state_directory/first-router-pre-cutover.json"',
    );
    expect(verifier).toContain(
      '"$(stat -c \'%u:%g:%a:%h\' -- "$first_router_recovery_journal")"',
    );
    expect(verifier).toContain(
      'actual_digest="$(sha256sum -- "$first_router_recovery_journal")"',
    );
    expect(verifier).toContain(
      'actual_digest" == "$first_router_forward_repair_journal_sha256',
    );
    expect(verifier).toContain('.phase == "forward-repair-required"');
    expect(verifier).toContain('.databaseMutationStarted == true');
    expect(verifier).toContain('.candidateRevision == $candidateRevision');
    expect(verifier).toContain('docker ps --all --quiet --no-trunc');
    expect(verifier).toContain('.[0].State.Running == false');
    expect(verifier).toContain('readonly production_private_app_alias="release-app"');
    expect(verifier).toContain(
      '"${FIRST_ROUTER_FORWARD_REPAIR_ACK:-}"',
    );
    expect(verifier).toContain(
      '"forward-repair:$expected_production_revision:$first_router_forward_repair_journal_sha256"',
    );
    expect(release).toContain(
      'export FIRST_ROUTER_FORWARD_REPAIR_ACK="forward-repair:$journal_candidate_revision:$first_router_recovery_journal_sha256"',
    );
    expect(release).toContain(
      '--allow-first-router-forward-repair "$first_router_recovery_journal_sha256"',
    );
  });

  it("keeps durable development maintenance mapped to the public 503 contract", () => {
    const result = resolveDevelopmentPublicContract("maintenance", true, false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("maintenance");
    expect(verifier).toContain(
      'maintenance) public_maintenance_contract_is_valid "$development_hostname"',
    );
  });

  it("allows only the deployment boundary to verify live routes before durable commit", () => {
    const transition = resolveDevelopmentPublicContract("maintenance", false, true);
    expect(transition.status, transition.stderr).toBe(0);
    expect(transition.stdout).toBe("active");

    const alreadyCommitted = resolveDevelopmentPublicContract("active", false, true);
    expect(alreadyCommitted.status).not.toBe(0);
    expect(alreadyCommitted.stderr).toContain("requires durable maintenance mode");

    const ambiguous = resolveDevelopmentPublicContract("maintenance", true, true);
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain("flags are ambiguous");
    expect(verifier).toContain(
      'if [[ "$router_mode" == active || "$expect_live_uncommitted" == true ]]',
    );
    expect(verifier).toContain('.status == "ready" and .revision == $revision');
    expect(developmentDeployer.match(/--expect-development-live-uncommitted/gu)).toHaveLength(1);
    expect(
      developmentDeployer.match(
        /verify_external_edge_if_selected "\$[a-z_]+" live-uncommitted/gu,
      ),
    ).toHaveLength(3);
    expect(developmentDeployer).toContain(
      'verify_external_edge_if_selected "$candidate_revision"\n  elif',
    );
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

  it("accepts the actual router Cache-Control response with real CRLF bytes", () => {
    const routerCacheControl = releaseRouter.match(/Cache-Control "([^"]+)"/u)?.[1];
    expect(routerCacheControl).toBe("no-store, max-age=0");
    const actualRouterResponse = Buffer.from(
      [
        "HTTP/2 200",
        `Cache-Control: ${routerCacheControl}`,
        "Content-Type: application/json; charset=utf-8",
        "",
        "",
      ].join("\r\n"),
      "utf8",
    );

    expect(checkCacheControl(actualRouterResponse).status).toBe(0);
    expect(actualRouterResponse.includes(0x0d)).toBe(true);
    expect(actualRouterResponse.includes(0x0a)).toBe(true);
  });

  it("rejects unsafe or ambiguous Cache-Control directives with real CRLF bytes", () => {
    const response = (...fields: string[]) =>
      Buffer.from(["HTTP/2 200", ...fields, "", ""].join("\r\n"), "utf8");

    expect(checkCacheControl(response("Cache-Control: No-Store, MAX-AGE=0")).status).toBe(0);
    expect(checkCacheControl(response()).status).not.toBe(0);
    expect(
      checkCacheControl(
        response("Cache-Control: no-store", "Cache-Control: max-age=0"),
      ).status,
    ).not.toBe(0);
    for (const value of [
      "no-store, no-store",
      "no-store=1",
      "no-store,, max-age=0",
      "no-store, public",
      "no-store, s-maxage=0",
      "no-store, max-age=1",
    ]) {
      expect(checkCacheControl(response(`Cache-Control: ${value}`)).status).not.toBe(0);
    }
  });

  it("does not use grep's backslash-r escape as a carriage-return check", () => {
    for (const source of [verifier, productionMonitor, observabilityDrill]) {
      expect(source).not.toMatch(/grep[^\n]*\\r/u);
      expect(source).toContain('sprintf("%c", 13)');
    }
  });
});
