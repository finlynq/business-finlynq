import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(__dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8").replaceAll("\r\n", "\n");
}

function writeAcceptedRehearsal(directory: string, revision: string, runId: string): void {
  const writeJson = (name: string, value: unknown) => writeFileSync(join(directory, name), `${JSON.stringify(value)}\n`);
  const appImageId = `sha256:${"a".repeat(64)}`;
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
      { name: "app", reference: `business-finlynq-app:${revision}`, imageId: appImageId, ociRevision: revision },
      { name: "migrator", reference: `business-finlynq-migrator:${revision}`, imageId: migratorImageId, ociRevision: revision },
      { name: "authWorker", reference: `business-finlynq-auth-worker:${revision}`, imageId: authWorkerImageId, ociRevision: revision },
      { name: "operations", reference: `business-finlynq-operations:${revision}`, imageId: operationsImageId, ociRevision: revision },
      { name: "acceptance", reference: `business-finlynq-acceptance:${revision}`, imageId: acceptanceImageId, ociRevision: revision },
    ],
  });
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
    "01-clean-environment.log", "10-image-build.log", "25-stop-write-surfaces.log",
    "29-rehearsal-database-start.log",
    "30-provision-backup-role.log", "31-encrypted-backup.log", "32-backup-verification.log",
    "49-pretraffic-reset.log", "50-pretraffic-up.log", "51-pretraffic-wait.log",
    "52-pretraffic-services.log", "54-bootstrap-reset.log", "55-bootstrap-up.log",
    "56-bootstrap-wait.log", "57-post-bootstrap-accounting-reset.log",
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
  const checksums = readdirSync(directory).sort().map((name) => {
    const digest = createHash("sha256").update(readFileSync(join(directory, name))).digest("hex");
    return `${digest}  ./${name}`;
  });
  writeFileSync(join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
}

describe("commit-addressed release orchestration", () => {
  it("puts migration, every grant reconciler, schema/grant verification, and journal verification before bootstrap", () => {
    const compose = source("docker-compose.yml");
    expect(compose).toContain("verify_database_contract:");
    expect(compose).toContain("verify_accounting_evidence:");
    expect(compose).toContain("npm run db:verify-schema && npm run journal-types:verify-db");
    expect(compose).toMatch(/verify_database_contract:[\s\S]*?depends_on:[\s\S]*?reconcile_backup_grants:[\s\S]*?condition: service_completed_successfully/);
    expect(compose).toMatch(/bootstrap_demo:[\s\S]*?depends_on:[\s\S]*?verify_database_contract:[\s\S]*?condition: service_completed_successfully/);

    for (const image of ["app", "migrator", "auth-worker", "operations", "acceptance"]) {
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
      "app", "auth_email_worker", "migrate", "verify_database_contract", "bootstrap_demo",
      "provision_auth_worker_role", "reconcile_runtime_grants", "reconcile_auth_worker_grants",
      "provision_backup", "reconcile_backup_grants", "backup", "verify_latest_backup",
      "verify_accounting_evidence",
      "release_acceptance",
    ]) {
      expect(pinned).toMatch(new RegExp(`^  ${service}:$`, "m"));
    }
    expect(pinned.match(/build: !reset null/g)).toHaveLength(14);
    expect(pinned.match(/pull_policy: never/g)).toHaveLength(14);
  });

  it("runs release browser acceptance in a secretless hardened container", () => {
    const compose = source("docker-compose.yml");
    const start = compose.indexOf("  release_acceptance:\n");
    const end = compose.indexOf("\n  invite_account:\n", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const service = compose.slice(start, end);

    expect(service).toContain("profiles: [acceptance]");
    expect(service).toContain("target: acceptance");
    expect(service).toContain('command: ["./node_modules/.bin/playwright", "test"]');
    expect(service).toContain("user: pwuser");
    expect(service).toContain("network_mode: host");
    expect(service).toContain("read_only: true");
    expect(service).toContain("no-new-privileges:true");
    expect(service).toContain("cap_drop: [ALL]");
    expect(service).toContain("shm_size: 512m");
    expect(service).not.toMatch(/^\s+secrets:/m);
    expect(service).not.toMatch(/^\s+volumes:/m);
    expect(service).not.toMatch(/^\s+ports:/m);
  });

  it("embeds the full revision in every release-owned image and retains both backup revision meanings", () => {
    const dockerfile = source("Dockerfile");
    expect(dockerfile.match(/LABEL org\.opencontainers\.image\.revision=\$BUSINESS_FINLYNQ_IMAGE_REVISION/g)).toHaveLength(5);
    expect(dockerfile).toContain(
      "FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS acceptance",
    );
    expect(dockerfile).toContain('CMD ["./node_modules/.bin/playwright", "test"]');

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
    expect(release).toContain("12-rollback-artifact.json");
    expect(release).toContain("SHA256SUMS");
    expect(release).toContain('compose --profile operations rm --force --stop "${pretraffic_services[@]}"');
    expect(release).toContain("verify_database_contract verify_accounting_evidence");
    expect(release).toContain('stage="post-bootstrap-accounting-verification"');
    expect(release).toContain('service: "verify_accounting_evidence_post_bootstrap"');
    expect(release).toContain("postBootstrapAccountingEvidenceVerified: true");
    expect(release).toContain("compose rm --force --stop bootstrap_demo");
    expect(release).not.toContain("--force-recreate verify_database_contract");
    expect(release).toContain('run_quiesced_app() (');
    expect(release).toContain('run_acceptance_app() (');
    expect(release).toContain('compose_with_overrides BUSINESS_WRITES_ENABLED=false BANK_FEEDS_ENABLED=false --');
    expect(release).toContain('AUTH_EMAIL_DELIVERY_ENABLED=false SIGNUP_TURNSTILE_ENABLED=false');
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
    expect(release).toContain('read_operations_value BUSINESS_FINLYNQ_IMAGE_REVISION');
    expect(release).toContain('operations_environment_sha256="$(sha256sum "$canonical_operations_environment_file"');
    expect(release).toContain("canonical operations environment changed during release; schedulers remain paused");
    expect(release).toContain("canonical operations image revision changed before scheduler resume");
    expect(release).toContain("run_installed_monitor");
    expect(release).toContain("systemctl start business-finlynq-monitor.service");
    expect(release).toContain('bash "$repository_root/deploy/cron/run-job.sh" monitor');
    expect(release).toContain("82-production-monitor.json");
    expect(release.indexOf('schedulers_resumed="true"')).toBeLessThan(
      release.indexOf("run_logged 80-resume-schedulers.log resume_schedulers"),
    );
    expect(release.slice(release.indexOf('schedulers_resumed="true"')))
      .not.toContain('schedulers_resumed="false"');
    expect(release).not.toContain("run_logged 81-production-monitor.log bash deploy/monitoring/check-production.sh");
    expect(release).not.toMatch(/docker compose[^\n]*pull/);
    expect(release).toContain('git -C "$repository_root" archive --format=tar "$revision"');
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
    expect(release).toContain('compose_timed 30m --profile acceptance wait release_acceptance');
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
    expect(rollback).toContain('git -C "$repository_root" archive --format=tar "$candidate_revision"');
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
    expect(source("deploy/cron/run-job.sh")).toContain("Cron checkout status could not be inspected");

    const schedulerBootstrap = source("deploy/release/bootstrap-scheduler-boundary.sh");
    expect(schedulerBootstrap).toContain("/tmp/business-finlynq-release-bootstrap.*/repository");
    expect(schedulerBootstrap).toContain('show "$candidate_revision:$relative_path"');
    expect(schedulerBootstrap).toContain("SCHEDULER_BOUNDARY_BOOTSTRAP_ACK");
    expect(schedulerBootstrap).toContain('--expected-cron-schedule "$deployed_schedule"');
    expect(schedulerBootstrap).toContain('scheduler-boundary-bootstrap.json');
  });

  it("arms a complete re-pause before attempting a guarded scheduler resume", () => {
    const resume = source("deploy/release/resume-schedulers.sh");
    expect(resume).toContain("trap contain_partial_resume EXIT");
    expect(resume).toContain('pause-schedulers.sh" "$scheduler_mode" --allow-already-paused');
    expect(resume.indexOf('resume_complete="true"')).toBeGreaterThan(resume.indexOf('rm -- "$marker_file"'));
    expect(resume.indexOf('rm -- "$marker_file"')).toBeGreaterThan(resume.indexOf('systemctl enable --now'));
  });

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

  it.skipIf(process.platform === "win32")("accepts only explicit not-found candidate units during the first systemd upgrade", () => {
    const root = mkdtempSync(join(tmpdir(), "business-finlynq-scheduler-upgrade-"));
    const fakeBin = join(root, "bin");
    const markerDirectory = join(root, "release-locks");
    const callLog = join(root, "systemctl.log");
    mkdirSync(fakeBin);
    mkdirSync(markerDirectory, { mode: 0o700 });
    chmodSync(markerDirectory, 0o700);
    const currentUid = process.getuid?.() ?? 1000;
    const normalizedMarkerDirectory = markerDirectory.replaceAll("\\", "/");
    const pausePath = join(root, "pause-schedulers.sh");
    writeFileSync(pausePath, source("deploy/release/pause-schedulers.sh").replace(
      'marker_directory="/home/deploy/.local/state/business-finlynq/release-locks"',
      `marker_directory="${normalizedMarkerDirectory}"`,
    ));
    chmodSync(pausePath, 0o755);
    writeFileSync(join(fakeBin, "id"), `#!/usr/bin/env bash
case "$*" in
  "-u deploy") printf '%s\\n' '${currentUid}' ;;
  "-u") printf '%s\\n' 0 ;;
  *) /usr/bin/id "$@" ;;
esac
`);
    writeFileSync(join(fakeBin, "chown"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(fakeBin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(fakeBin, "runuser"), `#!/usr/bin/env bash
printf '%s\\n' 'no crontab for deploy' >&2
exit 1
`);
    writeFileSync(join(fakeBin, "docker"), `#!/usr/bin/env bash
if [[ "\${FAKE_DOCKER_PS_ERROR:-false}" == true && "$1" == ps ]]; then
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
    for (const command of ["id", "chown", "sleep", "runuser", "docker", "systemctl"]) {
      chmodSync(join(fakeBin, command), 0o755);
    }

    const accepted = spawnSync("bash", [pausePath, "systemd", "--allow-already-paused"], {
      encoding: "utf8",
      env: { ...process.env, FAKE_SYSTEMCTL_LOG: callLog, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("schedulers are paused and drained");
    const calls = readFileSync(callLog, "utf8");
    expect(calls).not.toContain("disable --now business-finlynq-accounting-evidence.timer");
    expect(calls).toContain("show --property=LoadState --value business-finlynq-accounting-evidence.timer");

    const rejected = spawnSync("bash", [pausePath, "systemd", "--allow-already-paused"], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_SYSTEMCTL_LOG: callLog,
        FAKE_SYSTEMD_READ_ERROR: "true",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("could not query systemd ActiveState");

    const dockerRejected = spawnSync("bash", [pausePath, "systemd", "--allow-already-paused"], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_DOCKER_PS_ERROR: "true",
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

    writeFileSync(join(second, "90-release-complete.json"), "{}\n");
    const rejected = spawnSync(process.execPath, [verifier, first, second], { encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("Release rehearsal evidence verification failed");
  });
});
