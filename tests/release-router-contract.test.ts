import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");

const dockerfile = source("Dockerfile");
const compose = source("docker-compose.yml");
const candidateImages = source("deploy/release/docker-compose.candidate-images.yml");
const activeCaddyfile = source("deploy/release/router/Caddyfile");
const maintenanceCaddyfile = source("deploy/release/router/Caddyfile.maintenance");
const routerEntrypoint = source("deploy/release/router/entrypoint.sh");
const release = source("deploy/release/run-release.sh");
const rollback = source("deploy/release/run-application-rollback.sh");
const development = source("deploy/development/deploy-development.sh");
const externalEdge = source("deploy/edge/Caddyfile.business-external");
const containerEdge = source("deploy/Caddyfile.container");
const externalVerifier = source("deploy/edge/verify-external-edge.sh");
const productionMonitor = source("deploy/monitoring/check-production.sh");
const initialInstaller = source("deploy/production/install-initial-production.sh");
const playwright = source("playwright.config.ts");
const releaseGate = source("e2e/release-gate.e2e.ts");
const fiscalPeriodGate = source("e2e/fiscal-period-creation.e2e.ts");
const releaseAcceptance = source("e2e/release-acceptance.ts");
const boundaryVerifier = source("scripts/operations/verify-compose-boundaries.mjs");
const releaseRunbook = source("docs/operations/release-runbook.md");
const legacyRollbackAdapter = source("deploy/rollback/legacy-inline-db-password-entrypoint.sh");

const between = (value: string, startMarker: string, endMarker: string) => {
  const start = value.indexOf(startMarker);
  const end = value.indexOf(endMarker, start + startMarker.length);
  expect(start, `missing ${startMarker.trim()}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing ${endMarker.trim()}`).toBeGreaterThan(start);
  return value.slice(start, end);
};

const expectOrdered = (value: string, markers: string[]) => {
  let previous = -1;
  for (const marker of markers) {
    const position = value.indexOf(marker, previous + 1);
    expect(position, `missing or out-of-order marker: ${marker}`).toBeGreaterThan(previous);
    previous = position;
  }
};

const occurrences = (value: string, expression: RegExp) => value.match(expression)?.length ?? 0;

describe("stable fail-closed release router", () => {
  it("builds a separately versioned v1 router with the reviewed restart entrypoint", () => {
    const target = between(
      dockerfile,
      "FROM caddy:2.10.2-alpine@sha256:",
      "\nFROM node:24-alpine@sha256:",
    );

    expect(target).toMatch(/^FROM caddy:2\.10\.2-alpine@sha256:[a-f0-9]{64} AS release-router/m);
    expect(target).toContain("com.business-finlynq.release-router.contract=v2");
    expect(target).toContain("org.opencontainers.image.revision=release-router-v2");
    expect(target).not.toContain("ARG BUSINESS_FINLYNQ_IMAGE_REVISION");
    expect(target).toContain("ARG SOURCE_DATE_EPOCH");
    expect(target).toContain('test "$SOURCE_DATE_EPOCH" = "1788998400"');
    expect(target).toContain("setcap -r /usr/bin/caddy");
    expect(target).toContain('test -z "$(getcap /usr/bin/caddy)"');
    expect(target).toContain(
      "COPY --chmod=0444 deploy/release/router/Caddyfile /etc/caddy/Caddyfile",
    );
    expect(target).toContain(
      "COPY --chmod=0444 deploy/release/router/Caddyfile.maintenance /etc/caddy/Caddyfile.maintenance",
    );
    expect(target).toContain(
      "COPY --chmod=0555 deploy/release/router/entrypoint.sh /usr/local/bin/release-router-entrypoint",
    );
    expect(target).toContain("mkdir -p /state");
    expect(target).toContain("chmod 0700 /state");
    expect(target).toContain("printf 'maintenance\\n' >/state/mode");
    expect(target).toContain("chmod 0600 /state/mode");
    expect(target).toContain("USER 10001:10001");
    expect(target).toContain('ENTRYPOINT ["/usr/local/bin/release-router-entrypoint"]');
    expect(target).toContain('CMD ["serve"]');
  });

  it("repairs missing or malformed durable state to maintenance without persisting a credential", () => {
    expect(routerEntrypoint).toContain("readonly state_directory=/state");
    expect(routerEntrypoint).toContain('readonly state_file="$state_directory/mode"');
    expect(routerEntrypoint).toContain(
      '[ "$(stat -c \'%u:%g:%a\' "$state_directory")" = 10001:10001:700 ]',
    );
    expect(routerEntrypoint).toContain("mode=maintenance");
    expect(routerEntrypoint).toContain("state_valid=false");
    expect(routerEntrypoint).toContain('case "$mode" in\n\t\tactive|maintenance) state_valid=true ;;');
    expectOrdered(routerEntrypoint, [
      'if [ "$state_valid" != true ]; then',
      "mode=maintenance",
      'temporary="$state_directory/.mode.$$"',
      'printf \'%s\\n\' "$mode" >"$temporary"',
      'chmod 0600 "$temporary"',
      'mv -f "$temporary" "$state_file"',
      'sync "$state_file" 2>/dev/null || sync',
      'case "$mode" in',
    ]);
    expect(routerEntrypoint).toContain("active)\n\t\tconfig=/etc/caddy/Caddyfile");
    expect(routerEntrypoint).toContain("maintenance)\n\t\tconfig=/etc/caddy/Caddyfile.maintenance");
    expect(routerEntrypoint).toContain("od -An -N32 -tx1 /dev/urandom");
    expect(routerEntrypoint).toContain("tr -d ' \\n'");
    expect(routerEntrypoint).toContain(
      'export BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN="$lock_token"',
    );
    expect(routerEntrypoint).toContain('exec caddy run --config "$config" --adapter caddyfile');

    const durableStateLines = routerEntrypoint
      .split("\n")
      .filter((line) => /state_(?:directory|file)|\/state\/mode|\$temporary/.test(line))
      .join("\n");
    expect(durableStateLines).not.toMatch(/token|credential/i);
    expect(durableStateLines).not.toContain("BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN");
  });

  it("mounts only a versioned non-secret mode volume and keeps the router as the sole boundary", () => {
    const router = between(compose, "  release_router:\n", "\n  app:\n");
    const app = between(compose, "  app:\n", "\n  auth_email_worker:\n");
    const routerVolumes = between(router, "    volumes:\n", "    security_opt:\n");

    expect(router).toContain("image: business-finlynq-release-router:v2");
    expect(router).not.toContain("BUSINESS_FINLYNQ_IMAGE_REVISION");
    expect(router).toContain("target: release-router");
    expect(router).toContain('user: "10001:10001"');
    expect(router).toContain(
      '"127.0.0.1:${BUSINESS_FINLYNQ_APP_PORT:-3100}:3000"',
    );
    expect(routerVolumes.trim()).toBe(
      "volumes:\n      - business_finlynq_release_router_state:/state",
    );
    expect(compose).toContain(
      "business_finlynq_release_router_state:\n    name: ${RELEASE_REHEARSAL_PROJECT:-${BUSINESS_FINLYNQ_PRIVATE_NETWORK:-business_finlynq_private}}-release-router-state-v2",
    );
    expect(router).toContain("/tmp:size=16m");
    expect(router).toContain("/config:size=1m");
    expect(router).toContain("/data:size=1m");
    expect(router).toContain("business_finlynq_frontend:");
    expect(router).toContain("business_finlynq_router_control:");
    expect(router).toContain("business_finlynq_edge:");
    expect(router).toContain("${BUSINESS_FINLYNQ_APP_NETWORK_ALIAS:-production-app}");
    expect(router).toContain("read_only: true");
    expect(router).toContain("cap_drop: [ALL]");
    expect(router).toContain("no-new-privileges:true");
    expect(router).toContain("restart: unless-stopped");
    expect(router).toContain("stop_grace_period: 75s");
    expect(router).not.toMatch(/^\s+secrets:/m);
    expect(router).not.toMatch(/^\s+environment:/m);
    expect(router).not.toMatch(/^\s+depends_on:/m);

    expect(app).not.toMatch(/^\s+ports:/m);
    expect(app).not.toContain("business_finlynq_edge:");
    expect(app).toMatch(/business_finlynq_frontend:\n\s+aliases:\n\s+- release-app/);
    expect(app).toMatch(/release_router:\n\s+condition: service_healthy/);

    const networks = compose.slice(compose.lastIndexOf("\nnetworks:\n"));
    expect(networks).toMatch(
      /business_finlynq_frontend:\n\s+name: .*\}-frontend\n\s+internal: true/,
    );
    expect(networks).toMatch(
      /business_finlynq_router_control:\n\s+name: .*\}-router-control\n\s+driver: bridge\n\s+driver_opts:\n\s+com\.docker\.network\.bridge\.enable_icc: "false"\n\s+com\.docker\.network\.bridge\.enable_ip_masquerade: "false"/,
    );
    const edgeNetwork = between(
      networks,
      "  business_finlynq_edge:\n",
      "\n  business_finlynq_restore_drill:\n",
    );
    expect(edgeNetwork).not.toContain("internal: true");
  });

  it("uses one private admin socket for atomic active and maintenance configurations", () => {
    for (const configuration of [activeCaddyfile, maintenanceCaddyfile]) {
      expect(occurrences(configuration, /admin unix\/\/tmp\/caddy-admin\.sock\|0600/g)).toBe(1);
      expect(configuration).toContain("persist_config off");
      expect(configuration).toContain("auto_https off");
      expect(configuration).toContain("grace_period 1m");
      expect(configuration).not.toMatch(/admin\s+(?:0\.0\.0\.0|localhost|:2019)/);
      expect(configuration).toContain("reverse_proxy release-app:3000");
      expect(configuration).toContain("keepalive off");
    }

    expect(activeCaddyfile).not.toContain("{$BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN}");
    expect(activeCaddyfile).not.toContain("header_up -Authorization");
    expect(maintenanceCaddyfile).toContain("header_up -Authorization");
    expect(maintenanceCaddyfile).toContain(
      '@candidate_preview header Authorization "Bearer {$BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN}"',
    );
    expectOrdered(maintenanceCaddyfile, [
      "handle @router_live {",
      "handle @public_live {",
      "handle @candidate_preview {",
      "handle @marked_health {",
      "handle @outer_active_health {",
      "handle @public_health {",
      "handle {\n\t\timport maintenance_response",
    ]);
    expect(maintenanceCaddyfile).toContain('respond `{"status":"unavailable"}` 503');
    expect(maintenanceCaddyfile).toContain('respond "Service temporarily unavailable.\\n" 503');
    expect(release).toContain(
      '== "Service temporarily unavailable.\\\\n"',
    );
    expect(rollback).toContain(
      '== "Service temporarily unavailable.\\\\n"',
    );
    expect(release).toContain(
      '--header "X-Request-Id: release-final-readiness-$run_id"',
    );
    expect(release).toContain(
      'if [[ "$mode" != rehearsal ]]; then\n  commit_release_router_active\nfi',
    );

    expectOrdered(activeCaddyfile, [
      "handle @router_live {",
      "handle @public_live {",
      "handle @marked_health {",
      "handle @public_health {",
      "handle @outer_active_health {",
      "handle {\n\t\timport release_app_upstream",
      "handle_errors {",
    ]);
    expect(activeCaddyfile).toContain('respond `{"status":"unavailable"}` 503');
  });

  it("commits maintenance before reload and durable active only after terminal acceptance", () => {
    const persistMode = between(
      release,
      "persist_release_router_mode() {",
      "\nreload_release_router_configuration() {",
    );
    const reload = between(
      release,
      "reload_release_router_configuration() {",
      "\nverify_release_router_maintenance() {",
    );

    expectOrdered(persistMode, [
      '[[ "$mode" == active || "$mode" == maintenance ]]',
      'temporary="/state/.mode.$$"',
      'printf "%s\\n" "$mode" >"$temporary"',
      'chmod 0600 "$temporary"',
      'mv -f "$temporary" /state/mode',
      'sync /state/mode 2>/dev/null || sync',
      'sync -f /state 2>/dev/null || sync',
      '"$(cat /state/mode)" == "$mode"',
    ]);
    expect(occurrences(reload, / caddy reload \\/g)).toBe(2);
    expect(occurrences(reload, /--address unix\/\/tmp\/caddy-admin\.sock/g)).toBe(2);
    expect(reload).not.toMatch(/docker (?:start|stop|restart)|compose .*release_router/);
    expect(release).toContain("persist_release_router_mode maintenance");
    expect(release).toContain("reload_release_router_configuration Caddyfile.maintenance");
    expect(release).toContain("reload_release_router_configuration Caddyfile");
    expect(release).toContain("persist_release_router_mode active");

    const preexistingMaintenance = between(
      release,
      'if [[ "$router_was_preexisting" == "true" ]]; then\n  stage="enter-graceful-maintenance"',
      '\nwrite_surface_containment_armed="true"',
    );
    const parentTokenGeneration = release.indexOf(
      'release_acceptance_token="$(openssl rand -hex 32)"',
    );
    const firstLoggedMaintenance = release.indexOf(
      "run_logged 23-release-router-maintenance.log enter_release_router_maintenance",
    );
    expect(parentTokenGeneration).toBeGreaterThanOrEqual(0);
    expect(parentTokenGeneration).toBeLessThan(firstLoggedMaintenance);
    const maintenanceFunction = between(
      release,
      "enter_release_router_maintenance() {",
      "\nactivate_release_router_live() {",
    );
    expect(maintenanceFunction).not.toContain('openssl rand');
    expect(maintenanceFunction).toContain(
      '[[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]]',
    );
    expectOrdered(preexistingMaintenance, [
      "run_logged 23-release-router-maintenance.log enter_release_router_maintenance",
      'router_maintenance_confirmed="true"',
      'router_active_confirmed="false"',
    ]);
    const stoppedWrites = between(
      release,
      'write_surface_containment_armed="true"',
      '\nwrite_checkpoint 26-write-surfaces-stopped.json',
    );
    expectOrdered(stoppedWrites, [
      "run_logged 25-stop-write-surfaces.log stop_write_surfaces",
      'write_surfaces_stopped="true"',
    ]);
    const bootstrapMaintenance = between(
      release,
      'stage="enter-bootstrap-maintenance"',
      '\nelse\n  verify_release_router_runtime 27-release-router-runtime.json',
    );
    expectOrdered(bootstrapMaintenance, [
      "run_logged 28-release-router-maintenance.log enter_release_router_maintenance",
      'router_maintenance_confirmed="true"',
      'router_active_confirmed="false"',
    ]);

    expectOrdered(release, [
      'stage="enter-graceful-maintenance"',
      "run_logged 25-stop-write-surfaces.log stop_write_surfaces",
      'stage="pre-migration-backup"',
      'stage="browser-acceptance"',
      'stage="activate-reviewed-write-gates"',
      "verify_release_router_maintenance",
      'stage="activate-accepted-application"',
      "run_logged 75-release-router-active.log activate_release_router_live",
      'stage="final-public-readiness"',
    ]);
    const finalization = release.slice(release.indexOf('stage="complete-evidence"'));
    expectOrdered(finalization, [
      'mv -- "$terminal_evidence_temporary" "$evidence_directory/90-release-complete.json"',
      'sync -f -- "$evidence_directory"',
      "sync_evidence_inventory",
      "authorize_active_finalization_marker",
      'terminal_evidence_committed="true"',
      "commit_release_router_active",
      "clear_active_finalization_marker",
      'release_completed="true"',
    ]);
    const pendingMarker = between(
      release,
      "write_active_finalization_marker() (",
      "\nauthorize_active_finalization_marker() (",
    );
    const authorizedMarker = between(
      release,
      "authorize_active_finalization_marker() (",
      "\nclear_active_finalization_marker() {",
    );
    expect(pendingMarker).toContain('phase: "terminal-evidence-pending"');
    expect(authorizedMarker).toContain('terminal_evidence_sha256="$(checked_file_sha256');
    expect(authorizedMarker).toContain('.phase = "active-commit-authorized"');
    expect(authorizedMarker).toContain('.authorizedAt = $authorizedAt');
    expect(authorizedMarker).toContain(
      '.terminalEvidenceSha256 = $terminalEvidenceSha256',
    );
    const failureCleanup = between(release, "on_exit() {", "\ntrap on_exit EXIT");
    expect(failureCleanup).toContain('[[ "$terminal_evidence_committed" != "true"');
    expect(failureCleanup).toContain(
      '"Accepted candidate evidence and active-finalization authorization are durable; the exact candidate is eligible for strict active-last recovery."',
    );
    const liveActivation = between(
      release,
      "activate_release_router_live() {",
      "\ncommit_release_router_active() {",
    );
    expect(liveActivation).toContain("reload_release_router_configuration Caddyfile");
    expect(liveActivation).not.toContain("persist_release_router_mode active");
    const durableActivation = between(
      release,
      "commit_release_router_active() {",
      "\nwait_for_router_upstream_drain() {",
    );
    expect(durableActivation).toContain("persist_release_router_mode active");
    expect(release).toContain("--allow-production-router-maintenance");
    expect(release).toContain("--allow-transitional-router-maintenance");

    const rollbackFlow = rollback.slice(
      rollback.lastIndexOf('\nrollback_containment_armed="true"\n'),
    );
    expectOrdered(rollbackFlow, [
      'rollback_containment_armed="true"',
      "ensure_candidate_release_router",
      "verify_candidate_release_router",
      "enter_rollback_maintenance",
      "wait_for_rollback_router_drain",
      "rollback_compose stop --timeout 60 app",
      "rollback_compose up --detach --no-deps --no-build --force-recreate app",
      "verify_rollback_maintenance",
      "activate_rollback_router_live",
      "verify_rollback_public_readiness",
      "--expected-production-revision",
      'mv -- "$rollback_evidence_temporary" "$rollback_evidence_file"',
      'sync -f -- "$(dirname -- "$rollback_evidence_file")"',
      "commit_rollback_router_active",
      'rollback_containment_armed="false"',
    ]);

    const rollbackStaticContract = between(
      rollback,
      "release_router_static_contract_is_valid() {",
      "\nverify_candidate_release_router_static() {",
    );
    for (const contract of [
      ".[0].Image == $imageId",
      ".[0].Config.Image == $image",
      '"org.opencontainers.image.revision"] == $revision',
      '"com.business-finlynq.release-router.contract"] == $contract',
      '.[0].Config.User == "10001:10001"',
      ".[0].Config.Healthcheck.Test ==",
      ".[0].HostConfig.ReadonlyRootfs == true",
      ".[0].HostConfig.Privileged == false",
      '"Name":"unless-stopped"',
      "((.[0].HostConfig.CapDrop // []) | sort) == [\"ALL\"]",
      '"no-new-privileges:true"',
      ".[0].HostConfig.PidsLimit == 64",
      ".[0].HostConfig.Memory == 100663296",
      ".[0].HostConfig.NanoCpus == 250000000",
      '(.[0].HostConfig.PortBindings | keys) == ["3000/tcp"]',
      '"HostIp":"127.0.0.1", "HostPort":$port',
      '(.[0].HostConfig.Tmpfs | keys | sort) == ["/config", "/data", "/tmp"]',
      "((.[0].Mounts // []) | length) == 1",
      ".[0].Mounts[0].Name == $stateVolume",
      "([$controlNetwork, $edgeNetwork, $frontendNetwork] | sort)",
      ". == $publicAlias",
    ]) {
      expect(rollbackStaticContract).toContain(contract);
    }

    const offlinePersist = between(
      rollback,
      "persist_rollback_router_mode_offline() {",
      "\nensure_candidate_release_router() {",
    );
    const onlinePersist = between(
      rollback,
      "persist_rollback_router_mode_online() {",
      "\nreload_rollback_router_configuration() {",
    );
    for (const persist of [offlinePersist, onlinePersist]) {
      expectOrdered(persist, [
        'temporary="/state/.mode.$$"',
        'mv -f "$temporary" /state/mode',
        "sync /state/mode 2>/dev/null || sync",
        "sync -f /state 2>/dev/null || sync",
        '"$(cat /state/mode)" == "$mode"',
      ]);
    }

    const ensureRollbackRouter = between(
      rollback,
      "ensure_candidate_release_router() {",
      "\nrollback_compose() {",
    );
    expectOrdered(ensureRollbackRouter, [
      "verify_candidate_release_router_static",
      "persist_rollback_router_mode_offline maintenance \"$router_query\"",
      'docker start "$router_query"',
      "persist_rollback_router_mode_offline maintenance",
      "base_compose up --detach --wait --no-deps --no-build release_router",
      "verify_candidate_release_router maintenance",
      "verify_rollback_maintenance",
    ]);

    const rollbackReload = between(
      rollback,
      "reload_rollback_router_configuration() {",
      "\nverify_rollback_maintenance() {",
    );
    expect(rollbackReload).not.toContain("persist_rollback_router_mode_online");
    expect(rollback).toContain("persist_rollback_router_mode_online maintenance");
    expect(rollback).toContain("persist_rollback_router_mode_online active");
  });

  it("drains established upstream work before stopping the app and aligns shutdown grace", () => {
    const drain = between(
      release,
      "wait_for_router_upstream_drain() {",
      "\nwait_for_application_database_disconnect() {",
    );
    const stopWriteSurfaces = between(
      release,
      "stop_write_surfaces() {",
      '\nif [[ "$router_was_preexisting" == "true" ]]; then',
    );

    expect(drain).toContain('$4 == "01" && $3 ~ /:0BB8$/');
    expect(drain).toContain("/proc/net/tcp /proc/net/tcp6");
    expect(drain).toContain("for attempt in {1..60}");
    expect(drain).toContain("establishedConnections: 0");
    expectOrdered(stopWriteSurfaces, [
      "stop --timeout 60 auth_email_worker",
      "wait_for_router_upstream_drain",
      "compose stop --timeout 60 app",
      "wait_for_application_database_disconnect",
    ]);
    expect(activeCaddyfile).toContain("grace_period 1m");
    expect(maintenanceCaddyfile).toContain("grace_period 1m");
    expect(between(compose, "  release_router:\n", "\n  app:\n")).toContain(
      "stop_grace_period: 75s",
    );
    expect(rollback).toContain("wait_for_rollback_router_drain() {");
    expect(rollback).toContain("in-flight application requests did not drain before rollback");
  });

  it("requires the stable router to be the unique production public-alias owner during rollback", () => {
    const runtimeVerification = between(
      rollback,
      "verify_candidate_release_router() {",
      "\nrollback_router_state_volume_is_valid() {",
    );

    expect(runtimeVerification).toContain("router_full_id");
    expect(runtimeVerification).toContain("docker ps --all --no-trunc");
    expect(runtimeVerification).toContain(
      '--filter "network=$rollback_router_edge_network"',
    );
    expect(runtimeVerification).not.toContain(
      "--filter 'label=com.docker.compose.project=business-finlynq'",
    );
    expect(runtimeVerification).toContain(
      "any(.[$edgeNetwork].Aliases[]?; . == $publicAlias)",
    );
    expect(runtimeVerification).toContain(
      '[[ "$network_container" == "$router_full_id" ]]',
    );
    expect(runtimeVerification).toContain('[[ "$alias_owner_count" == 1 ]]');
    expect(runtimeVerification).toContain(
      "production public backend alias must be owned exactly once during rollback",
    );
    expect(runtimeVerification).toContain(
      '"$rollback_router_frontend_network" release-app "$expected_app_container"',
    );
    expect(rollback).toContain('if [[ "$edge_mode" == external ]]; then');
    expect(rollback).toContain(
      'bash "$candidate_source_root/deploy/edge/verify-external-edge.sh"',
    );
    expect(rollback).toContain("--scope production --warmup-host production");
    expect(rollback).toContain("--allow-production-router-maintenance");
    expect(rollback).toContain('--expected-production-revision "$previous_revision"');
  });

  it("integrates the exact f8485 adapter into the contained rollback runner", () => {
    expect(rollback).toContain(
      'readonly legacy_rollback_revision="f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107"',
    );
    expect(rollback).toContain(
      'readonly legacy_rollback_image_id="sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5"',
    );
    expect(rollback).toContain("docker-compose.legacy-inline-password.yml");
    expect(rollback).toContain(
      'compatibility_environment+=("ROLLBACK_COMPATIBILITY_ACK=$rollback_compatibility_ack")',
    );
    expect(rollback).toContain("the rendered f8485 rollback adapter differs");
    expect(rollback).toContain("verify-legacy-app.sh");
    expect(rollback).toContain("--allow-f8485-minimal-production-health");
    expect(externalVerifier).toContain(
      "minimal production health is restricted to the acknowledged exact f8485 rollback",
    );
    expect(releaseRunbook).toContain("run-application-rollback.sh");
    expect(releaseRunbook).toContain("Do not start the legacy app with raw `docker compose`");
    expect(releaseRunbook).not.toContain("up --detach --no-deps app");
  });

  it("materializes the exact f8485 adapter at a durable protected bind source", () => {
    const expectedDigest = "c997b2312f156cb5f97919f9c07758b09b244b77a578c767a3b827465ec94cdb";
    const prepareAdapter = between(
      rollback,
      "prepare_durable_legacy_rollback_adapter() {",
      "\nverify_rollback_public_readiness() {",
    );
    const rollbackCompose = between(
      rollback,
      "rollback_compose() {",
      "\ncontain_rollback_scheduled_containers() {",
    );
    const cleanup = between(
      rollback,
      "cleanup_rollback_transients() {",
      "\ncleanup_early_rollback_exit() {",
    );
    const runtimeMount = rollback.slice(
      rollback.indexOf('rollback_container="$(rollback_compose ps --quiet app)"'),
      rollback.indexOf("verify_unique_network_alias_owner", rollback.indexOf(
        'rollback_container="$(rollback_compose ps --quiet app)"',
      )),
    );

    expect(createHash("sha256").update(legacyRollbackAdapter).digest("hex")).toBe(expectedDigest);
    expect(rollback).toContain(`readonly legacy_rollback_adapter_sha256="${expectedDigest}"`);
    expect(rollback).toContain(
      'readonly legacy_rollback_adapter_root="$production_configuration_directory/rollback-adapters"',
    );
    expect(prepareAdapter).toContain('[[ "$(id -u)" == 0 ]]');
    expect(prepareAdapter).toContain('== "0:$deploy_gid:750"');
    expect(prepareAdapter).toContain('== "$legacy_rollback_adapter_sha256"');
    expect(prepareAdapter).toContain("install -d -o root -g root -m 0755");
    expect(prepareAdapter).toContain("install -o root -g root -m 0555");
    expect(prepareAdapter).toContain('sync -f -- "$legacy_rollback_adapter_directory"');
    expect(prepareAdapter).toContain('--arg source "$legacy_rollback_adapter_path"');
    expect(rollbackCompose).toContain(
      'compose_files+=(-f "$legacy_rollback_compose_override")',
    );
    expect(runtimeMount).toContain('.Source == $source');
    expect(runtimeMount).toContain('.RW == false');
    expect(cleanup).toContain('== "$legacy_rollback_adapter_path.partial."*');
    expect(cleanup).not.toContain('rm -f -- "$legacy_rollback_adapter_path"');
    expect(rollback).toContain("legacyCredentialAdapterSha256:");
    expectOrdered(rollback, [
      "prepare_durable_legacy_rollback_adapter",
      'rendered_rollback_compose="$(rollback_compose config --format json)"',
      'source="$legacy_rollback_adapter_path"',
      "rollback_compose up --detach --no-deps --no-build --force-recreate app",
      "the protected f8485 durable adapter changed during rollback acceptance",
      "cleanup_rollback_transients",
    ]);
  });

  it("keeps the one-time f8485 forward transition exact and recoverable", () => {
    expect(release).toContain(
      'readonly legacy_f8485_image_id="sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5"',
    );
    expect(release).toContain(
      '"${ROLLBACK_COMPATIBILITY_ACK:-}" == f8485-one-release-only',
    );
    expect(release).toContain('if [[ "$scheduler_mode" == cron ]]; then');
    expect(release).toContain("detach_previous_app_public_edge() {");
    expectOrdered(release, [
      "run_logged 25-stop-write-surfaces.log stop_write_surfaces",
      "detach_previous_app_public_edge",
      "compose up --detach --wait --no-deps --no-build release_router",
    ]);
    expect(release).toContain(
      "docker network disconnect --force \"$router_edge_network_name\" \"$previous_container\"",
    );
    expect(release).toContain(
      "docker network connect --alias production-app",
    );
    expect(externalVerifier).toContain(
      'readonly legacy_f8485_image_id="sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5"',
    );
    expect(externalVerifier).toContain(
      '.[0].Image == $legacyImage',
    );
    expect(externalVerifier).not.toContain("edge_log_control");
    expect(release).toContain(
      'pre_cutover_edge_arguments+=(--allow-f8485-minimal-production-health)',
    );
  });

  it("accepts an unlabeled previous anchor only for the exact acknowledged f8485 adapter", () => {
    const classification = between(
      rollback,
      'observed_application_artifact=""',
      "\nobserved_application_state=",
    );

    expect(classification).toContain(
      '"$current_app_revision" == "$candidate_revision"',
    );
    expect(classification).toContain(
      '"$current_app_revision" == "$previous_revision"',
    );
    expect(classification).toContain(
      '"$legacy_rollback_adapter_required" == true',
    );
    expect(classification).toContain(
      '"$previous_revision" == "$legacy_rollback_revision"',
    );
    expect(classification).toContain(
      '"$previous_image_id" == "$legacy_rollback_image_id"',
    );
    expect(classification).toContain(
      '"$current_app_image_id" == "$legacy_rollback_image_id"',
    );
    expect(classification).toContain(
      '"$rollback_compatibility_ack" == f8485-one-release-only',
    );
    expect(classification).toContain('-z "$current_app_revision"');
    expect(classification).toContain(
      '"$current_app_revision" == \'<no value>\'',
    );
  });

  it("forces and attests both rollback feed gates as disabled", () => {
    const rollbackCompose = between(
      rollback,
      "rollback_compose() {",
      "\ncontain_rollback_scheduled_containers() {",
    );
    const runtimeGateAttestation = between(
      rollback,
      'rollback_environment="$(docker inspect',
      "\n    [[ -f \"$canonical_environment_file\"",
    );

    expect(rollbackCompose).toContain(
      "BUSINESS_WRITES_ENABLED=false BANK_FEEDS_ENABLED=false YAHOO_FX_ENABLED=false",
    );
    expect(runtimeGateAttestation).toContain(
      "BUSINESS_WRITES_ENABLED BANK_FEEDS_ENABLED YAHOO_FX_ENABLED; do",
    );
  });

  it("checks both network-wide Docker DNS hops before release activation", () => {
    const aliasCheck = between(
      release,
      "verify_unique_network_alias_owner() {",
      "\nverify_release_router_runtime() {",
    );
    expect(aliasCheck).toContain('--filter "network=$network"');
    expect(aliasCheck).not.toContain("com.docker.compose.project");
    expect(aliasCheck).toContain('[[ "$container" == "$expected_full_id" ]]');
    expect(release).toContain(
      '"$router_edge_network_name" "$router_public_alias" "$router_container"',
    );
    expect(release).toContain(
      '"$router_frontend_network_name" release-app "$final_container"',
    );
  });

  it("recontains scheduled mutators when rollback scheduler pause fails partway", () => {
    const scheduledContainment = between(
      rollback,
      "contain_rollback_scheduled_containers() {",
      "\ncontain_failed_rollback() {",
    );
    const failureTrap = between(
      rollback,
      "contain_failed_rollback() {",
      "\ntrap contain_failed_rollback EXIT",
    );
    const rollbackFlow = rollback.slice(
      rollback.lastIndexOf('\nrollback_containment_armed="true"\n'),
    );

    for (const service of [
      "provision_backup",
      "backup",
      "verify_latest_backup",
      "verify_accounting_evidence",
      "reconcile_demo_sandboxes",
    ]) {
      expect(scheduledContainment).toContain(service);
    }
    expect(scheduledContainment).toContain("docker stop --time 30");
    expect(scheduledContainment).toContain('docker kill "$container_id"');
    expect(scheduledContainment).toContain('[[ -z "$query" ]] || containment_status=1');
    expect(failureTrap).toContain('rollback_scheduler_pause_attempted" == "true');
    expect(failureTrap).toContain('rollback_schedulers_paused" != "true');
    expectOrdered(failureTrap, [
      "contain_rollback_scheduled_containers",
      "timeout --signal=TERM --kill-after=5s 2m",
      '"$scheduler_mode" --allow-already-paused',
      'rollback_schedulers_paused="true"',
      "contain_rollback_scheduled_containers",
    ]);
    expectOrdered(rollbackFlow, [
      'rollback_scheduler_pause_attempted="true"',
      'bash "$candidate_source_root/deploy/release/pause-schedulers.sh" "$scheduler_mode" --allow-already-paused',
      'rollback_schedulers_paused="true"',
      "enter_rollback_maintenance",
    ]);
  });

  it("arms a lock-holding watchdog across the rollback live-only acceptance window", () => {
    const markerWriter = between(
      rollback,
      "write_protected_rollback_watchdog_marker() {",
      "\nrollback_watchdog_lock_fds_are_valid() {",
    );
    const lockProof = between(
      rollback,
      "rollback_watchdog_lock_fds_are_valid() {",
      "\nstop_exact_scoped_rollback_service() {",
    );
    const parentlessContainment = between(
      rollback,
      "contain_parentless_rollback() {",
      "\nrollback_sigkill_watchdog_main() {",
    );
    const watchdog = between(
      rollback,
      "rollback_sigkill_watchdog_main() {",
      "\narm_rollback_sigkill_watchdog() {",
    );
    const arm = between(
      rollback,
      "arm_rollback_sigkill_watchdog() {",
      "\ndisarm_rollback_sigkill_watchdog() {",
    );
    const disarm = between(
      rollback,
      "disarm_rollback_sigkill_watchdog() {",
      "\nwait_for_rollback_router_drain() {",
    );
    const acceptedFlow = rollback.slice(
      rollback.indexOf(
        'legacy_rollback_adapter_is_valid \\\n        || fail "the protected f8485 durable adapter changed during rollback acceptance"',
      ),
    );

    expect(markerWriter).toContain('== "$rollback_watchdog_owner_uid:600:1"');
    expect(markerWriter).toContain('sync -f -- "$temporary"');
    expect(markerWriter).toContain('sync -f -- "$candidate_staging_root"');
    expect(lockProof).toContain('"/proc/$watchdog_pid/fd/8"');
    expect(lockProof).toContain('"/proc/$watchdog_pid/fd/9"');
    expect(lockProof).toContain('"$coordination_fd_identity" == "$coordination_path_identity"');
    expect(parentlessContainment).toContain(
      "if ! force_rollback_router_maintenance",
    );
    expect(parentlessContainment).toContain(
      "|| ! rollback_public_alias_has_exact_owner",
    );
    expectOrdered(parentlessContainment, [
      "force_rollback_router_maintenance",
      "for service_name in release_router app auth_email_worker",
      'stop_exact_scoped_rollback_service "$service_name"',
      "persist_rollback_router_mode_offline maintenance",
      "contain_rollback_scheduled_containers",
      "pause-schedulers.sh",
      "contain_rollback_scheduled_containers",
    ]);
    expect(watchdog).toContain('local parent_pid="$rollback_watchdog_parent_pid"');
    expect(watchdog).toContain('local watchdog_pid="$BASHPID"');
    expect(watchdog).toContain('"/proc/$watchdog_pid/status"');
    expect(watchdog).toContain('[[ "$observed_parent_pid" == "$parent_pid" ]]');
    expect(watchdog).toContain('kill -0 "$parent_pid"');
    expect(watchdog).toContain(
      'rollback_watchdog_marker_is_valid "$rollback_watchdog_disarm_file"',
    );
    expect(watchdog).toContain("contain_parentless_rollback");
    expect(arm).toContain('rollback_watchdog_parent_pid="$BASHPID"');
    expect(arm).toContain("rollback_sigkill_watchdog_main &");
    expect(arm).toContain('rollback_watchdog_pid="$!"');
    expect(disarm).toContain("write_protected_rollback_watchdog_marker");
    expect(disarm).toContain('wait "$rollback_watchdog_pid"');
    expectOrdered(acceptedFlow, [
      "arm_rollback_sigkill_watchdog",
      "activate_rollback_router_live",
      'mv -- "$rollback_evidence_temporary" "$rollback_evidence_file"',
      'sync -f -- "$(dirname -- "$rollback_evidence_file")"',
      "commit_rollback_router_active",
      "disarm_rollback_sigkill_watchdog",
      'rollback_containment_armed="false"',
    ]);
  });

  it("keeps the preview token ephemeral, same-origin, upstream-stripped, and credential-redacted", () => {
    const router = between(compose, "  release_router:\n", "\n  app:\n");
    const acceptance = between(compose, "  release_acceptance:\n", "\n  backup:\n");

    expect(router).not.toContain("BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN");
    expect(router).not.toMatch(/^\s+environment:/m);
    expect(router).not.toMatch(/^\s+secrets:/m);
    expect(activeCaddyfile).not.toContain("header_up -Authorization");
    expect(maintenanceCaddyfile).toContain("header_up -Authorization");
    expect(maintenanceCaddyfile).toContain('@candidate_preview header Authorization "Bearer ');
    expect(externalEdge).not.toContain("log_credentials");
    expect(containerEdge).not.toContain("log_credentials");
    expect(externalEdge).not.toContain("Release-Acceptance");
    expect(containerEdge).not.toContain("Release-Acceptance");
    expect(playwright).not.toContain("extraHTTPHeaders");
    expect(playwright).not.toContain("PLAYWRIGHT_RELEASE_ACCEPTANCE_TOKEN");
    expect(releaseAcceptance).toContain(
      "requestURL.origin === acceptanceBaseURL.origin",
    );
    expect(releaseAcceptance).toContain(
      "resolved.origin !== acceptanceBaseURL.origin",
    );
    expect(releaseAcceptance).toContain(
      "name.toLowerCase() !== acceptanceHeaderLower",
    );
    expect(releaseAcceptance).toContain('const acceptanceHeader = "Authorization"');
    expect(releaseAcceptance).toContain('`Bearer ${releaseAcceptanceToken}`');
    expect(occurrences(releaseAcceptance, /maxRedirects: 0/g)).toBe(3);
    expect(releaseGate).toContain("installReleaseAcceptanceRoute(contextA)");
    expect(releaseGate).toContain("installReleaseAcceptanceRoute(contextB)");
    expect(releaseGate).toContain("installReleaseAcceptanceRoute(contextC)");
    expect(releaseGate).not.toMatch(/\.request\.(?:get|post|delete)\(/);
    expect(fiscalPeriodGate).toContain("installReleaseAcceptanceRoute(context)");
    expect(fiscalPeriodGate).toContain("releaseGet(page.request, demoHref)");
    expect(fiscalPeriodGate).not.toMatch(/\.request\.(?:get|post|delete)\(/);
    expect(acceptance).toContain("PLAYWRIGHT_RELEASE_ACCEPTANCE_TOKEN:");
    expect(acceptance).toContain("/app/test-results:size=256m");
    expect(acceptance).toContain("/app/playwright-report:size=64m");
    expect(acceptance).not.toMatch(/source:\s+.*(?:test-results|playwright-report)/);
  });

  it("does not recreate the stable router during routine production or development releases", () => {
    const productionBuild = between(
      release,
      'stage="candidate-image-build"',
      '\nrun_logged 10-image-build.log',
    );
    expectOrdered(productionBuild, [
      'if [[ "$mode" == "release" ]]; then',
      '[[ -z "$release_router_prebuild_query" ]] || router_was_preexisting="true"',
      'read_docker_output "pre-build stable release-router image" image ls',
      'if [[ -n "$release_router_prebuild_image_id" ]]; then',
      '"Reusing the existing separately versioned release-router image without rebuilding its shared tag."',
      "else",
      "run_logged 10-release-router-build.log compose_release_router_build build",
      '--build-arg "SOURCE_DATE_EPOCH=$release_router_source_date_epoch" release_router',
    ]);
    expect(occurrences(release, /compose_release_router_build build/g)).toBe(1);

    const productionBootstrap = between(
      release,
      'if [[ "$router_was_preexisting" != "true" ]]; then',
      '\nstage="pre-migration-backup"',
    );
    const productionRouterStarts = release.match(
      /compose up --detach --wait --no-deps --no-build release_router/g,
    ) ?? [];
    expect(productionRouterStarts).toHaveLength(1);
    expect(productionBootstrap).toContain(productionRouterStarts[0]);
    expect(release).not.toMatch(/(?:force-recreate[^\n]*release_router|release_router[^\n]*force-recreate)/);

    const productionAppUpLines = release
      .split("\n")
      .filter((line) => /compose .*\bup\b.*\bapp\b/.test(line));
    expect(productionAppUpLines.length).toBeGreaterThan(0);
    for (const line of productionAppUpLines) expect(line).toContain("--no-deps");

    expect(occurrences(
      development,
      /compose up --detach --wait --no-deps --no-build release_router/g,
    )).toBe(3);
    const developmentRecovery = between(
      development,
      "restore_accepted_revision() {",
      "\nrun_public_acceptance() {",
    );
    expect(developmentRecovery).toContain(
      "compose up --detach --wait --no-deps --no-build release_router",
    );
    const developmentDeployment = development.slice(
      development.indexOf('candidate_topology="$(revision_release_topology'),
    );
    expect(developmentDeployment).toMatch(
      /if \[\[ "\$source_topology" == legacy \]\]; then[\s\S]*?compose up --detach --wait --no-deps --no-build release_router/,
    );
    expect(development).toContain(
      '[[ "$(running_release_router_container)" == "$persistent_release_router_id" ]]',
    );
    const developmentAppUpLines = development
      .split("\n")
      .filter((line) => /compose .*\bup\b.*\bapp\b/.test(line));
    expect(developmentAppUpLines.length).toBeGreaterThan(0);
    for (const line of developmentAppUpLines) expect(line).toContain("--no-deps");

    const candidateRouter = between(candidateImages, "  release_router:\n", "\n  database:\n");
    expect(candidateRouter).toContain("BUSINESS_FINLYNQ_RELEASE_ROUTER_IMAGE");
    expect(candidateRouter).toContain("build: !reset null");

    for (const consumer of [
      release,
      rollback,
      development,
      externalVerifier,
      productionMonitor,
      initialInstaller,
    ]) {
      expect(consumer).toContain('release_router_reference="business-finlynq-release-router:v2"');
      expect(consumer).toContain('release_router_revision="release-router-v2"');
      expect(consumer).toContain('release_router_contract="v2"');
    }
    expect(release).toContain('release_router_source_date_epoch="1788998400"');
    expect(development).toContain('release_router_source_date_epoch="1788998400"');
    expect(release).toContain("sha256sum Caddyfile Caddyfile.maintenance entrypoint.sh");
    expect(development).toContain(
      '"$candidate_revision:deploy/release/router/$relative_path"',
    );
  });

  it("fails Compose verification when stable-router ownership or isolation drifts", () => {
    for (const contract of [
      "release router must use its separately versioned stable image",
      "external application alias must belong only to release_router",
      "loopback application port must belong only to release_router",
      "release router state is not limited to its dedicated non-secret durable mode volume",
      "release router liveness is not distinct from application/public liveness",
      "release router does not use the fail-closed durable-state entrypoint",
      "release-router stop grace is shorter than its Caddy graceful shutdown window",
      "development does not preserve the isolated release-router topology",
    ]) {
      expect(boundaryVerifier).toContain(contract);
    }
  });
});
