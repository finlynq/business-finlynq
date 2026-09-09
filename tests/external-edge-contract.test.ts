import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const overlay = read("deploy/edge/docker-compose.external.yml");
const routes = read("deploy/edge/Caddyfile.business-external");
const verifier = read("deploy/edge/verify-external-edge.sh");
const reconciler = read("deploy/edge/reconcile-shared-edge.sh");
const release = read("deploy/release/run-release.sh");
const rollback = read("deploy/release/run-application-rollback.sh");
const monitor = read("deploy/monitoring/check-production.sh");
const developmentInstaller = read("deploy/development/install-development.sh");
const developmentDeployer = read("deploy/development/deploy-development.sh");
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const bashExecutable =
  process.platform === "win32" ? (existsSync(gitBash) ? gitBash : null) : "/bin/bash";

const extractShellFunction = (source: string, name: string) => {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) {
    throw new Error(`missing shell function: ${name}`);
  }
  const end = source.indexOf("\n}\n", start);
  if (end < 0) {
    throw new Error(`unterminated shell function: ${name}`);
  }
  return source.slice(start, end + 3);
};

const publicLivenessFixture = (
  responses: string,
  options: { body?: string; omitHeader?: string } = {},
) =>
  spawnSync(
    bashExecutable ?? "/bin/bash",
    [
      "-c",
      `
set -Eeuo pipefail
public_warmup_attempts=3
public_warmup_retry_seconds=0
public_warmup_request_timeout_seconds=1
request_count_file="$(mktemp)"
headers="$(mktemp)"
body="$(mktemp)"
printf '0' >"$request_count_file"
trap 'rm -f -- "$request_count_file" "$headers" "$body"' EXIT
fail() {
  printf 'failure=%s\nrequests=%s\n' "$*" "$(<"$request_count_file")" >&2
  exit 1
}
sleep() { return 0; }
jq() {
  local input_path
  input_path="\${!#}"
  [[ "$(<"$input_path")" == '{"status":"live"}' ]]
}
curl() {
  local dump_header="" output_file="" request_count response
  local -a fixture_responses=()
  while (( $# > 0 )); do
    case "$1" in
      --dump-header) dump_header="$2"; shift 2 ;;
      --output) output_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  request_count="$(<"$request_count_file")"
  (( request_count += 1 ))
  printf '%s' "$request_count" >"$request_count_file"
  IFS=',' read -r -a fixture_responses <<<"$FIXTURE_RESPONSES"
  response="\${fixture_responses[request_count - 1]}"
  if [[ "$response" == transport ]]; then
    return 7
  fi
  {
    printf 'HTTP/2 %s\r\n' "$response"
    [[ "$FIXTURE_OMIT_HEADER" == cache-control ]] || printf 'cache-control: no-store\r\n'
    [[ "$FIXTURE_OMIT_HEADER" == strict-transport-security ]] \
      || printf 'strict-transport-security: max-age=31536000; includeSubDomains\r\n'
    [[ "$FIXTURE_OMIT_HEADER" == x-content-type-options ]] \
      || printf 'x-content-type-options: nosniff\r\n'
    [[ "$FIXTURE_OMIT_HEADER" == x-frame-options ]] || printf 'x-frame-options: DENY\r\n'
    [[ "$FIXTURE_OMIT_HEADER" == referrer-policy ]] \
      || printf 'referrer-policy: strict-origin-when-cross-origin\r\n'
    printf '\r\n'
  } >"$dump_header"
  printf '%s\n' "$FIXTURE_BODY" >"$output_file"
  printf '%s' "$response"
}
${extractShellFunction(verifier, "verify_security_headers")}
${extractShellFunction(verifier, "wait_for_public_liveness")}
${extractShellFunction(verifier, "verify_public_liveness_contract")}
verify_public_liveness_contract example.test 192.0.2.10 "$headers" "$body" 3
printf 'requests=%s\n' "$(<"$request_count_file")"
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FIXTURE_BODY: options.body ?? '{"status":"live"}',
        FIXTURE_OMIT_HEADER: options.omitHeader ?? "",
        FIXTURE_RESPONSES: responses,
      },
    },
  );

const publicMaintenanceFixture = (
  options: {
    status?: string;
    body?: string;
    retryAfter?: string;
    requestId?: string;
  } = {},
) =>
  spawnSync(
    bashExecutable ?? "/bin/bash",
    [
      "-c",
      `
set -Eeuo pipefail
temporary_files=()
warmup_host=none
production_hostname=example.test
public_warmup_attempts=3
headers="$(mktemp)"
trace="$(mktemp)"
trap 'rm -f -- "\${temporary_files[@]}" "$headers" "$trace"' EXIT
fail() { printf '%s\n' "$*" >&2; exit 1; }
verify_public_liveness_contract() { printf 'liveness\n' >>"$trace"; }
verify_security_headers() { printf 'security\n' >>"$trace"; }
http_redirect_is_exact() { printf 'redirect\n' >>"$trace"; }
tls_is_valid() { printf 'tls\n' >>"$trace"; }
jq() {
  local input_path
  input_path="\${!#}"
  [[ "$(<"$input_path")" == '{"status":"unavailable"}' ]]
}
curl() {
  local dump_header="" output_file=""
  while (( $# > 0 )); do
    case "$1" in
      --dump-header) dump_header="$2"; shift 2 ;;
      --output) output_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  {
    printf 'HTTP/2 %s\r\n' "$FIXTURE_STATUS"
    printf 'cache-control: no-store, max-age=0\r\n'
    [[ -z "$FIXTURE_RETRY_AFTER" ]] || printf 'retry-after: %s\r\n' "$FIXTURE_RETRY_AFTER"
    printf 'content-type: application/json; charset=utf-8\r\n'
    printf 'x-request-id: %s\r\n' "$FIXTURE_REQUEST_ID"
    printf '\r\n'
  } >"$dump_header"
  printf '%s\n' "$FIXTURE_BODY" >"$output_file"
  printf '%s' "$FIXTURE_STATUS"
}
${extractShellFunction(verifier, "public_maintenance_contract_is_valid")}
public_maintenance_contract_is_valid example.test 192.0.2.10 '${"a".repeat(64)}'
cat "$trace"
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FIXTURE_STATUS: options.status ?? "503",
        FIXTURE_BODY: options.body ?? '{"status":"unavailable"}',
        FIXTURE_RETRY_AFTER: options.retryAfter ?? "5",
        FIXTURE_REQUEST_ID:
          options.requestId ?? "123e4567-e89b-42d3-a456-426614174000",
      },
    },
  );

describe("externally managed edge contract", () => {
  it("makes the inherited edge profile incapable of owning a listener", () => {
    expect(overlay).toContain("profiles: !override [external-edge-disabled]");
    expect(overlay).toContain("ports: !reset []");
    expect(overlay).toContain("volumes: !reset []");
    expect(overlay).toContain("networks: !reset []");
    expect(overlay).toContain("network_mode: none");
    expect(overlay).toContain('entrypoint: ["/bin/false"]');
    expect(overlay).toMatch(/business_finlynq_edge:\s*\n\s*external: true/u);
  });

  it("publishes only the exact Business production and development routes", () => {
    expect(routes).toContain("business.finlynq.com {");
    expect(routes).toContain("dev.business.finlynq.com {");
    expect(routes).not.toContain("{$BUSINESS_FINLYNQ");
    expect(routes).toContain("reverse_proxy production-app:3000");
    expect(routes).toContain("reverse_proxy development-app:3000");
    expect(routes.match(/header_up -X-Business-Finlynq-Internal-Health/gu)).toHaveLength(2);
    expect(routes.match(/header_up -X-Business-Finlynq-Internal-Metrics/gu)).toHaveLength(2);
    expect(routes.match(/header_up -X-Request-Id/gu)).toHaveLength(2);
    expect(routes.match(/log_skip \/api\/document-storage\/callback\/\*/gu)).toHaveLength(2);
  });

  it("preserves the production security policy on unavailable-backend errors", () => {
    const productionRoute = routes.slice(
      routes.indexOf("business.finlynq.com {"),
      routes.indexOf("dev.business.finlynq.com {"),
    );
    expect(productionRoute).toContain("handle_errors {");
    expect(productionRoute).toContain('respond "" {err.status_code}');
    for (const header of [
      'X-Request-Id "{http.request.uuid}"',
      'Strict-Transport-Security "max-age=31536000; includeSubDomains"',
      'X-Content-Type-Options "nosniff"',
      'X-Frame-Options "DENY"',
      'Referrer-Policy "strict-origin-when-cross-origin"',
      "-Server",
    ]) {
      expect(productionRoute.split(header)).toHaveLength(3);
    }
    expect(verifier).toContain(
      'verify_security_headers "$production_hostname" "$preflight_headers"',
    );
    expect(verifier).not.toContain("production preflight response is missing HSTS");
  });

  it("attests the exact EPM owner, image, listeners, mounts, networks, and loaded config", () => {
    for (const network of [
      "business_finlynq_edge",
      "business_finlynq_development_edge",
      "epm_finlynq_edge",
      "epm_finlynq_edge_egress",
    ]) {
      expect(verifier).toContain(network);
    }
    expect(verifier).toContain("external_project\" == epm-finlynq");
    expect(verifier).toContain("external_service\" == edge");
    expect(verifier).toContain("external_owner\" == epm-finlynq");
    expect(verifier).toContain("BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE_ID");
    expect(verifier).toContain("BUSINESS_FINLYNQ_EXTERNAL_EDGE_PUBLIC_IPV4S");
    expect(verifier).toContain("external edge host bindings differ from the protected public-IP and port inventory");
    expect(verifier).toContain('"\\(.HostIp)|\\(.HostPort)|\\($entry.key)"');
    expect(verifier).toContain('"$address|80|80/tcp"');
    expect(verifier).toContain('"$address|443|443/tcp"');
    expect(verifier).toContain('"$address|443|443/udp"');
    expect(verifier).toContain("length == 5");
    expect(verifier).toContain("BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SHA256");
    expect(verifier).toContain("== 0:0:444");
    expect(verifier).toContain("BUSINESS_FINLYNQ_EXTERNAL_EDGE_ACTIVE_CONFIG_SHA256");
    expect(verifier).toContain("http://127.0.0.1:2019/config/");
    expect(verifier).toContain("external edge must keep Caddy credential redaction enabled");
    expect(verifier).toContain("log_credentials");
    expect(verifier).toContain('select(has("should_log_credentials"))');
    expect(verifier).toContain("loaded external edge configuration exposes credential headers");
  });

  it("supports a dev-first preflight without weakening full acceptance", () => {
    expect(verifier).toContain('[[ "$scope" == preflight || "$scope" == development || "$scope" == production');
    expect(verifier).toContain("production preflight requires an empty Business Compose project");
    expect(verifier).toContain('if [[ "$scope" == full || "$scope" == production ]]; then');
    expect(verifier).toContain("verify_release_router_runtime \"$production_project\"");
    expect(verifier).toContain('public_contract_is_valid "$production_hostname"');
    expect(verifier).toContain('public_contract_is_valid "$development_hostname"');
    expect(verifier).toContain('http_redirect_is_exact "$epm_hostname"');
    expect(verifier).toContain("positive edge log control was not observed");
    expect(verifier).toContain("external edge logs could not be read");
    expect(verifier).toContain("callback_targets+=(");
    expect(verifier).toContain('--resolve "$hostname:443:$address"');
    expect(verifier).toContain('--resolve "$hostname:80:$address"');
    expect(verifier).toContain('-connect "$address:443" -servername "$hostname"');
    expect(verifier).toContain('--resolve "$callback_hostname:443:$address"');
    expect(verifier.match(/curl --disable --noproxy '\*'/gu)).toHaveLength(9);
  });

  it("attests the release router as the exact hardened public-alias owner", () => {
    expect(verifier).toContain('container_for_service "$project" release_router');
    expect(verifier).toContain(
      'readonly release_router_reference="business-finlynq-release-router:v1"',
    );
    expect(verifier).toContain('readonly release_router_revision="release-router-v1"');
    expect(verifier).toContain('readonly release_router_contract="v1"');
    expect(verifier).toContain('expected_image="$release_router_reference"');
    expect(verifier).toContain(
      'Config.Labels["org.opencontainers.image.revision"] == $routerRevision',
    );
    expect(verifier).toContain(
      'Config.Labels["com.business-finlynq.release-router.contract"] == $routerContract',
    );
    expect(verifier).toContain('"$router_image_id" == "$tagged_image_id"');
    expect(verifier).not.toContain('.Config.Image == $image');
    expect(verifier).toContain('.Config.User == "10001:10001"');
    expect(verifier).toContain('.HostConfig.ReadonlyRootfs == true');
    expect(verifier).toContain('.HostConfig.CapDrop // []');
    expect(verifier).toContain('["no-new-privileges:true"]');
    expect(verifier).toContain('and ((.[0].Mounts // []) | length) == 1');
    expect(verifier).toContain('.[0].Mounts[0].Name == $stateVolume');
    expect(verifier).toContain('.[0].Mounts[0].Destination == "/state"');
    expect(verifier).toContain('"$router_mode" == "$expected_router_mode"');
    expect(verifier).toContain('"$expected_router_mode" == active-or-maintenance');
    const aliasOwnership = extractShellFunction(verifier, "verify_unique_network_alias_owner");
    expect(aliasOwnership).toContain('--filter "network=$network"');
    expect(aliasOwnership).not.toContain("com.docker.compose.project");
    expect(aliasOwnership).toContain('[[ "$container" == "$expected_full_id" ]]');
    expect(aliasOwnership).toContain("alias must be owned exactly once on $network");
    expect(verifier).toContain(
      '"$ingress_network" "$alias" "$router" "$project public backend"',
    );
    expect(verifier).toContain(
      '"$frontend_network" release-app "$app" "$project private application"',
    );
    expect(verifier).toContain('/_business-finlynq/release-router/live');
    expect(verifier).toContain('.status == "release-router-live"');
    expect(verifier.match(/--header='X-Business-Finlynq-Internal-Health: 1'/gu)).toHaveLength(2);
    expect(verifier).toContain('http://production-app:3000/api/health');
    expect(verifier).toContain('http://development-app:3000/api/health');
    expect(verifier).toContain('.status == "ready" and .revision == $revision');
    expect(verifier).toContain("production router does not preserve the outer active-health response");
    expect(verifier).toContain("development router does not preserve the outer active-health response");
  });

  it("tightly gates first-router forward repair without requiring an application upstream", () => {
    expect(verifier).toContain("--allow-first-router-forward-repair");
    expect(verifier).toContain('first_router_forward_repair_journal_sha256="$2"');
    expect(verifier).toContain('production_router_mode="maintenance"');
    expect(verifier).toContain('"$scope" == production');
    expect(verifier).toContain('"$expected_production_revision" == "$configured_production_revision"');
    expect(verifier).toContain(
      '"${RELEASE_EXECUTION_ACK:-}" =~ ^release:${configured_production_revision}:[a-z0-9][a-z0-9._-]{2,30}$',
    );
    expect(verifier).toContain(
      '"forward-repair:$configured_production_revision:$first_router_forward_repair_journal_sha256"',
    );
    expect(verifier).toContain("maintenance false");
    expect(verifier).toContain('if [[ "$require_upstream" == true ]]; then');
    expect(verifier).toContain("public_maintenance_contract_is_valid");
    expect(verifier).toContain("forward-repair readiness must return deterministic HTTP 503");
    expect(verifier).toContain('.status == "unavailable"');
    expect(verifier).toContain("the maintenance router returned an unexpected liveness response");
  });

  it.skipIf(bashExecutable === null)(
    "accepts exact public maintenance during journal-authorized forward repair",
    () => {
      const result = publicMaintenanceFixture();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("liveness");
      expect(result.stdout).toContain("security");
      expect(result.stdout).toContain("redirect");
      expect(result.stdout).toContain("tls");
    },
  );

  it.skipIf(bashExecutable === null)(
    "rejects a non-maintenance public response during forward repair",
    () => {
      const result = publicMaintenanceFixture({ status: "200" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must return deterministic HTTP 503");
    },
  );

  it.skipIf(bashExecutable === null)(
    "rejects a non-deterministic public maintenance body during forward repair",
    () => {
      const result = publicMaintenanceFixture({ body: '{"status":"ready"}' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("body is not deterministic maintenance");
    },
  );

  it.skipIf(bashExecutable === null)(
    "rejects a missing public maintenance retry boundary during forward repair",
    () => {
      const result = publicMaintenanceFixture({ retryAfter: "" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing the reviewed retry boundary");
    },
  );

  it("makes the production monitor require and independently attest the release router", () => {
    expect(monitor).toContain("expected_services=(database release_router app)");
    expect(monitor).toContain(
      'readonly release_router_reference="business-finlynq-release-router:v1"',
    );
    expect(monitor).toContain('readonly release_router_revision="release-router-v1"');
    expect(monitor).toContain('readonly release_router_contract="v1"');
    expect(monitor).toContain('release_router_expected_image="$release_router_reference"');
    expect(monitor).toContain(
      'Config.Labels["org.opencontainers.image.revision"] == $routerRevision',
    );
    expect(monitor).toContain(
      'Config.Labels["com.business-finlynq.release-router.contract"] == $routerContract',
    );
    expect(monitor).toContain('"$release_router_observed_image_id" != "$release_router_tagged_image_id"');
    expect(monitor).not.toContain('.Config.Image == $image');
    expect(monitor).toContain('.HostConfig.ReadonlyRootfs == true');
    expect(monitor).toContain('.HostConfig.CapDrop // []');
    expect(monitor).toContain('["no-new-privileges:true"]');
    expect(monitor).toContain('and ((.[0].Mounts // []) | length) == 1');
    expect(monitor).toContain('.[0].Mounts[0].Name == $stateVolume');
    expect(monitor).toContain('.[0].Mounts[0].Destination == "/state"');
    expect(monitor).toContain('[[ "$release_router_durable_mode" == active \\');
    expect(monitor).toContain('monitor_router_mode="active"');
    expect(monitor).toContain("--allow-transitional-router-maintenance");
    expect(monitor).toContain("--allow-production-router-maintenance");
    expect(monitor).toContain('["business_finlynq_edge", "business_finlynq_private-frontend"]');
    expect(monitor).toContain('. == "production-app"');
    expect(monitor).toContain("production public backend alias must be owned exactly once by release_router");
    expect(monitor).toContain("--filter 'network=business_finlynq_edge'");
    expect(monitor).toContain("--filter 'network=business_finlynq_private-frontend'");
    expect(monitor).toContain("private application alias must be owned exactly once by app");
    expect(monitor).toContain('"http://127.0.0.1:3100/_business-finlynq/release-router/live"');
    expect(monitor).toContain('"http://127.0.0.1:3100/api/health"');
    expect(monitor).toContain("release-router outer active-health response failed");
    expect(monitor).toContain('.status == "release-router-live"');
  });

  it("keeps production reconciliation scoped away from development and EPM health", () => {
    expect(reconciler).toContain(
      'exec bash "$repository/deploy/edge/verify-external-edge.sh" --scope production',
    );
  });

  it.skipIf(bashExecutable === null)(
    "accepts public liveness after bounded 503 warmup responses",
    () => {
      const result = publicLivenessFixture("503,503,200");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("requests=3");
    },
  );

  it.skipIf(bashExecutable === null)(
    "fails after the bounded public liveness warmup is exhausted",
    () => {
      const result = publicLivenessFixture("503,503,503");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("did not become available after 3 attempts");
      expect(result.stderr).toContain("requests=3");
    },
  );

  it.skipIf(bashExecutable === null)(
    "fails immediately on a hard public liveness response",
    () => {
      const result = publicLivenessFixture("401,200,200");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("liveness route returned HTTP 401");
      expect(result.stderr).toContain("requests=1");
    },
  );

  it.skipIf(bashExecutable === null)(
    "retries a transient curl transport failure",
    () => {
      const result = publicLivenessFixture("transport,200");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("requests=2");
    },
  );

  it.skipIf(bashExecutable === null)(
    "rejects an invalid liveness body without retrying a successful HTTP response",
    () => {
      const result = publicLivenessFixture("200,200,200", {
        body: '{"status":"warming"}',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("returned an unexpected liveness response");
      expect(result.stderr).toContain("requests=1");
    },
  );

  it.skipIf(bashExecutable === null)(
    "rejects invalid security headers without retrying a successful HTTP response",
    () => {
      const result = publicLivenessFixture("200,200,200", {
        omitHeader: "x-frame-options",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing the reviewed frame policy");
      expect(result.stderr).toContain("requests=1");
    },
  );

  it("keeps public and TLS checks mandatory in release and monitoring", () => {
    expect(release).toContain('MONITOR_EDGE_MODE" == "$edge_mode"');
    expect(release).toContain("77-external-edge-contract.log");
    expect(release).toContain("deploy/edge/docker-compose.external.yml");
    expect(rollback).toContain("deploy/edge/docker-compose.external.yml");
    expect(monitor).toContain("MONITOR_EXPECT_EDGE\" == true");
    expect(monitor).toContain("verify-external-edge.sh");
    expect(monitor).toContain("--scope production");
    expect(release).toContain("--scope production --warmup-host production");
    expect(monitor).not.toContain("--warmup-host");
    expect(reconciler).toContain('if [[ "$edge_mode" == external ]]');
  });

  it("forces edge Docker inspection onto the local daemon", () => {
    expect(verifier).toContain('env -i PATH="$clean_path" docker "$@"');
    expect(verifier).toContain("readonly clean_path=");
    expect(verifier).toContain("checked_container_sha256");
    expect(verifier).toContain("could not generate the callback log-exclusion sentinel");
    expect(verifier).not.toMatch(/readonly [A-Za-z_][A-Za-z0-9_]*="\$\((?!\()/u);
  });

  it("executes development edge acceptance from candidate-owned exact staged sources", () => {
    expect(developmentDeployer.split(/\r?\n/u).slice(0, 5)).toContain("set +x");
    expect(developmentDeployer).not.toContain(
      '/usr/local/libexec/business-finlynq/deploy/edge/verify-external-edge.sh',
    );
    expect(developmentDeployer).not.toContain("/etc/business-finlynq/initial-install-state.json");
    expect(developmentDeployer).not.toContain(
      "/home/deploy/business-finlynq/deploy/edge/verify-external-edge.sh",
    );
    expect(developmentDeployer).toContain(
      '"$state_directory/.candidate-edge-verifier.${verifier_revision}.XXXXXX"',
    );
    expect(developmentDeployer).toContain(
      'git_as_deploy show "$verifier_revision:$relative_path" >"$target_path"',
    );
    expect(developmentDeployer).toContain(
      'git_as_deploy rev-parse',
    );
    expect(developmentDeployer).toContain(
      'git_as_deploy hash-object --stdin <"$target_path"',
    );
    expect(developmentDeployer).toContain('chown root:root -- "$verifier_path" "$route_path"');
    expect(developmentDeployer).toContain('chmod 0500 "$verifier_path"');
    expect(developmentDeployer).toContain('chmod 0400 "$route_path"');
    expect(developmentDeployer).toContain(
      'bash "$verifier_path" --scope development --warmup-host development',
    );
    expect(developmentDeployer).toContain("--allow-development-router-maintenance");
    expect(verifier).toContain("development maintenance mode is valid only for the development scope");
    expect(release).toContain(
      'bash "$candidate_source_root/deploy/edge/verify-external-edge.sh"',
    );
    expect(release).not.toContain(
      'bash "$repository_root/deploy/edge/verify-external-edge.sh"',
    );
  });

  it("makes development external-edge and public acceptance explicit", () => {
    expect(developmentInstaller).toContain("--external-edge");
    expect(developmentInstaller).toContain('edge_mode="compose"');
    expect(developmentInstaller).toContain("--require-public-acceptance");
    expect(developmentInstaller).toContain("provider gates were unchanged");
    expect(developmentInstaller).toContain("--internal");
    expect(developmentInstaller).toContain("com.business-finlynq.edge-owner=external");
    expect(developmentDeployer).toContain("deploy/edge/docker-compose.external.yml");
    expect(developmentDeployer).toContain(
      'bash "$verifier_path" --scope development --warmup-host development',
    );
    expect(developmentDeployer).toContain("--allow-development-router-maintenance");
    expect(developmentDeployer).toContain("same-revision development public acceptance failed twice");
  });

  it("keeps post-cutover production acceptance independent of development health", () => {
    expect(release).toContain("--scope production --warmup-host production");
    expect(verifier).toContain('if [[ "$scope" != production ]]; then');
    expect(verifier).toContain('[[ "$scope" == production ]] || projects_to_check+=("$development_project")');
    expect(verifier).toContain('[[ "$scope" == production ]] || networks_to_check+=("$development_network")');
    expect(verifier).toContain('control_hostname="$production_hostname"');
    expect(verifier).toContain('[[ "$scope" == production ]] && control_hostname="$production_hostname"');
    expect(verifier).toContain('if [[ "$scope" == full || "$scope" == production ]]; then');
    expect(verifier).toContain("--allow-production-router-maintenance");
    expect(verifier).toContain(
      "production maintenance mode is valid only for the production scope",
    );
    expect(verifier).toContain('expected_production_revision=""');
    expect(verifier).toContain("--expected-production-revision");
    expect(verifier).toContain(
      'production_revision="${expected_production_revision:-$configured_production_revision}"',
    );

    expect(verifier).toContain(
      'expected_edge_networks_sorted="$(printf \'%s\\n\' "${expected_full_edge_networks[@]}" | sort)"',
    );
    expect(verifier).toContain(
      '[[ "$actual_edge_networks" == "$expected_edge_networks_sorted" ]]',
    );
    expect(verifier).toContain("length == 5");
    expect(verifier).toContain('--arg secretSource "$epm_secret_source"');
    expect(verifier).toContain(
      "external edge mounts differ from the protected full Caddy and EPM inventory",
    );
    expect(verifier).toContain(
      'if [[ "$scope" != production ]]; then\n  development_outer_health=',
    );
  });

  it.skipIf(process.platform === "win32")(
    "keeps a successful revision inventory successful when its last container does not match",
    () => {
      const start = developmentDeployer.indexOf("revision_project_container_ids() {");
      const end = developmentDeployer.indexOf("\nrevision_is_used_outside_project() {", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const inventoryFunction = developmentDeployer.slice(start, end);
      const revision = "a".repeat(40);
      const otherRevision = "b".repeat(40);
      const result = spawnSync("/bin/bash", ["-c", `
set -Eeuo pipefail
project=business-finlynq-development
fail() { printf '%s\\n' "$1" >&2; return 1; }
validate_revision() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
docker() {
  if [[ "$1 $2" == "ps --all" ]]; then
    printf '%s\\n' matching-container last-nonmatching-container
    return 0
  fi
  case "\${!#}" in
    matching-container) printf '%s\\n' '${revision}' ;;
    last-nonmatching-container) printf '%s\\n' '${otherRevision}' ;;
    *) return 97 ;;
  esac
}
${inventoryFunction}
inventory="$(revision_project_container_ids '${revision}')"
[[ "$inventory" == matching-container ]]
`], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    },
  );
});
