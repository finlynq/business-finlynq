import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(__dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8").replaceAll("\r\n", "\n");
}

function renderAppEnvironment(
  composeFiles: string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const composeArguments = composeFiles.flatMap((path) => ["-f", resolve(repositoryRoot, path)]);
  const rendered = execFileSync("docker", [
    "compose",
    "--project-name", "business-finlynq-render-contract",
    "--project-directory", repositoryRoot,
    "--env-file", resolve(repositoryRoot, ".env.example"),
    ...composeArguments,
    "config", "--format", "json",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const configuration = JSON.parse(rendered) as {
    services?: { app?: { environment?: Record<string, string> } };
  };
  const appEnvironment = configuration.services?.app?.environment;
  if (!appEnvironment) throw new Error("Rendered Compose configuration has no app environment");
  return appEnvironment;
}

function writeChecksums(directory: string): void {
  const checksums = readdirSync(directory)
    .filter((name) => name !== "SHA256SUMS")
    .sort()
    .map((name) => {
      const digest = createHash("sha256").update(readFileSync(join(directory, name))).digest("hex");
      return `${digest}  ./${name}`;
    });
  writeFileSync(join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
}

function writeAcceptedRehearsal(directory: string, revision: string, runId: string): void {
  const writeJson = (name: string, value: unknown) => writeFileSync(join(directory, name), `${JSON.stringify(value)}\n`);
  const appImageId = `sha256:${"a".repeat(64)}`;
  const databaseImageId = `sha256:${"6".repeat(64)}`;
  const migratorImageId = `sha256:${"b".repeat(64)}`;
  const authWorkerImageId = `sha256:${"c".repeat(64)}`;
  const operationsImageId = `sha256:${"d".repeat(64)}`;
  const acceptanceImageId = `sha256:${"5".repeat(64)}`;
  const startedAt = "2026-08-31T12:00:00Z";
  const completedAt = "2026-08-31T12:15:00Z";
  const gitTreeManifest = `100644 blob ${"1".repeat(40)}\tdocker-compose.yml\n`;
  const stagedTreeManifest = `${"2".repeat(64)}  ./docker-compose.yml\n`;
  writeFileSync(join(directory, "03-candidate-git-tree.txt"), gitTreeManifest);
  writeFileSync(join(directory, "04-staged-tree-sha256.txt"), stagedTreeManifest);
  const checkpoint = (stage: string) => ({
    schemaVersion: 1,
    product: "business-finlynq",
    mode: "rehearsal",
    revision,
    candidateTreeId: "3".repeat(40),
    gitTreeManifestSha256: createHash("sha256").update(gitTreeManifest).digest("hex"),
    stagedTreeManifestSha256: createHash("sha256").update(stagedTreeManifest).digest("hex"),
    runId,
    stage,
    completedAt,
  });
  writeJson("00-release-plan.json", {
    schemaVersion: 1,
    product: "business-finlynq",
    status: "started",
    startedAt,
    cleanEnvironment: true,
    mode: "rehearsal",
    revision,
    candidateTreeId: "3".repeat(40),
    gitTreeManifestSha256: createHash("sha256").update(gitTreeManifest).digest("hex"),
    stagedTreeManifestSha256: createHash("sha256").update(stagedTreeManifest).digest("hex"),
    runId,
    composeProject: `business-finlynq-${runId}`,
    composeConfigurationSha256: "e".repeat(64),
    acceptanceBaseUrl: "http://127.0.0.1:3200",
  });
  writeJson("02-clean-environment.json", checkpoint("clean-environment-confirmed"));
  writeJson("11-images.json", {
    schemaVersion: 1,
    pinnedComposeConfigurationSha256: "4".repeat(64),
    images: [
      { name: "database", reference: `business-finlynq-database:${revision}`, imageId: databaseImageId, ociRevision: revision },
      { name: "app", reference: `business-finlynq-app:${revision}`, imageId: appImageId, ociRevision: revision },
      { name: "migrator", reference: `business-finlynq-migrator:${revision}`, imageId: migratorImageId, ociRevision: revision },
      { name: "authWorker", reference: `business-finlynq-auth-worker:${revision}`, imageId: authWorkerImageId, ociRevision: revision },
      { name: "operations", reference: `business-finlynq-operations:${revision}`, imageId: operationsImageId, ociRevision: revision },
      { name: "acceptance", reference: `business-finlynq-acceptance:${revision}`, imageId: acceptanceImageId, ociRevision: revision },
    ],
  });
  const writeContainerWaitEvidence = (
    name: string,
    description: string,
    services: ReadonlyArray<readonly [string, string]>,
  ) => writeJson(name, {
    schemaVersion: 1,
    product: "business-finlynq",
    description,
    waitTransportStatus: 0,
    logsCaptured: true,
    cleanupAttempted: false,
    containers: services.map(([service, imageId], index) => ({
      service,
      containerId: (index + 1).toString(16).repeat(64),
      expectedImageId: imageId,
      actualImageId: imageId,
      waitResult: 0,
      inspectionSucceeded: true,
      status: "exited",
      running: false,
      exitCode: 0,
      oomKilled: false,
      errorPresent: false,
      finalQuiescent: true,
    })),
  });
  writeContainerWaitEvidence("51-pretraffic-containers.json", "pre-traffic verification", [
    ["provision_auth_worker_role", operationsImageId],
    ["migrate", migratorImageId],
    ["reconcile_runtime_grants", operationsImageId],
    ["reconcile_auth_worker_grants", operationsImageId],
    ["reconcile_backup_grants", operationsImageId],
    ["verify_database_contract", migratorImageId],
    ["verify_accounting_evidence", operationsImageId],
  ]);
  writeContainerWaitEvidence("56-bootstrap-container.json", "demo bootstrap", [
    ["bootstrap_demo", migratorImageId],
  ]);
  writeContainerWaitEvidence(
    "59-post-bootstrap-accounting-container.json",
    "post-bootstrap accounting verifier",
    [["verify_accounting_evidence_post_bootstrap", operationsImageId]],
  );
  writeContainerWaitEvidence("70-browser-acceptance-container.json", "browser acceptance", [
    ["release_acceptance", acceptanceImageId],
  ]);
  const databaseUse = {
    schemaVersion: 1,
    product: "business-finlynq",
    service: "database",
    verifiedAt: completedAt,
    revision,
    imageId: databaseImageId,
  };
  writeJson("29-rehearsal-database-image.json", databaseUse);
  writeJson("35-database-image.json", databaseUse);
  writeJson("12-rollback-artifact.json", {
    schemaVersion: 1,
    previous: null,
    candidate: { imageId: appImageId, revision },
    databaseRollback: "forward-repair-only",
    rollbackTool: "deploy/release/run-application-rollback.sh",
  });
  writeJson("26-write-surfaces-stopped.json", checkpoint("write-surfaces-stopped-before-backup"));
  writeJson("33-backup-evidence.json", {
    schemaVersion: 1,
    product: "business-finlynq",
    createdAt: startedAt,
    applicationRevision: revision,
    sourceApplicationRevision: revision,
    backupToolRevision: revision,
    encryptedArchive: "business_finlynq_20260831T120000Z_business_finlynq.dump.age",
    encryptedBytes: 1234,
    sha256: "f".repeat(64),
    encryption: "age",
    format: "postgres-custom",
  });
  writeJson("53-pretraffic-verification.json", {
    schemaVersion: 1,
    completedAt,
    trafficBlocked: true,
    databaseRollback: "forward-repair-only",
    postBootstrapAccountingEvidenceVerified: true,
    services: [
      { service: "provision_auth_worker_role", exitCode: 0, imageId: operationsImageId },
      { service: "migrate", exitCode: 0, imageId: migratorImageId },
      { service: "reconcile_runtime_grants", exitCode: 0, imageId: operationsImageId },
      { service: "reconcile_auth_worker_grants", exitCode: 0, imageId: operationsImageId },
      { service: "reconcile_backup_grants", exitCode: 0, imageId: operationsImageId },
      { service: "verify_database_contract", exitCode: 0, imageId: migratorImageId },
      { service: "verify_accounting_evidence", exitCode: 0, imageId: operationsImageId },
      { service: "bootstrap_demo", exitCode: 0, imageId: migratorImageId },
      { service: "verify_accounting_evidence_post_bootstrap", exitCode: 0, imageId: operationsImageId },
    ],
  });
  const disabledChecks = {
    database: "ready",
    organizationKey: "ready",
    identityKey: "ready",
    accountAuthentication: "disabled",
    accountSignup: "disabled",
    emailWorker: "disabled",
    bankFeeds: "disabled",
  };
  writeJson("61-quiesced-readiness.json", { status: "ready", revision, checks: disabledChecks });
  writeJson("64-internal-readiness.json", { status: "ready", revision, checks: disabledChecks });
  writeJson("65-public-readiness.json", { status: "ready" });
  writeFileSync(join(directory, "65-public-readiness.headers"), "HTTP/1.1 200 OK\nCache-Control: no-store\n");
  const browserLog = "browser acceptance passed\n";
  writeFileSync(join(directory, "70-browser-acceptance.log"), browserLog);
  writeJson("71-browser-acceptance.json", checkpoint("browser-acceptance-passed"));
  writeJson("73-final-readiness.json", { status: "ready", revision, checks: disabledChecks });
  for (const name of [
    "01-clean-environment.log", "10-image-build.log", "10-operations-image-content.log",
    "25-stop-write-surfaces.log",
    "29-rehearsal-database-start.log", "34-database-start.log",
    "30-provision-backup-role.log", "31-encrypted-backup.log", "32-backup-verification.log",
    "49-pretraffic-reset.log", "50-pretraffic-up.log", "51-pretraffic-wait.log",
    "52-pretraffic-services.log", "54-bootstrap-reset.log", "55-bootstrap-up.log",
    "56-bootstrap-wait.log", "56-bootstrap-services.log",
    "57-post-bootstrap-accounting-reset.log",
    "58-post-bootstrap-accounting-up.log", "59-post-bootstrap-accounting-wait.log",
    "59-post-bootstrap-accounting-services.log",
    "60-quiesced-app-start.log", "63-app-start.log",
    "72-final-app-start.log", "80-clean-rehearsal.log",
  ]) writeFileSync(join(directory, name), `${name} passed\n`);
  writeJson("90-release-complete.json", {
    schemaVersion: 1,
    product: "business-finlynq",
    browserAcceptancePassed: true,
    browserLogSha256: createHash("sha256").update(browserLog).digest("hex"),
    candidateAppImageId: appImageId,
    previousAppImageId: null,
    completedAt,
    databaseRollback: "forward-repair-only",
    mode: "rehearsal",
    preTrafficDatabaseContractVerified: true,
    postBootstrapAccountingEvidenceVerified: true,
    revision,
    runId,
    status: "accepted",
  });
  writeChecksums(directory);
}

describe("commit-addressed release orchestration", () => {
  it("puts migration, every grant reconciler, schema/grant verification, and journal verification before bootstrap", () => {
    const compose = source("docker-compose.yml");
    expect(compose).toContain("verify_database_contract:");
    expect(compose).toContain("verify_accounting_evidence:");
    expect(compose).toContain("npm run db:verify-schema && npm run journal-types:verify-db");
    expect(compose).toMatch(/verify_database_contract:[\s\S]*?depends_on:[\s\S]*?reconcile_backup_grants:[\s\S]*?condition: service_completed_successfully/);
    expect(compose).toMatch(/bootstrap_demo:[\s\S]*?depends_on:[\s\S]*?verify_database_contract:[\s\S]*?condition: service_completed_successfully/);

    for (const image of ["database", "app", "migrator", "auth-worker", "operations", "acceptance"]) {
      expect(compose).toContain(`business-finlynq-${image}:\${BUSINESS_FINLYNQ_IMAGE_REVISION:?set BUSINESS_FINLYNQ_IMAGE_REVISION}`);
    }
    expect(compose).toContain('"127.0.0.1:${BUSINESS_FINLYNQ_APP_PORT:-3100}:3000"');
    expect(compose).not.toContain("BUSINESS_FINLYNQ_APP_BIND_ADDRESS");

    const rehearsal = source("deploy/release/docker-compose.rehearsal.yml");
    for (const suffix of ["pgdata", "caddy-data", "caddy-config", "private", "egress", "edge", "restore-drill"]) {
      expect(rehearsal).toContain(`\${RELEASE_REHEARSAL_PROJECT:?set RELEASE_REHEARSAL_PROJECT}-${suffix}`);
    }

    const pinned = source("deploy/release/docker-compose.candidate-images.yml");
    for (const service of [
      "database", "app", "auth_email_worker", "migrate", "verify_database_contract", "bootstrap_demo",
      "provision_auth_worker_role", "reconcile_runtime_grants", "reconcile_auth_worker_grants",
      "provision_backup", "reconcile_backup_grants", "backup", "verify_latest_backup",
      "verify_accounting_evidence",
      "release_acceptance",
    ]) {
      expect(pinned).toMatch(new RegExp(`^  ${service}:$`, "m"));
    }
    expect(pinned.match(/build: !reset null/g)).toHaveLength(15);
    expect(pinned.match(/pull_policy: never/g)).toHaveLength(15);
  });

  it("runs release browser acceptance in a secretless hardened container", () => {
    const compose = source("docker-compose.yml");
    const boundaryVerifier = source("scripts/operations/verify-compose-boundaries.mjs");
    const start = compose.indexOf("  release_acceptance:\n");
    const end = compose.indexOf("\n  invite_account:\n", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const service = compose.slice(start, end);

    expect(service).toContain("profiles: [acceptance]");
    expect(service).toContain("target: acceptance");
    expect(service).toContain(
      'command: ["./node_modules/.bin/playwright", "test", "--output", "/app/test-results/release"]',
    );
    expect(service).toContain('PLAYWRIGHT_MANAGED_SERVER: "true"');
    expect(service).toContain("PLAYWRIGHT_HTML_OUTPUT_DIR: /app/playwright-report/release");
    expect(service).toContain("- /app/test-results:size=256m,mode=1777");
    expect(service).toContain("- /app/playwright-report:size=64m,mode=1777");
    expect(service).not.toContain('command: ["./node_modules/.bin/playwright", "test"]');
    expect(service).toContain("user: pwuser");
    expect(service).toContain("network_mode: host");
    expect(service).toContain("read_only: true");
    expect(service).toContain("no-new-privileges:true");
    expect(service).toContain("cap_drop: [ALL]");
    expect(service).toContain("shm_size: 512m");
    expect(service).not.toMatch(/^\s+secrets:/m);
    expect(service).not.toMatch(/^\s+volumes:/m);
    expect(service).not.toMatch(/^\s+ports:/m);
    expect(boundaryVerifier).toContain("isStrictNormalizedChild");
    expect(boundaryVerifier).toContain(
      'isStrictNormalizedChild("/app/test-results", acceptanceResultsDirectory)',
    );
    expect(boundaryVerifier).toContain(
      'isStrictNormalizedChild("/app/playwright-report", acceptanceHtmlDirectory)',
    );
    expect(boundaryVerifier).toContain("acceptanceTmpfsTargets.includes(outputDirectory)");
    expect(boundaryVerifier).toContain(
      "release browser acceptance output directory may not be a tmpfs mountpoint",
    );
  });

  it("adds the insecure-loopback marker pair only to the rehearsal Compose render", () => {
    const productionEnvironment = renderAppEnvironment(["docker-compose.yml"]);
    const rehearsalEnvironment = renderAppEnvironment(
      ["docker-compose.yml", "deploy/release/docker-compose.rehearsal.yml"],
      {
        RELEASE_REHEARSAL_PROJECT: "business-finlynq-rehearsal-render-contract",
        BUSINESS_FINLYNQ_APP_ORIGIN: "http://127.0.0.1:3201",
        BUSINESS_FINLYNQ_APP_PORT: "3201",
        SESSION_COOKIE_NAME: "business_finlynq_rehearsal_session",
      },
    );

    expect(rehearsalEnvironment).toMatchObject({
      ALLOW_INSECURE_TEST_ORIGIN: "true",
      BUSINESS_FINLYNQ_TEST_CONTEXT: "playwright",
    });
    expect(productionEnvironment).not.toHaveProperty("ALLOW_INSECURE_TEST_ORIGIN");
    expect(productionEnvironment).not.toHaveProperty("BUSINESS_FINLYNQ_TEST_CONTEXT");
  });

  it("embeds the full revision in every release-owned image and retains both backup revision meanings", () => {
    const dockerfile = source("Dockerfile");
    expect(dockerfile.match(/LABEL org\.opencontainers\.image\.revision=\$BUSINESS_FINLYNQ_IMAGE_REVISION/g)).toHaveLength(6);
    expect(dockerfile).toContain(
      "FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS acceptance",
    );
    expect(dockerfile).toContain('CMD ["./node_modules/.bin/playwright", "test"]');
    expect(dockerfile).toContain("install -d -m 0555 /usr/local/share/business-finlynq");

    const continuousIntegration = source(".github/workflows/ci.yml");
    expect(continuousIntegration).toContain(
      "test -r /usr/local/share/business-finlynq/accounting-evidence-query.sql",
    );

    const backup = source("deploy/backup/run-backup.sh");
    expect(backup).toContain('BACKUP_TOOL_REVISION="$BUSINESS_FINLYNQ_IMAGE_REVISION"');
    expect(backup).toContain('sourceApplicationRevision: $sourceApplicationRevision');
    expect(backup).toContain('backupToolRevision: $backupToolRevision');
    expect(backup).toContain('applicationRevision: $revision');
  });

  it("keeps the scripted production sequence fail closed and produces a retained rollback record", () => {
    const release = source("deploy/release/run-release.sh");
    const pauseSchedulers = source("deploy/release/pause-schedulers.sh");
    const pause = release.indexOf('stage="pause-schedulers"');
    const backup = release.indexOf('stage="pre-migration-backup"');
    const stopWrites = release.indexOf('stage="stop-write-surfaces"');
    const migrate = release.indexOf('stage="pre-traffic-migration-and-contract-verification"');
    const start = release.indexOf('stage="candidate-readiness-with-writes-disabled"');
    const browser = release.indexOf('stage="browser-acceptance"');
    const finalWrites = release.indexOf('stage="activate-reviewed-write-gates"');
    const resume = release.indexOf('stage="resume-schedulers"');
    expect([pause, stopWrites, backup, migrate, start, browser, finalWrites, resume].every((position) => position >= 0)).toBe(true);
    expect(pause).toBeLessThan(stopWrites);
    expect(stopWrites).toBeLessThan(backup);
    expect(backup).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(start);
    expect(start).toBeLessThan(browser);
    expect(browser).toBeLessThan(finalWrites);
    expect(finalWrites).toBeLessThan(resume);
    expect(browser).toBeLessThan(resume);
    expect(release).toContain("They remain paused; do not re-enable writes");
    expect(release).toContain('compose_timed 20s logs --no-color --timestamps --tail 200 database');
    expect(release).toContain('98-rehearsal-database.log');
    expect(release).toContain('[REDACTED]');
    const failureCapture = release.indexOf("    capture_rehearsal_database_failure");
    const failureCleanup = release.indexOf("    rehearsal_cleanup", failureCapture);
    expect(failureCapture).toBeGreaterThanOrEqual(0);
    expect(failureCleanup).toBeGreaterThan(failureCapture);
    expect(release).toContain("    capture_rehearsal_database_failure || true");
    const databaseActivation = release.indexOf('stage="activate-reviewed-database-image"');
    expect(databaseActivation).toBeGreaterThan(release.indexOf('run_logged 32-backup-verification.log'));
    expect(databaseActivation).toBeLessThan(release.indexOf('stage="pre-traffic-migration-and-contract-verification"'));
    expect(release).toContain('record_running_database_image "$evidence_directory/29-rehearsal-database-image.json"');
    expect(release).toContain('record_running_database_image "$evidence_directory/35-database-image.json"');
    expect(release).toContain("12-rollback-artifact.json");
    expect(release).toContain("SHA256SUMS");
    expect(release).toContain("10-operations-image-content.log");
    expect(release).toContain(
      "test -r /usr/local/share/business-finlynq/accounting-evidence-query.sql",
    );
    expect(release).toContain('compose --profile operations rm --force --stop "${pretraffic_services[@]}"');
    expect(release).toContain("verify_database_contract verify_accounting_evidence");
    expect(release).toContain('stage="post-bootstrap-accounting-verification"');
    expect(release).toContain("capture_compose_container_id() {");
    expect(release).toContain("wait_for_captured_containers() {");
    expect(release).toContain('timeout --signal=TERM --kill-after="$captured_container_kill_after"');
    expect(release).toContain('"$captured_container_wait_duration"');
    expect(release).toContain('env -i "PATH=$PATH" docker wait "${container_ids[@]}"');
    expect(release).toContain('env -i "PATH=$PATH" docker stop --time 10 "${container_ids[@]}"');
    expect(release).toContain('env -i "PATH=$PATH" docker kill "${remaining_ids[@]}"');
    expect(release).toContain("containers could not be proven quiescent after failure");
    expect(release).toContain('compose_timed "$captured_container_log_duration"');
    expect(release).toContain("51-pretraffic-containers.json");
    expect(release).toContain("56-bootstrap-container.json");
    expect(release).toContain("59-post-bootstrap-accounting-container.json");
    expect(release).toContain("70-browser-acceptance-container.json");
    expect(release).toContain("wait returned an unexpected number of results");
    expect(release).toContain('"errorPresent":{{if .State.Error}}true{{else}}false{{end}}');
    expect(release).toContain('"${observed_statuses[$index]}" == "exited"');
    expect(release).toContain('"${observed_error_present[$index]}" == "false"');
    expect(release).toContain("are retained before a wait or state failure can trigger containment.");
    expect(release.match(/wait_for_captured_containers/g)).toHaveLength(5);
    expect(release).toContain("51-pretraffic-wait.log wait_for_captured_containers");
    expect(release).toContain("56-bootstrap-wait.log wait_for_captured_containers");
    expect(release).toContain("59-post-bootstrap-accounting-wait.log wait_for_captured_containers");
    expect(release).toContain('wait_for_captured_containers "browser acceptance" - 70-browser-acceptance-container.json');
    expect(release).toContain('release_acceptance "$browser_container" "${image_ids[acceptance]}" --');
    expect(release).not.toMatch(/compose_timed 30m(?: --profile [a-z-]+)? wait/);
    expect(release).toContain('service: "verify_accounting_evidence_post_bootstrap"');
    expect(release).toContain("postBootstrapAccountingEvidenceVerified: true");
    expect(release).toContain("compose rm --force --stop bootstrap_demo");
    expect(release).not.toContain("--force-recreate verify_database_contract");
    expect(release).toContain('run_quiesced_app() (');
    expect(release).toContain('run_acceptance_app() (');
    expect(release).toContain('compose_with_overrides BUSINESS_WRITES_ENABLED=false BANK_FEEDS_ENABLED=false --');
    expect(release).toContain('AUTH_EMAIL_DELIVERY_ENABLED=false SIGNUP_TURNSTILE_ENABLED=false');
    expect(release).toContain('previous_container="$(compose ps --all --quiet app)"');
    expect(release).toContain('for _ in {1..30}; do');
    expect(release).toContain('public readiness did not become ready (last HTTP ${public_status:-unavailable})');
    expect(release).toContain('quiesced candidate gate is not disabled: $disabled_gate');
    expect(release.indexOf('rehearsal resource can escape its isolated project')).toBeLessThan(release.indexOf('stage="clean-rehearsal-environment"'));
    expect(release).toContain('if [[ "$mode" == "release" && "$schedulers_resumed" == "true" ]]');
    expect(release).toContain('if pause_schedulers allow-already-paused >/dev/null 2>&1; then');
    expect(release).toContain('[[ "$app_port" == "3100" ]]');
    expect(release).toContain('[[ "$app_port" != "3100" ]]');
    expect(release).toContain('[[ "$repository_root" == "/home/deploy/business-finlynq" ]]');
    expect(release).toContain('[[ "$operations_environment_file" == "/etc/business-finlynq/operations.env" ]]');
    expect(release).toContain('[[ "$operations_environment_file" == "/home/deploy/.config/business-finlynq/operations.env" ]]');
    expect(release).toContain("cron scheduler mode must run as the exact deploy account");
    expect(release).toContain("cron operations environment must be owned by the deploy account");
    expect(release).toContain('reject_repository_path "$environment_file" "Compose environment"');
    expect(release).toContain('reject_repository_path "$operations_environment_file" "operations environment"');
    expect(release).toContain('reject_repository_path "$evidence_root" "evidence root"');
    expect(release).toContain('reject_repository_path "$backup_directory" "backup directory"');
    expect(release).toContain("the checkout changed after release evidence initialization and before image build");
    expect(release).toContain("the checkout changed while commit-addressed images were being built");
    expect(release).toContain('acquire_release_coordination_lock "production-release-rollback.lock"');
    expect(release).toContain('acquire_release_coordination_lock "rehearsal-$compose_project.lock"');
    expect(release).toContain("another release, rehearsal for this project, or rollback already holds the coordination lock");
    expect(release).toContain('MONITOR_EXPECT_OUTBOX_PUBLISHER="$(read_operations_value MONITOR_EXPECT_OUTBOX_PUBLISHER)"');
    expect(release).toContain('SCHEDULED_BACKUP_TIMEOUT_SECONDS="$(read_operations_value SCHEDULED_BACKUP_TIMEOUT_SECONDS)"');
    expect(release).toContain('compose_timed_with_overrides "${release_backup_timeout_seconds}s"');
    expect(release).toContain('cleanup_failed_backup_containers');
    expect(release).toContain("operations backup runtime settings exceed the reviewed recovery envelope");
    expect(release).toMatch(/for command_name in [^\n]*\bsed\b/);
    expect(release).toContain(
      "/usr/local/bin/business-finlynq-check-latest-backup --emit-evidence",
    );
    expect(release).toContain("compose --profile operations run --rm --no-deps -T");
    expect(release).toContain("immutable backup verifier did not emit exactly one evidence record");
    expect(release).toContain("BUSINESS_FINLYNQ_BACKUP_EVIDENCE=");
    expect(release).toContain(
      'keys == ["applicationRevision", "backupToolRevision", "createdAt",',
    );
    expect(release).toContain(
      '"schemaVersion", "sha256", "sourceApplicationRevision"] and',
    );
    expect(release).not.toContain("latest_backup_manifest");
    expect(release).not.toContain('find "$backup_directory"');
    expect(release).toContain('read_operations_value BUSINESS_FINLYNQ_IMAGE_REVISION');
    expect(release).toContain('operations_environment_sha256="$(sha256sum "$canonical_operations_environment_file"');
    expect(release).toContain("canonical operations environment changed during release; schedulers remain paused");
    expect(release).toContain("canonical operations image revision changed before scheduler resume");
    expect(release).toContain("run_installed_monitor");
    expect(release).toContain("run_installed_accounting_evidence");
    expect(release).toContain(
      "run_fresh_systemd_oneshot business-finlynq-accounting-evidence.service",
    );
    expect(release).toContain('bash "$repository_root/deploy/cron/run-job.sh" accounting-evidence');
    expect(release).toContain("run_fresh_systemd_oneshot business-finlynq-monitor.service");
    expect(release).toContain('bash "$repository_root/deploy/cron/run-job.sh" monitor');
    expect(release).toContain("ExecMainStartTimestampMonotonic");
    expect(release).toContain("ExecMainExitTimestampMonotonic");
    expect(release).toContain('"$current_start" != "$previous_start"');
    expect(release).toContain('"$current_exit" -gt "$current_start"');
    expect(release).toContain('status_directory="/home/deploy/.local/state/business-finlynq/cron/job-status"');
    expect(release).toContain('"$(stat -c \'%u:%a\' -- "$status_file")" == "$deploy_uid:600"');
    expect(release).toContain(
      'keys == ["completedAtUnixtime", "job", "product", "result", "schemaVersion"] and',
    );
    expect(release).toContain('.job == $job and .result == "succeeded"');
    expect(release).toContain('. >= $startedAt and . <= $now');
    expect(release).toContain('verify_fresh_cron_job_status accounting-evidence "$started_at"');
    expect(release).toContain('verify_fresh_cron_job_status monitor "$started_at"');
    expect(release).toContain("clear_cron_job_status() {");
    expect(release).toContain('clear_cron_job_status accounting-evidence');
    expect(release).toContain('clear_cron_job_status monitor');
    expect(release).toContain('existing cron $job_name completion record is unsafe');
    expect(release).toContain('[[ ! -e "$status_file" && ! -L "$status_file" ]]');
    expect(release).toContain('release_metric_file="$(read_operations_value "$environment_key")"');
    expect(release).toContain('|| fail "$description has unsafe ownership or mode"');
    expect(release).toContain("was not freshly replaced by release acceptance");
    expect(release).toContain(
      'business_finlynq_accounting_evidence_verification_last_success_unixtime',
    );
    expect(release).toContain('verify_fresh_accounting_metrics "$started_at"');
    expect(release).toContain(
      "clear_release_metric_file ACCOUNTING_EVIDENCE_METRICS_FILE",
    );
    expect(release).toContain("clear_release_metric_file MONITOR_METRICS_FILE");
    expect(release).toContain('verify_fresh_host_monitor_metrics "$started_at"');
    expect(release).toContain("business_finlynq_host_monitor_success");
    expect(release).toContain("business_finlynq_host_monitor_last_run_unixtime");
    expect(release).toContain("83-production-monitor.json");
    expect(release.indexOf('schedulers_resumed="true"')).toBeLessThan(
      release.indexOf("run_logged 80-resume-schedulers.log resume_schedulers"),
    );
    expect(release.slice(release.indexOf('schedulers_resumed="true"')))
      .not.toContain('schedulers_resumed="false"');
    const schedulerResume = release.indexOf("run_logged 80-resume-schedulers.log resume_schedulers");
    const accountingSeed = release.indexOf(
      "run_logged 81-accounting-evidence-seed.log run_installed_accounting_evidence",
    );
    const monitorAcceptance = release.indexOf(
      "run_logged 82-production-monitor.log run_installed_monitor",
    );
    const boundaryRecord = release.indexOf('stage="record-scheduler-boundary-version"');
    expect(schedulerResume).toBeLessThan(accountingSeed);
    expect(accountingSeed).toBeLessThan(monitorAcceptance);
    expect(monitorAcceptance).toBeLessThan(boundaryRecord);
    expect(release).not.toContain("run_logged 82-production-monitor.log bash deploy/monitoring/check-production.sh");
    expect(release).not.toMatch(/docker compose[^\n]*pull/);
    expect(release).toContain('git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root"');
    expect(release).toContain('archive --format=tar "$revision"');
    expect(release.match(/git --no-optional-locks/g)).toHaveLength(7);
    expect(release).toContain('--project-directory "$candidate_source_root"');
    expect(release).toContain('env -i "${controlled_environment[@]}" docker compose');
    expect(release).toContain('env -i "PATH=$PATH" bash --noprofile --norc -c');
    expect(release).toContain('unset "$2"');
    expect(release).toContain('install -m 0600 -- "$canonical_environment_file" "$environment_snapshot_file"');
    expect(release).toContain('install -m 0600 -- "$canonical_operations_environment_file" "$operations_environment_snapshot_file"');
    expect(release).toContain('candidateTreeId: $candidateTreeId');
    expect(release).toContain('BUSINESS_FINLYNQ_RELEASE_OPERATIONS_IMAGE=${image_ids[operations]}');
    expect(release).toContain('BUSINESS_FINLYNQ_RELEASE_MIGRATOR_IMAGE=${image_ids[migrator]}');
    expect(release).toContain('BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_IMAGE=${image_ids[acceptance]}');
    expect(release).toContain('"acceptance=business-finlynq-acceptance:$revision"');
    expect(release).toContain('capture_compose_container_id "browser-acceptance container"');
    expect(release).toContain('browser acceptance did not use the immutable reviewed image');
    expect(release).toContain('compose --profile acceptance rm --force --stop release_acceptance');
    expect(release).not.toContain('$repository_root/node_modules');
    expect(release).not.toMatch(/\bnpm run test:e2e\b/);
    expect(release).toContain("verify_scheduler_boundary_bootstrap");
    expect(release).toContain("the first scheduler-boundary rollout requires the protected pre-checkout bootstrap receipt");
    expect(release).toContain('[[ "$scheduler_boundary_bootstrap_source_revision" == "$previous_app_revision" ]]');
    expect(release).toContain('--allow-already-paused');
    expect(release).toContain("record_scheduler_boundary_version");
    expect(release).toContain('--expected-cron-schedule "$previous_cron_schedule_file"');
    expect(pauseSchedulers).toContain("inactive|failed) break");
    expect(pauseSchedulers).toContain("active|activating|deactivating|reloading) sleep 10");
    expect(pauseSchedulers).toContain("scheduled service returned an empty state");
    expect(pauseSchedulers).toContain("scheduled service returned an unknown state");
    expect(pauseSchedulers).toContain("scheduled service did not reach an explicit terminal state");
    expect(pauseSchedulers).toContain("systemctl disable --now");
    expect(pauseSchedulers).toContain("activate_maintenance_marker");
    expect(pauseSchedulers).toContain('deploy_gid="$(id -g deploy 2>/dev/null)"');
    expect(pauseSchedulers).toContain(
      '"$(stat -c \'%u:%g:%a\' -- "$marker_file")" == "$deploy_uid:$deploy_gid:600"',
    );
    expect(pauseSchedulers).toContain('chown -- "$deploy_uid:$deploy_gid" "$marker_temporary"');
    expect(pauseSchedulers).not.toContain('chown -- "$deploy_uid" "$marker_temporary"');
    expect(pauseSchedulers).toContain("contain_orphaned_scheduled_containers");
    expect(pauseSchedulers).toContain("remove_exact_deploy_cron_if_present");
    expect(pauseSchedulers).toContain("/tmp/business-finlynq-cron-pause.XXXXXX");

    const rollback = source("deploy/release/run-application-rollback.sh");
    expect(rollback).toContain("ROLLBACK_SCHEMA_COMPATIBLE_ACK");
    expect(rollback).toContain('--scheduler must be systemd or cron');
    expect(rollback).toContain('bash "$candidate_source_root/deploy/release/pause-schedulers.sh" "$scheduler_mode"');
    expect(rollback).toContain('authentication worker remains active during rollback');
    expect(rollback).toContain("sha256sum --check --strict SHA256SUMS");
    expect(rollback).toContain('[[ ! -L "$completion_record" ]]');
    expect(rollback).toContain('[[ ! -L "$failure_record" ]]');
    expect(rollback).toContain('.mode == "release"');
    expect(rollback).toContain('[[ "$evidence_revision" == "$candidate_revision" ]]');
    expect(rollback).toContain("completed release and rollback artifact identify different previous images");
    expect(rollback).toContain("completed release and rollback artifact identify different candidate images");
    expect(rollback).toContain('[[ "$environment_file" == "/etc/business-finlynq/compose.env" ]]');
    expect(rollback).toContain("cron rollback must run as the exact deploy account");
    expect(rollback).toContain("cron rollback Compose environment must be owned by the deploy account");
    expect(rollback).toContain("canonical Compose environment does not identify the candidate release");
    expect(rollback).toContain('rendered_current_compose="$(base_compose config --format json)"');
    expect(rollback).toContain("canonical Compose configuration does not bind the candidate app image");
    expect(rollback).not.toContain('source "$1"');
    expect(rollback).toMatch(/if \[\[ "\$current_app_image_id" == "\$candidate_image_id"[\s\S]*?elif \[\[ "\$current_app_image_id" == "\$previous_image_id"/);
    expect(rollback).toContain('observed_application_artifact="previous"');
    expect(rollback).toContain("deployed app container matches neither the evidence candidate nor retained previous artifact");
    expect(rollback).toContain("observedApplicationRuntimeStatus");
    expect(rollback).toContain('coordination_lock_file="$coordination_lock_directory/production-release-rollback.lock"');
    expect(rollback).toContain("another production release or rollback already holds the coordination lock");
    expect(rollback).toContain('read_git_output "candidate HEAD" rev-parse HEAD');
    expect(rollback).toContain('[[ "$git_command_output" == "$candidate_revision" ]]');
    expect(rollback).toContain("rollback checkout is not clean");
    expect(rollback).toContain("DEMO_WRITES_ENABLED=false");
    expect(rollback).toContain("SIGNUP_TURNSTILE_ENABLED=false");
    expect(rollback).toContain("BUSINESS_WRITES_ENABLED=false");
    expect(rollback).toContain('for disabled_gate in DEMO_LOGIN_ENABLED DEMO_WRITES_ENABLED ACCOUNT_LOGIN_ENABLED');
    expect(rollback).toContain('allLoginDeliveryWriteAndFeedGatesDisabled: true');
    expect(rollback).toContain('schedulersPaused: true');
    expect(rollback).toContain('trap contain_failed_rollback EXIT');
    expect(rollback).toContain('git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root"');
    expect(rollback).toContain('archive --format=tar "$candidate_revision"');
    expect(rollback.match(/git --no-optional-locks/g)).toHaveLength(5);
    expect(rollback).toContain('canonical Compose environment changed during rollback acceptance');
    expect(rollback).not.toMatch(/db:migrate|down migration|docker compose down/);

    expect(source("deploy/release/pause-schedulers.sh")).toContain(
      "cron scheduler pause must run as the exact deploy account",
    );
    expect(source("deploy/release/resume-schedulers.sh")).toContain(
      "cron scheduler resume must run as the exact deploy account",
    );
    expect(source("deploy/cron/install.sh")).toContain(
      "installation must run as the exact deploy account",
    );
    expect(source("deploy/cron/remove.sh")).toContain(
      "removal must run as the exact deploy account",
    );
    expect(source("deploy/cron/run-job.sh")).toContain(
      "scheduled jobs must run as the exact deploy account",
    );
    expect(source("deploy/cron/run-job.sh")).toContain(
      'PATH="/home/deploy/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    );
    expect(source("deploy/cron/run-job.sh")).toContain("Cron checkout status could not be inspected");

    const schedulerBootstrap = source("deploy/release/bootstrap-scheduler-boundary.sh");
    expect(schedulerBootstrap).toContain("/tmp/business-finlynq-release-bootstrap.*/repository");
    expect(schedulerBootstrap).toContain('show "$candidate_revision:$relative_path"');
    expect(schedulerBootstrap).toContain("SCHEDULER_BOUNDARY_BOOTSTRAP_ACK");
    expect(schedulerBootstrap).toContain('--expected-cron-schedule "$deployed_schedule"');
    expect(schedulerBootstrap).toContain('scheduler-boundary-bootstrap.json');
  });

  it.skipIf(process.platform === "win32")(
    "waits on captured IDs, retains state evidence, and force-quiesces adversarial outcomes",
    () => {
      const release = source("deploy/release/run-release.sh");
      const helperStart = release.indexOf('captured_container_wait_duration="30m"');
      const helperEnd = release.indexOf("\nrehearsal_cleanup() {", helperStart);
      expect(helperStart).toBeGreaterThanOrEqual(0);
      expect(helperEnd).toBeGreaterThan(helperStart);
      const helper = release.slice(helperStart, helperEnd);
      const root = mkdtempSync(join(tmpdir(), "business-finlynq-captured-wait-"));
      const firstContainerId = "1".repeat(64);
      const secondContainerId = "2".repeat(64);
      const expectedImage = `sha256:${"a".repeat(64)}`;

      const runCase = (mode: string, multiple = false) => {
        const caseRoot = join(root, `${mode}-${multiple ? "multi" : "single"}`);
        const fakeBin = join(caseRoot, "bin");
        const evidenceDirectory = join(caseRoot, "evidence");
        const stopped = join(caseRoot, "stopped").replaceAll("\\", "/");
        const killed = join(caseRoot, "killed").replaceAll("\\", "/");
        const dockerLog = join(caseRoot, "docker.log").replaceAll("\\", "/");
        const serviceMarker = join(caseRoot, "service-logs-retained").replaceAll("\\", "/");
        const stateEvidence = join(evidenceDirectory, "51-state.json");
        const expectedIds = multiple
          ? `${firstContainerId} ${secondContainerId}`
          : firstContainerId;
        mkdirSync(fakeBin, { recursive: true });
        mkdirSync(evidenceDirectory, { recursive: true });
        const actualImage = mode === "wrong-image" ? `sha256:${"b".repeat(64)}` : expectedImage;
        const exitCode = mode === "fast-nonzero" ? 7 : 0;
        const running = mode === "timeout" || mode === "stop-still-running";
        const state = JSON.stringify({
          image: actualImage,
          status: running ? "running" : "exited",
          running,
          exitCode,
          oomKilled: mode === "state-reject",
          errorPresent: false,
        });
        writeFileSync(join(fakeBin, "docker"), `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >>'${dockerLog}'
command_name="\${1:-}"
shift || true
case "$command_name" in
  wait)
    [[ -z "\${DOCKER_HOST+x}" ]] || exit 91
    [[ "$*" == '${expectedIds}' ]] || exit 92
    case '${mode}' in
      fast-nonzero|stop-failure) printf '%s\\n' 7 ;;
      malformed) printf '%s\\n' not-an-exit-code ;;
      timeout) sleep 2 ;;
      *)
        printf '%s\\n' 0
        ${multiple ? "printf '%s\\n' 0" : ":"}
        ;;
    esac
    ;;
  inspect)
    [[ '${mode}' != removed ]] || exit 1
    if [[ '${mode}' == inspect-timeout ]]; then sleep 2; fi
    printf '%s\\n' '${state}'
    ${multiple ? `printf '%s\\n' '${state}'` : ":"}
    ;;
  stop)
    [[ "$*" == '--time 10 ${expectedIds}' ]] || exit 94
    if [[ '${mode}' == stop-failure ]]; then exit 42; fi
    : >'${stopped}'
    ;;
  kill)
    : >'${killed}'
    : >'${stopped}'
    ;;
  ps)
    case '${mode}' in
      timeout)
        [[ -e '${stopped}' ]] || printf '%s\\n' '${firstContainerId}'
        ;;
      stop-failure)
        [[ -e '${killed}' ]] || printf '%s\\n' '${firstContainerId}'
        ;;
      stop-still-running)
        [[ -e '${killed}' ]] || printf '%s\\n' '${firstContainerId}'
        ;;
    esac
    ;;
  *) exit 95 ;;
esac
`);
        chmodSync(join(fakeBin, "docker"), 0o755);
        const normalizedEvidence = evidenceDirectory.replaceAll("\\", "/");
        const secondContract = multiple
          ? `second_service '${secondContainerId}' '${expectedImage}'`
          : "";
        const harness = `
set -Eeuo pipefail
PATH='${fakeBin.replaceAll("\\", "/")}:/usr/bin:/bin'
evidence_directory='${normalizedEvidence}'
fail() { printf '%s\\n' "$1" >&2; exit 1; }
run_logged() {
  local filename="$1"; shift
  local status=0
  if "$@" >"$evidence_directory/$filename" 2>&1; then status=0; else status=$?; fi
  return "$status"
}
fake_service_logs() { printf '%s\\n' retained; : >'${serviceMarker}'; }
compose_timed() {
  local duration="$1"; shift
  if [[ '${mode}' == logs-timeout ]]; then
    : >'${serviceMarker}'
    return 124
  fi
  "$@"
}
${helper}
captured_container_wait_duration=0.2s
captured_container_kill_after=0.1s
captured_container_log_duration=0.2s
captured_container_inspect_duration=0.2s
wait_for_captured_containers 'test operation' service.log 51-state.json \
  first_service '${firstContainerId}' '${expectedImage}' \
  ${secondContract} -- fake_service_logs
`;
        return {
          dockerLog,
          serviceMarker,
          stopped,
          killed,
          stateEvidence,
          result: spawnSync("bash", ["-c", harness], {
            encoding: "utf8",
            env: { ...process.env, DOCKER_HOST: "tcp://poison.invalid:2375" },
          }),
        };
      };

      try {
        for (const mode of ["success", "poisoned-environment"] as const) {
          const execution = runCase(mode);
          expect(execution.result.status, execution.result.stderr).toBe(0);
          expect(readFileSync(execution.dockerLog, "utf8")).toContain(`wait ${firstContainerId}`);
          expect(existsSync(execution.serviceMarker)).toBe(true);
          const evidence = JSON.parse(readFileSync(execution.stateEvidence, "utf8")) as {
            cleanupAttempted: boolean;
            containers: Array<{ finalQuiescent: boolean; actualImageId: string }>;
          };
          expect(evidence.cleanupAttempted).toBe(false);
          expect(evidence.containers).toEqual([
            expect.objectContaining({ finalQuiescent: true, actualImageId: expectedImage }),
          ]);
        }

        const multiple = runCase("success", true);
        expect(multiple.result.status, multiple.result.stderr).toBe(0);
        const multipleEvidence = JSON.parse(readFileSync(multiple.stateEvidence, "utf8")) as {
          containers: Array<{ containerId: string }>;
        };
        expect(multipleEvidence.containers.map(({ containerId }) => containerId))
          .toEqual([firstContainerId, secondContainerId]);
        expect(readFileSync(multiple.dockerLog, "utf8"))
          .toContain(`wait ${firstContainerId} ${secondContainerId}`);

        for (const mode of [
          "fast-nonzero",
          "malformed",
          "wrong-image",
          "removed",
          "state-reject",
          "logs-timeout",
          "inspect-timeout",
        ] as const) {
          const execution = runCase(mode);
          expect(execution.result.status).not.toBe(0);
          expect(existsSync(execution.serviceMarker)).toBe(true);
          expect(existsSync(execution.stateEvidence)).toBe(true);
        }

        const timedOut = runCase("timeout");
        expect(timedOut.result.status).not.toBe(0);
        expect(timedOut.result.stderr).toContain("wait exceeded its 30-minute bound");
        expect(existsSync(timedOut.serviceMarker)).toBe(true);
        expect(existsSync(timedOut.stopped)).toBe(true);
        expect(readFileSync(timedOut.dockerLog, "utf8"))
          .toContain(`stop --time 10 ${firstContainerId}`);

        for (const mode of ["stop-failure", "stop-still-running"] as const) {
          const execution = runCase(mode);
          expect(execution.result.status).not.toBe(0);
          expect(existsSync(execution.killed)).toBe(true);
          expect(readFileSync(execution.dockerLog, "utf8")).toContain(`kill ${firstContainerId}`);
          const evidence = JSON.parse(readFileSync(execution.stateEvidence, "utf8")) as {
            cleanupAttempted: boolean;
            containers: Array<{ finalQuiescent: boolean }>;
          };
          expect(evidence.cleanupAttempted).toBe(true);
          expect(evidence.containers[0]?.finalQuiescent).toBe(true);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("arms a complete re-pause before attempting a guarded scheduler resume", () => {
    const resume = source("deploy/release/resume-schedulers.sh");
    expect(resume).toContain("trap contain_partial_resume EXIT");
    expect(resume).toContain('pause-schedulers.sh" "$scheduler_mode" --allow-already-paused');
    expect(resume.indexOf('resume_complete="true"')).toBeGreaterThan(resume.indexOf('rm -- "$marker_file"'));
    expect(resume.indexOf('rm -- "$marker_file"')).toBeGreaterThan(resume.indexOf('systemctl enable --now'));
  });

  it.skipIf(process.platform === "win32")(
    "cannot reuse a same-second cron status and refuses unsafe status records",
    () => {
      const release = source("deploy/release/run-release.sh");
      const extractFunction = (name: string, nextName: string): string => {
        const start = release.indexOf(`${name}() {`);
        const end = release.indexOf(`\n${nextName}() {`, start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        return release.slice(start, end);
      };
      const root = mkdtempSync(join(tmpdir(), "business-finlynq-cron-acceptance-"));
      const statusDirectory = join(root, "job-status").replaceAll("\\", "/");
      const adapt = (value: string) => value
        .replaceAll(
          "/home/deploy/.local/state/business-finlynq/cron/job-status",
          statusDirectory,
        )
        .replaceAll('deploy_uid="$(id -u deploy)"', 'deploy_uid="$(id -u)"');
      const clearFunction = adapt(extractFunction(
        "clear_cron_job_status",
        "verify_fresh_accounting_metrics",
      ));
      const verifyFunction = adapt(extractFunction(
        "verify_fresh_cron_job_status",
        "clear_cron_job_status",
      ));
      const result = spawnSync("/bin/bash", ["-c", `
set -Eeuo pipefail
fail() { printf '%s\\n' "$1" >&2; exit 1; }
${verifyFunction}
${clearFunction}
install -d -m 0700 -- '${statusDirectory}'
started_at="$(date +%s)"
printf '{"completedAtUnixtime":%s,"job":"monitor","product":"business-finlynq","result":"succeeded","schemaVersion":1}\\n' \
  "$started_at" >'${statusDirectory}/monitor.json'
chmod 0600 -- '${statusDirectory}/monitor.json'
clear_cron_job_status monitor
[[ ! -e '${statusDirectory}/monitor.json' && ! -L '${statusDirectory}/monitor.json' ]]
if (verify_fresh_cron_job_status monitor "$started_at") >/dev/null 2>&1; then
  printf '%s\\n' 'same-second stale status was accepted after the wrapper skipped' >&2
  exit 1
fi
printf '{"completedAtUnixtime":%s,"job":"monitor","product":"business-finlynq","result":"succeeded","schemaVersion":1}\\n' \
  "$(date +%s)" >'${statusDirectory}/monitor.json'
chmod 0600 -- '${statusDirectory}/monitor.json'
verify_fresh_cron_job_status monitor "$started_at" >/dev/null
chmod 0644 -- '${statusDirectory}/monitor.json'
if (clear_cron_job_status monitor) >/dev/null 2>&1; then
  printf '%s\\n' 'wrong-mode status was deleted' >&2
  exit 1
fi
[[ -f '${statusDirectory}/monitor.json' ]]
rm -- '${statusDirectory}/monitor.json'
printf '%s\\n' 'do-not-delete' >'${root.replaceAll("\\", "/")}/target'
ln -s -- '${root.replaceAll("\\", "/")}/target' '${statusDirectory}/monitor.json'
if (clear_cron_job_status monitor) >/dev/null 2>&1; then
  printf '%s\\n' 'symbolic status was accepted' >&2
  exit 1
fi
[[ -L '${statusDirectory}/monitor.json' ]]
[[ "$(cat -- '${root.replaceAll("\\", "/")}/target')" == 'do-not-delete' ]]
`], { encoding: "utf8" });

      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "requires a fresh systemd execution and newly written monitor metrics",
    () => {
      const release = source("deploy/release/run-release.sh");
      const extractFunction = (name: string, nextName: string): string => {
        const start = release.indexOf(`${name}() {`);
        const end = release.indexOf(`\n${nextName}() {`, start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        return release.slice(start, end);
      };
      const root = mkdtempSync(join(tmpdir(), "business-finlynq-systemd-acceptance-"));
      const fakeBin = join(root, "bin");
      const metricsDirectory = join(root, "metrics");
      const metricsFile = join(metricsDirectory, "host.prom");
      mkdirSync(fakeBin);
      mkdirSync(metricsDirectory, { mode: 0o775 });
      chmodSync(metricsDirectory, 0o775);
      const currentUid = process.getuid?.() ?? 1000;
      const currentGid = process.getgid?.() ?? 1000;
      const normalizedMetricsFile = metricsFile.replaceAll("\\", "/");
      const helpers = [
        extractFunction("read_systemd_property", "run_fresh_systemd_oneshot"),
        extractFunction("run_fresh_systemd_oneshot", "verify_fresh_cron_job_status"),
        extractFunction("resolve_release_metric_file", "assert_release_metric_path_safety"),
        extractFunction("assert_release_metric_path_safety", "clear_release_metric_file"),
        extractFunction("clear_release_metric_file", "read_unique_release_metric"),
        extractFunction("read_unique_release_metric", "verify_fresh_metric_file"),
        extractFunction("verify_fresh_metric_file", "verify_fresh_accounting_metrics"),
        extractFunction("verify_fresh_host_monitor_metrics", "run_installed_monitor"),
      ].join("\n");

      writeFileSync(join(fakeBin, "id"), `#!/usr/bin/env bash
case "$*" in
  "-u deploy") printf '%s\\n' '${currentUid}' ;;
  "-g deploy") printf '%s\\n' '${currentGid}' ;;
  *) /usr/bin/id "$@" ;;
esac
`);
      writeFileSync(join(fakeBin, "systemctl"), `#!/usr/bin/env bash
case "$1" in
  start)
    : >"$FAKE_SYSTEMD_STARTED_MARKER"
    exit 0
    ;;
  show)
    [[ "$*" != *"--no-pager"* ]] || exit 0
    property=""
    for argument in "$@"; do
      case "$argument" in --property=*) property="\${argument#--property=}" ;; esac
    done
    case "$property" in
      ExecMainStartTimestampMonotonic)
        case "$FAKE_SYSTEMD_MODE" in
          zero) printf '%s\\n' 0 ;;
          unchanged) printf '%s\\n' 111 ;;
          changed) [[ -e "$FAKE_SYSTEMD_STARTED_MARKER" ]] && printf '%s\\n' 333 || printf '%s\\n' 111 ;;
          *) exit 91 ;;
        esac
        ;;
      ExecMainExitTimestampMonotonic)
        case "$FAKE_SYSTEMD_MODE" in
          zero) printf '%s\\n' 1 ;;
          unchanged) printf '%s\\n' 222 ;;
          changed) printf '%s\\n' 444 ;;
          *) exit 92 ;;
        esac
        ;;
      Result) printf '%s\\n' success ;;
      ExecMainStatus) printf '%s\\n' 0 ;;
      *) exit 93 ;;
    esac
    ;;
  *) exit 94 ;;
esac
`);
      chmodSync(join(fakeBin, "id"), 0o755);
      chmodSync(join(fakeBin, "systemctl"), 0o755);

      const commonScript = `
set -Eeuo pipefail
fail() { printf '%s\\n' "$1" >&2; exit 1; }
read_operations_value() {
  [[ "$1" == MONITOR_METRICS_FILE ]] || exit 97
  printf '%s' "$FAKE_MONITOR_METRICS_FILE"
}
systemd_property_value=""
release_metric_file=""
metric_value=""
${helpers}
`;
      const runSystemdCase = (mode: "zero" | "unchanged" | "changed", script: string) => {
        const startedMarker = join(root, `${mode}.started`).replaceAll("\\", "/");
        return spawnSync("/bin/bash", ["-c", `${commonScript}\n${script}`], {
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_MONITOR_METRICS_FILE: normalizedMetricsFile,
            FAKE_SYSTEMD_MODE: mode,
            FAKE_SYSTEMD_STARTED_MARKER: startedMarker,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
        });
      };

      for (const mode of ["zero", "unchanged"] as const) {
        const rejected = runSystemdCase(mode, `
printf '%s\\n' 'stale metric' >'${normalizedMetricsFile}'
chmod 0644 -- '${normalizedMetricsFile}'
clear_release_metric_file MONITOR_METRICS_FILE /var/lib/business-finlynq/host.prom 'host-monitor metric'
[[ ! -e '${normalizedMetricsFile}' && ! -L '${normalizedMetricsFile}' ]]
run_fresh_systemd_oneshot business-finlynq-monitor.service 'systemd monitor acceptance'
`);
        expect(rejected.status).not.toBe(0);
        expect(rejected.stderr).toContain("did not execute a fresh systemd invocation");
      }

      const accepted = runSystemdCase("changed", `
printf '%s\\n' 'unsafe old metric' >'${normalizedMetricsFile}'
chmod 0600 -- '${normalizedMetricsFile}'
if (clear_release_metric_file MONITOR_METRICS_FILE /var/lib/business-finlynq/host.prom 'host-monitor metric') >/dev/null 2>&1; then
  printf '%s\\n' 'wrong-mode metric was cleared' >&2
  exit 1
fi
[[ -f '${normalizedMetricsFile}' ]]
chmod 0644 -- '${normalizedMetricsFile}'
clear_release_metric_file MONITOR_METRICS_FILE /var/lib/business-finlynq/host.prom 'host-monitor metric'
started_at="$(date +%s)"
run_fresh_systemd_oneshot business-finlynq-monitor.service 'systemd monitor acceptance'
write_metric() {
  local success="$1" last_run="$2"
  printf 'business_finlynq_host_monitor_success %s\\n' "$success" >'${normalizedMetricsFile}'
  printf 'business_finlynq_host_monitor_last_run_unixtime %s\\n' "$last_run" >>'${normalizedMetricsFile}'
  chmod 0644 -- '${normalizedMetricsFile}'
}
write_metric 1 "$(date +%s)"
verify_fresh_host_monitor_metrics "$started_at"
printf '%s\\n' 'business_finlynq_host_monitor_success 1' >>'${normalizedMetricsFile}'
if (verify_fresh_host_monitor_metrics "$started_at") >/dev/null 2>&1; then
  printf '%s\\n' 'duplicate metric was accepted' >&2
  exit 1
fi
write_metric 1 not-an-integer
if (verify_fresh_host_monitor_metrics "$started_at") >/dev/null 2>&1; then
  printf '%s\\n' 'noninteger metric was accepted' >&2
  exit 1
fi
write_metric 1 "$(date +%s)"
chmod 0600 -- '${normalizedMetricsFile}'
if (verify_fresh_host_monitor_metrics "$started_at") >/dev/null 2>&1; then
  printf '%s\\n' 'wrong-mode metric was accepted' >&2
  exit 1
fi
write_metric 1 "$((started_at - 1))"
touch --date="@$((started_at - 1))" '${normalizedMetricsFile}'
if (verify_fresh_host_monitor_metrics "$started_at") >/dev/null 2>&1; then
  printf '%s\\n' 'stale metric was accepted' >&2
  exit 1
fi
`);
      expect(accepted.status, accepted.stderr).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")("fails closed when the scheduled boundary cannot inspect Git status", () => {
    const root = mkdtempSync(join(tmpdir(), "business-finlynq-git-status-fault-"));
    const fakeBin = join(root, "bin");
    const repository = join(root, "repository");
    mkdirSync(fakeBin);
    mkdirSync(repository);
    const boundaryPath = join(root, "check-scheduler-boundary.sh");
    writeFileSync(boundaryPath, source("deploy/systemd/check-scheduler-boundary.sh")
      .replace(
        'readonly maintenance_marker="/home/deploy/.local/state/business-finlynq/release-locks/scheduler-maintenance"',
        `readonly maintenance_marker="${join(root, "maintenance").replaceAll("\\", "/")}"`,
      )
      .replace(
        'readonly repository_root="/home/deploy/business-finlynq"',
        `readonly repository_root="${repository.replaceAll("\\", "/")}"`,
      ));
    chmodSync(boundaryPath, 0o755);
    const revision = "a".repeat(40);
    writeFileSync(join(fakeBin, "git"), `#!/usr/bin/env bash
case "$*" in
  *"rev-parse HEAD"*) printf '%s\\n' '${revision}' ;;
  *"status --porcelain=v1"*) exit 23 ;;
  *) exit 24 ;;
esac
`);
    chmodSync(join(fakeBin, "git"), 0o755);
    const result = spawnSync("bash", [boundaryPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        BUSINESS_FINLYNQ_IMAGE_REVISION: revision,
        MONITOR_MAINTENANCE_SCHEDULER: "systemd",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("canonical checkout status could not be inspected");
  });

  it.skipIf(process.platform === "win32")("creates a deploy-grouped root containment marker", () => {
    const root = mkdtempSync(join(tmpdir(), "business-finlynq-scheduler-upgrade-"));
    const fakeBin = join(root, "bin");
    const markerDirectory = join(root, "release-locks");
    const markerFile = join(markerDirectory, "scheduler-maintenance");
    const callLog = join(root, "systemctl.log");
    const chownLog = join(root, "chown.log");
    const dockerFailureMarker = join(root, "docker-fail");
    mkdirSync(fakeBin);
    mkdirSync(markerDirectory, { mode: 0o700 });
    chmodSync(markerDirectory, 0o700);
    const currentUid = process.getuid?.() ?? 1000;
    const currentGid = process.getgid?.() ?? 1000;
    const normalizedMarkerDirectory = markerDirectory.replaceAll("\\", "/");
    const normalizedMarkerFile = markerFile.replaceAll("\\", "/");
    const normalizedDockerFailureMarker = dockerFailureMarker.replaceAll("\\", "/");
    const pausePath = join(root, "pause-schedulers.sh");
    writeFileSync(pausePath, source("deploy/release/pause-schedulers.sh").replace(
      'marker_directory="/home/deploy/.local/state/business-finlynq/release-locks"',
      `marker_directory="${normalizedMarkerDirectory}"`,
    ));
    chmodSync(pausePath, 0o755);
    writeFileSync(join(fakeBin, "id"), `#!/usr/bin/env bash
case "$*" in
  "-u deploy") printf '%s\\n' '${currentUid}' ;;
  "-g deploy") printf '%s\\n' '${currentGid}' ;;
  "-u") printf '%s\\n' 0 ;;
  *) /usr/bin/id "$@" ;;
esac
`);
    writeFileSync(join(fakeBin, "chown"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_CHOWN_LOG"
exit 0
`);
    writeFileSync(join(fakeBin, "stat"), `#!/usr/bin/env bash
if [[ "\${FAKE_MARKER_WRONG_GROUP:-false}" == true \
  && "$*" == "-c %u:%g:%a -- ${normalizedMarkerFile}" ]]; then
  printf '%s\\n' '${currentUid}:99999:600'
  exit 0
fi
exec /usr/bin/stat "$@"
`);
    writeFileSync(join(fakeBin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(fakeBin, "runuser"), `#!/usr/bin/env bash
printf '%s\\n' 'no crontab for deploy' >&2
exit 1
`);
    writeFileSync(join(fakeBin, "docker"), `#!/usr/bin/env bash
if [[ -e "${normalizedDockerFailureMarker}" && "$1" == ps ]]; then
  exit 24
fi
exit 0
`);
    writeFileSync(join(fakeBin, "systemctl"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_SYSTEMCTL_LOG"
unit="\${@: -1}"
case "$1" in
  show)
    property=""
    for argument in "$@"; do
      case "$argument" in --property=*) property="\${argument#--property=}" ;; esac
    done
    if [[ "$unit" == business-finlynq-accounting-evidence.* ]]; then
      [[ "$property" == LoadState ]] && printf '%s\\n' not-found && exit 0
    fi
    if [[ "\${FAKE_SYSTEMD_READ_ERROR:-false}" == true && "$property" == ActiveState ]]; then
      exit 19
    fi
    case "$property" in
      LoadState) printf '%s\\n' loaded ;;
      ActiveState) printf '%s\\n' inactive ;;
      UnitFileState) printf '%s\\n' disabled ;;
      *) exit 20 ;;
    esac
    ;;
  disable|stop) exit 0 ;;
  is-active) exit 1 ;;
  *) exit 0 ;;
esac
`);
    for (const command of ["id", "chown", "stat", "sleep", "runuser", "docker", "systemctl"]) {
      chmodSync(join(fakeBin, command), 0o755);
    }

    const accepted = spawnSync("bash", [pausePath, "systemd", "--allow-already-paused"], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CHOWN_LOG: chownLog,
        FAKE_SYSTEMCTL_LOG: callLog,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("schedulers are paused and drained");
    const calls = readFileSync(callLog, "utf8");
    expect(readFileSync(chownLog, "utf8")).toContain(
      `-- ${currentUid}:${currentGid} ${normalizedMarkerDirectory}/.scheduler-maintenance.`,
    );
    expect(calls).not.toContain("disable --now business-finlynq-accounting-evidence.timer");
    expect(calls).toContain("show --property=LoadState --value business-finlynq-accounting-evidence.timer");

    const wrongGroupRejected = spawnSync("bash", [pausePath, "systemd", "--allow-already-paused"], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CHOWN_LOG: chownLog,
        FAKE_MARKER_WRONG_GROUP: "true",
        FAKE_SYSTEMCTL_LOG: callLog,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    expect(wrongGroupRejected.status).toBe(1);
    expect(wrongGroupRejected.stderr).toContain("existing scheduler maintenance marker is unsafe");

    const rejected = spawnSync("bash", [pausePath, "systemd", "--allow-already-paused"], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CHOWN_LOG: chownLog,
        FAKE_SYSTEMCTL_LOG: callLog,
        FAKE_SYSTEMD_READ_ERROR: "true",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("could not query systemd ActiveState");

    writeFileSync(dockerFailureMarker, "fail\n");
    const dockerRejected = spawnSync("bash", [pausePath, "systemd", "--allow-already-paused"], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CHOWN_LOG: chownLog,
        FAKE_SYSTEMCTL_LOG: callLog,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    expect(dockerRejected.status).toBe(1);
    expect(dockerRejected.stderr).toContain("could not query running scheduled containers");
  });

  it.skipIf(process.platform === "win32")("fails closed when crontab cannot be read and retains the installed block", () => {
    const root = mkdtempSync(join(tmpdir(), "business-finlynq-crontab-read-fault-"));
    const fakeBin = join(root, "bin");
    const repository = join(root, "repository");
    const cronDirectory = join(repository, "deploy", "cron");
    const stateDirectory = join(root, "state");
    mkdirSync(fakeBin);
    mkdirSync(cronDirectory, { recursive: true });
    mkdirSync(stateDirectory);
    const schedule = source("deploy/cron/managed-crontab");
    const schedulePath = join(cronDirectory, "managed-crontab");
    const spool = join(root, "spool");
    writeFileSync(schedulePath, schedule);
    writeFileSync(spool, schedule);

    const removePath = join(cronDirectory, "remove.sh");
    writeFileSync(removePath, source("deploy/cron/remove.sh").replace(
      'readonly state_dir="/home/deploy/.local/state/business-finlynq/cron"',
      `readonly state_dir="${stateDirectory.replaceAll("\\", "/")}"`,
    ));
    chmodSync(removePath, 0o755);
    writeFileSync(join(fakeBin, "id"), `#!/usr/bin/env bash
case "$*" in
  "-un") printf '%s\n' deploy ;;
  "-u deploy"|"-u") printf '%s\n' 1000 ;;
  *) exit 2 ;;
esac
`);
    writeFileSync(join(fakeBin, "crontab"), `#!/usr/bin/env bash
if [[ "$1" == "-l" ]]; then
  cat "$FAKE_CRONTAB_SPOOL"
  printf '%s\n' 'permission denied while reading spool' >&2
  exit 2
fi
printf '%s\n' write-attempt >>"$FAKE_CRONTAB_WRITE_LOG"
cp "$1" "$FAKE_CRONTAB_SPOOL"
`);
    chmodSync(join(fakeBin, "id"), 0o755);
    chmodSync(join(fakeBin, "crontab"), 0o755);
    const writeLog = join(root, "writes.log");
    const result = spawnSync("bash", [removePath, "--require-managed", "--expected-schedule", schedulePath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CRONTAB_SPOOL: spool,
        FAKE_CRONTAB_WRITE_LOG: writeLog,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("crontab could not be read safely");
    expect(readFileSync(spool, "utf8")).toBe(schedule);
    expect(() => readFileSync(writeLog, "utf8")).toThrow();
  });

  it("validates the structural contract for two independent checksummed rehearsal records", () => {
    const root = mkdtempSync(join(tmpdir(), "business-finlynq-release-evidence-"));
    const first = join(root, "rehearsal-first");
    const second = join(root, "rehearsal-second");
    execFileSync(process.execPath, ["-e", "const fs=require('fs'); fs.mkdirSync(process.argv[1]); fs.mkdirSync(process.argv[2]);", first, second]);
    const revision = "a".repeat(40);
    writeAcceptedRehearsal(first, revision, "rehearsal-first");
    writeAcceptedRehearsal(second, revision, "rehearsal-second");

    const verifier = resolve(repositoryRoot, "scripts/operations/verify-release-rehearsals.mjs");
    expect(execFileSync(process.execPath, [verifier, first, second], { encoding: "utf8" }))
      .toContain(`Two independent clean release rehearsals accepted for ${revision}`);

    const databaseEvidencePath = join(second, "35-database-image.json");
    const databaseEvidence = JSON.parse(readFileSync(databaseEvidencePath, "utf8")) as Record<string, unknown>;
    databaseEvidence.imageId = `sha256:${"7".repeat(64)}`;
    writeFileSync(databaseEvidencePath, `${JSON.stringify(databaseEvidence)}\n`);
    writeChecksums(second);
    const databaseRejected = spawnSync(process.execPath, [verifier, first, second], { encoding: "utf8" });
    expect(databaseRejected.status).not.toBe(0);
    expect(databaseRejected.stderr).toContain("does not prove use of the reviewed database image");

    writeAcceptedRehearsal(second, revision, "rehearsal-second");
    const waitEvidencePath = join(second, "51-pretraffic-containers.json");
    const waitEvidence = JSON.parse(readFileSync(waitEvidencePath, "utf8")) as {
      containers: Array<{ finalQuiescent: boolean }>;
    };
    waitEvidence.containers[0]!.finalQuiescent = false;
    writeFileSync(waitEvidencePath, `${JSON.stringify(waitEvidence)}\n`);
    writeChecksums(second);
    const waitRejected = spawnSync(process.execPath, [verifier, first, second], { encoding: "utf8" });
    expect(waitRejected.status).not.toBe(0);
    expect(waitRejected.stderr).toContain("51-pretraffic-containers.json has invalid container evidence");

    writeAcceptedRehearsal(second, revision, "rehearsal-second");
    writeFileSync(join(second, "90-release-complete.json"), "{}\n");
    const rejected = spawnSync(process.execPath, [verifier, first, second], { encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("Release rehearsal evidence verification failed");
  });
});
