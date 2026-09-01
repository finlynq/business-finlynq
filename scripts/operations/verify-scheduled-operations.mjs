import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const targetRoot = "/home/deploy/business-finlynq";

function read(path) {
  return readFileSync(path, "utf8");
}

function requireText(content, expected, label) {
  if (!content.includes(expected)) throw new Error(`${label} is missing: ${expected}`);
}

for (const [path, command] of [
  ["deploy/systemd/business-finlynq-backup.service", `${targetRoot}/deploy/backup/run-scheduled-backup.sh`],
  ["deploy/systemd/business-finlynq-monitor.service", `${targetRoot}/deploy/monitoring/check-production.sh`],
  ["deploy/systemd/business-finlynq-accounting-evidence.service", `/bin/bash ${targetRoot}/deploy/monitoring/run-accounting-evidence-check.sh`],
]) {
  const unit = read(path);
  requireText(unit, `WorkingDirectory=${targetRoot}`, path);
  requireText(unit, `ExecStart=${command}`, path);
  requireText(unit, "ProtectHome=read-only", path);
  requireText(unit, "EnvironmentFile=/etc/business-finlynq/operations.env", path);
  if (unit.includes("EnvironmentFile=-/etc/business-finlynq/operations.env")) {
    throw new Error(`${path} treats mandatory operations configuration as optional`);
  }
}

const backupTimer = read("deploy/systemd/business-finlynq-backup.timer");
requireText(backupTimer, "OnCalendar=*-*-* 00,04,08,12,16,20:17:00 UTC", "encrypted backup timer");
requireText(backupTimer, "RandomizedDelaySec=10m", "encrypted backup timer");
requireText(backupTimer, "Persistent=true", "encrypted backup timer");
requireText(
  read("deploy/systemd/business-finlynq-backup.service"),
  "TimeoutStartSec=95m",
  "encrypted backup service",
);

const accountingTimer = read("deploy/systemd/business-finlynq-accounting-evidence.timer");
requireText(accountingTimer, "OnCalendar=*-*-* 01,05,09,13,17,21:47:00 UTC", "accounting-evidence timer");
requireText(accountingTimer, "RandomizedDelaySec=10m", "accounting-evidence timer");
requireText(accountingTimer, "Persistent=true", "accounting-evidence timer");
requireText(
  read("deploy/systemd/business-finlynq-accounting-evidence.service"),
  "TimeoutStartSec=16m",
  "accounting-evidence service",
);

const notifier = read("deploy/systemd/business-finlynq-monitor-notify@.service");
requireText(notifier, `ExecStart=${targetRoot}/deploy/monitoring/notify-failure.sh`, "failure notifier");
requireText(notifier, "ProtectHome=read-only", "failure notifier");
requireText(notifier, "EnvironmentFile=-/etc/business-finlynq/operations.env", "failure notifier");

for (const [path, script] of [
  ["deploy/systemd/business-finlynq-demo-reconcile.service", "deploy/demo-sandbox/run-nightly-reconciliation.sh"],
]) {
  const unit = read(path);
  requireText(unit, `WorkingDirectory=${targetRoot}`, path);
  requireText(unit, `ExecStart=/bin/bash ${targetRoot}/${script}`, path);
  requireText(unit, "NoNewPrivileges=true", path);
  requireText(unit, "ProtectHome=read-only", path);
  requireText(unit, "OnFailure=business-finlynq-monitor-notify@%n.service", path);
  requireText(unit, "EnvironmentFile=/etc/business-finlynq/operations.env", path);
  if (unit.includes("EnvironmentFile=-/etc/business-finlynq/operations.env")) {
    throw new Error(`${path} treats mandatory operations configuration as optional`);
  }
}

const nightlyTimer = read("deploy/systemd/business-finlynq-demo-reconcile.timer");
requireText(nightlyTimer, "OnCalendar=*-*-* 04:15:00 America/Toronto", "nightly demo reconciliation timer");
requireText(nightlyTimer, "Persistent=true", "nightly demo reconciliation timer");

const nightlyWrapper = read("deploy/demo-sandbox/run-nightly-reconciliation.sh");
requireText(nightlyWrapper, "flock --wait 600", "nightly-sandbox wrapper");
requireText(nightlyWrapper, "run --rm --no-deps reconcile_demo_sandboxes", "nightly-sandbox wrapper");

for (const removedPath of [
  "deploy/demo-sandbox/run-dirty-reset.sh",
  "deploy/systemd/business-finlynq-demo-reset.service",
  "deploy/systemd/business-finlynq-demo-reset.timer",
]) {
  if (existsSync(removedPath)) throw new Error(`${removedPath} would reintroduce non-nightly demo resets`);
}

for (const content of [nightlyWrapper]) {
  if (/\$\{?1\}?/.test(content) || /--(?:organization|tenant|slot)/.test(content)) {
    throw new Error("demo-sandbox wrapper accepts a forbidden caller-selected target");
  }
}

const managedCron = read("deploy/cron/managed-crontab");
const expectedCron = `# BEGIN BUSINESS FINLYNQ MANAGED SCHEDULE
15 8,9 * * * /bin/bash ${targetRoot}/deploy/cron/run-job.sh nightly-reconciliation
29 0,4,8,12,16,20 * * * /bin/bash ${targetRoot}/deploy/cron/run-job.sh backup
47 1,5,9,13,17,21 * * * /bin/bash ${targetRoot}/deploy/cron/run-job.sh accounting-evidence
2-59/5 * * * * /bin/bash ${targetRoot}/deploy/cron/run-job.sh monitor
# END BUSINESS FINLYNQ MANAGED SCHEDULE
`;
if (managedCron !== expectedCron) {
  throw new Error("deploy/cron/managed-crontab differs from the reviewed DST-safe four-job schedule");
}

const cronInstaller = read("deploy/cron/install.sh");
for (const expected of [
  'readonly repository_root="$(cd -- "$script_directory/../.." && pwd -P)"',
  'readonly operations_env="/home/deploy/.config/business-finlynq/operations.env"',
  "stat -c '%a'",
  '== "600"',
  "stat -c '%u'",
  'maintenance_scheduler="$(env -i',
  'must set MONITOR_MAINTENANCE_SCHEDULER=cron',
  'flock --exclusive --wait 7200 7',
  "existing_crontab_file=",
  "unmanaged_crontab_file=",
  'crontab "$temporary_crontab"',
]) requireText(cronInstaller, expected, "deploy-owned cron installer");
if (cronInstaller.includes("crontab -r")) {
  throw new Error("deploy-owned cron installer may not remove the user's complete crontab");
}

const cronRunner = read("deploy/cron/run-job.sh");
for (const expected of [
  "nightly-reconciliation|backup|accounting-evidence|monitor",
  'source "$clean_operations_env"',
  "stat -c '%a'",
  'flock --shared --nonblock 7',
  'flock --nonblock 8',
  'scheduler_maintenance_marker="/home/deploy/.local/state/business-finlynq/release-locks/scheduler-maintenance"',
  'MONITOR_MAINTENANCE_SCHEDULER:-}" == "cron"',
  "env -i",
  "DOCKER_HOST DOCKER_CONTEXT COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_PATH_SEPARATOR",
  'if ! clean_checkout_head="$(git --no-optional-locks -c safe.directory="$clean_repository_root"',
  '-C "$clean_repository_root" rev-parse HEAD 2>/dev/null)',
  "Cron checkout HEAD could not be inspected",
  'if ! clean_checkout_status="$(git --no-optional-locks -c safe.directory="$clean_repository_root"',
  "status --porcelain=v1 --untracked-files=all",
  "Cron checkout status could not be inspected",
  "Cron checkout is dirty",
  'job_status_directory="$state_dir/job-status"',
  "completedAtUnixtime",
  "write_job_status succeeded",
  "logger_path",
  'nightly_timezone="America/Toronto"',
  'nightly_stamp_file=',
  'last_reconciled_date',
  'nightly_due_time="04:15"',
  'current_local_time',
  '$repository_root/deploy/demo-sandbox/run-nightly-reconciliation.sh',
  '$repository_root/deploy/backup/run-scheduled-backup.sh',
  '$repository_root/deploy/monitoring/run-accounting-evidence-check.sh',
  '$repository_root/deploy/monitoring/check-production.sh',
]) requireText(cronRunner, expected, "allowlisted cron wrapper");
if (/\beval\b/.test(cronRunner)) {
  throw new Error("allowlisted cron wrapper may not evaluate a caller-selected command");
}

const cronRemover = read("deploy/cron/remove.sh");
for (const expected of [
  'readonly scheduler_lock_file="$state_dir/scheduler.lock"',
  'flock --exclusive --wait 7200 7',
  "existing_crontab_file=",
  "managed_block_file=",
  'crontab "$temporary_crontab"',
]) requireText(cronRemover, expected, "deploy-owned cron remover");
if (cronRemover.includes("crontab -r")) {
  throw new Error("deploy-owned cron remover may not remove the user's complete crontab");
}

const schedulerPause = read("deploy/release/pause-schedulers.sh");
for (const expected of [
  'deploy_gid="$(id -g deploy 2>/dev/null)"',
  'stat -c \'%u:%g:%a\' -- "$marker_directory"',
  'stat -c \'%u:%g:%a\' -- "$marker_file"',
  'chown -- "$deploy_uid:$deploy_gid" "$marker_temporary"',
  'stat -c \'%u:%g:%a\' -- "$marker_temporary"',
]) requireText(schedulerPause, expected, "scheduler maintenance containment");
if (schedulerPause.includes('chown -- "$deploy_uid" "$marker_temporary"')) {
  throw new Error("root scheduler containment can leave the maintenance marker in root's group");
}

const resetImplementation = read("src/modules/onboarding/demo-bootstrap.ts");
requireText(resetImplementation, "resetDemoSandboxes", "demo-sandbox reset implementation");
requireText(resetImplementation, "registeredDemoSandboxResetTables", "demo-sandbox reset registration hook");
const dailyClaimMigration = read("migrations/drizzle/0012_daily_demo_claims.sql");
requireText(dailyClaimMigration, "open_item_void_events", "demo-sandbox reset table coverage");
requireText(dailyClaimMigration, "generate_series(1, 128)", "demo-sandbox pool capacity");
if (resetImplementation.includes("command_hash = EXCLUDED.command_hash")) {
  throw new Error("demo bootstrap may not rewrite the immutable party creation fingerprint during an upgrade");
}

const monitor = read("deploy/monitoring/check-production.sh");
for (const expected of [
  "BUSINESS_FINLYNQ_IMAGE_REVISION is required",
  "MONITOR_EXPECT_REVISION is required",
  "MONITOR_EXPECT_DEMO_LOGIN_ENABLED",
  "MONITOR_EXPECT_DEMO_WRITES_ENABLED",
  "MONITOR_EXPECT_ACCOUNT_LOGIN_ENABLED",
  "MONITOR_EXPECT_BUSINESS_WRITES_ENABLED",
  "MONITOR_EXPECT_BANK_FEEDS_ENABLED",
  "MONITOR_EXPECT_DEMO_POOL_SIZE",
  "MONITOR_MIN_DEMO_READY_SLOTS",
  'MONITOR_MAINTENANCE_SCHEDULER="${MONITOR_MAINTENANCE_SCHEDULER:-systemd}"',
  'MONITOR_MAINTENANCE_SCHEDULER" == "cron"',
  "deploy-owned cron schedule does not match the reviewed four-job block",
  "monitor_cron_maintenance_lock_file",
  "monitor_cron_status_directory",
  "cron_job_metrics",
  "unselected systemd scheduler remains active or enabled",
  "unselected deploy-owned cron scheduler remains installed",
  "MONITOR_MAX_BACKUP_ACTIVE_SECONDS",
  "SCHEDULED_BACKUP_TIMEOUT_SECONDS",
  "MONITOR_MAX_BACKUP_ACTIVE_SECONDS <= 4800",
  "MONITOR_MAX_BACKUP_ACTIVE_SECONDS < SCHEDULED_BACKUP_TIMEOUT_SECONDS",
  "verify-backup-schedule.sh",
  "business_finlynq_backup_schedule_contract",
  "MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS",
  'timeout --signal=TERM --kill-after=5 "${MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS}s"',
  "docker compose --profile operations run --rm --no-deps -T verify_latest_backup",
  '</dev/null >"$backup_verification_output" 2>&1',
  'backup_verification_status" == "75"',
  "Backup verification deferred while an encrypted backup is active",
  "newest encrypted backup failed isolated container verification",
  "FROM demo_sandbox_slots",
  "quarantined slot(s)",
  "stranded resetting slot(s)",
  "app image OCI revision label does not match the monitored release",
  "readiness bank-feed gate does not match the monitored release boundary",
]) requireText(monitor, expected, "production monitor");

const accountingMonitor = read("deploy/monitoring/run-accounting-evidence-check.sh");
for (const expected of [
  "flock --exclusive",
  "ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS",
  "business_finlynq_accounting_evidence_verification_success",
  'mv -f -- "$metrics_temporary" "$accounting_metrics_file"',
]) requireText(accountingMonitor, expected, "scheduled accounting-evidence monitor");
for (const forbidden of [
  'sha256sum "$archive_path"',
  '"$MONITOR_BACKUP_DIR"/business_finlynq_*.manifest.json',
  'jq -r \'.encryptedArchive // empty\' "$latest_manifest"',
]) {
  if (monitor.includes(forbidden)) {
    throw new Error(`production monitor reads a UID-70 backup artifact on the host: ${forbidden}`);
  }
}

const dockerfile = read("Dockerfile");
requireText(dockerfile, "org.opencontainers.image.revision=$BUSINESS_FINLYNQ_IMAGE_REVISION", "application image");
requireText(
  dockerfile,
  "COPY --chmod=0555 deploy/backup/check-latest-backup.sh /usr/local/bin/business-finlynq-check-latest-backup",
  "operations image",
);

const latestBackupChecker = read("deploy/backup/check-latest-backup.sh");
for (const expected of [
  "flock --shared --nonblock 9",
  "exit 75",
  "BACKUP_MAX_ACTIVE_SECONDS",
  "BACKUP_MAX_ACTIVE_SECONDS must be 1 to 4800 seconds",
  "BACKUP_REQUIRE_OFFSITE_MARKER",
  "sha256sum",
  "encryptedBytes",
  "applicationRevision",
  "newest backup off-site upload marker is invalid",
]) requireText(latestBackupChecker, expected, "isolated latest-backup checker");
if (latestBackupChecker.includes("flock --unlock 9")) {
  throw new Error("isolated latest-backup checker releases its shared lock before verification completes");
}

const scheduledBackup = read("deploy/backup/run-scheduled-backup.sh");
requireText(scheduledBackup, "BUSINESS_FINLYNQ_IMAGE_REVISION is required", "scheduled backup wrapper");
for (const expected of [
  'SCHEDULED_BACKUP_TIMEOUT_SECONDS="${SCHEDULED_BACKUP_TIMEOUT_SECONDS:-5400}"',
  "SCHEDULED_BACKUP_TIMEOUT_SECONDS must be 1 to 5400",
  'timeout --signal=TERM --kill-after=30 "${SCHEDULED_BACKUP_TIMEOUT_SECONDS}s"',
  'run-scheduled-backup.sh" --bounded-run',
]) requireText(scheduledBackup, expected, "scheduled backup wrapper");
if (scheduledBackup.includes("git rev-parse") || scheduledBackup.includes("printf unknown")) {
  throw new Error("scheduled backup wrapper can record an unreviewed revision fallback");
}

const backupScheduleVerifier = read("deploy/systemd/verify-backup-schedule.sh");
for (const expected of [
  "schedule_names=(backup monitor accounting-evidence demo-reconcile)",
  "installed $schedule_name service differs from the committed candidate",
  "installed $schedule_name timer differs from the committed candidate",
  "*-*-* 00,04,08,12,16,20:17:00 UTC",
  "OnUnitActiveSec=5m",
  "*-*-* 01,05,09,13,17,21:47:00 UTC",
  "*-*-* 04:15:00 America/Toronto",
  '[backup]="10m"',
  '[backup]="95m"',
  "TimeoutStartSec=${expected_timeout_unit[$schedule_name]}",
  "RandomizedDelayUSec",
  "TimersCalendar",
  "TimersMonotonic",
  "verify_monitor_monotonic_records",
  "monotonic_records[@]}",
  "EnvironmentFiles",
  "TimeoutStartUSec",
]) requireText(backupScheduleVerifier, expected, "installed backup schedule verifier");
if (backupScheduleVerifier.includes('== *"OnBootUSec=2min"*')
  || backupScheduleVerifier.includes('== *"OnUnitActiveUSec=5min"*')) {
  throw new Error("installed backup schedule verifier accepts non-exact monotonic timer durations");
}

const scheduleVerifierPath = "deploy/systemd/verify-backup-schedule.sh";
const fixtureShell = process.env.BUSINESS_FINLYNQ_TEST_BASH ?? "bash";
function runMonitorCadenceFixture(fixture) {
  const result = spawnSync(
    fixtureShell,
    [scheduleVerifierPath, "--verify-monitor-monotonic-records"],
    { cwd: process.cwd(), encoding: "utf8", input: fixture },
  );
  if (result.error) {
    throw new Error(`could not execute monitor cadence fixture: ${result.error.message}`);
  }
  return result;
}

const activeMonitorCadence = [
  "{ OnUnitActiveUSec=5min ; next_elapse=1d 3h 14min 15.123456s }",
  "{ OnBootUSec=2min ; next_elapse=2min }",
].join("\n");
const acceptedMonitorCadence = runMonitorCadenceFixture(activeMonitorCadence);
if (acceptedMonitorCadence.status !== 0) {
  throw new Error(
    `installed backup schedule verifier rejects an active multi-word monotonic timestamp: ${acceptedMonitorCadence.stderr}`,
  );
}

const extraMonitorTrigger = `${activeMonitorCadence}\n{ OnActiveUSec=30s ; next_elapse=1d 3h 9min }`;
if (runMonitorCadenceFixture(extraMonitorTrigger).status === 0) {
  throw new Error("installed backup schedule verifier accepts an unexpected extra monotonic trigger");
}

const extendedBootDelay = activeMonitorCadence.replace("OnBootUSec=2min ;", "OnBootUSec=2min 30s ;");
if (runMonitorCadenceFixture(extendedBootDelay).status === 0) {
  throw new Error("installed backup schedule verifier accepts a non-exact boot delay");
}
const backupImplementation = read("deploy/backup/run-backup.sh");
requireText(backupImplementation, "BUSINESS_FINLYNQ_IMAGE_REVISION is required", "backup implementation");
requireText(backupImplementation, 'exec 9<>"$backup_lock_file"', "backup implementation");
requireText(backupImplementation, "flock --exclusive --wait 600 9", "backup implementation");
requireText(backupImplementation, 'printf \'%s\\n\' "$(date +%s)" >"$backup_lock_file"', "backup implementation");
if (backupImplementation.includes("BACKUP_GIT_COMMIT") || backupImplementation.includes(":-unknown")) {
  throw new Error("backup implementation can record an unreviewed revision fallback");
}

const restoreRunner = read("deploy/backup/run-restore-drill.sh");
for (const expected of [
  "RESTORE_SELECTED_SHA256",
  "RESTORE_DRILL_STARTED_AT",
  "RESTORE_DRILL_COMPLETED_AT",
  "RESTORE_EVIDENCE_ID",
  "RESTORE_RPO_SECONDS <= 21600",
  "RESTORE_RTO_SECONDS <= 14400",
  'RESTORE_ALLOW_EMPTY_SECRET_FIXTURES="${RESTORE_ALLOW_EMPTY_SECRET_FIXTURES:-false}"',
  "export RESTORE_ALLOW_EMPTY_SECRET_FIXTURES",
  "/var/lib/business-finlynq/restore-drill.lock",
  'flock --exclusive --wait "$RESTORE_DRILL_LOCK_WAIT_SECONDS" 8',
  "DOCKER_HOST DOCKER_CONTEXT COMPOSE_FILE",
  "RESTORE_IMAGE_OVERRIDE_FILE",
  "status --porcelain=v1 --untracked-files=all",
  'archive --format=tar "$BUSINESS_FINLYNQ_IMAGE_REVISION"',
  '--project-directory "$RESTORE_SOURCE_SNAPSHOT"',
  "--env-file /dev/null",
  "build: !reset null",
  "pinned_restore_images",
  'restore_compose --profile restore-drill',
  'restore_container_gid="70"',
  '== "$restore_operator_uid:$restore_container_gid:440:1"',
  "restore_accounting_verify",
  "restore_runtime_verify",
  "restore_evidence",
]) requireText(restoreRunner, expected, "restore-drill wrapper");
if (!restoreRunner.includes("restore_key_verify")
  || restoreRunner.indexOf("restore_key_verify") > restoreRunner.indexOf("restore_runtime_verify")) {
  throw new Error("restore-drill wrapper does not verify keys before runtime acceptance");
}
const accountingRun = "restore_compose --profile restore-drill run --rm --no-deps --no-build restore_accounting_verify";
const keyRun = "restore_compose --profile restore-drill run --rm --no-deps --no-build restore_key_verify";
const demoRun = "restore_compose --profile restore-drill run --rm --no-deps --no-build restore_demo_bootstrap";
const restoreMutationSequence = [accountingRun, keyRun, demoRun].map((command) => restoreRunner.indexOf(command));
if (restoreMutationSequence.some((position) => position < 0)
  || !(restoreMutationSequence[0] < restoreMutationSequence[1]
    && restoreMutationSequence[1] < restoreMutationSequence[2])) {
  throw new Error("restore drill does not retain accounting evidence before key/demo mutation");
}
const firstCleanup = restoreRunner.indexOf("\nremove_restore_services\n");
if (firstCleanup < 0 || restoreRunner.indexOf("flock --exclusive") > firstCleanup) {
  throw new Error("restore drill does not hold its host-wide lock before Compose cleanup");
}
const capturedImageIds = restoreRunner.indexOf('RESTORE_OPERATIONS_IMAGE_ID="$(verify_recovery_image');
const immutableOverride = restoreRunner.indexOf('RESTORE_IMAGE_OVERRIDE_FILE="$(mktemp');
if (capturedImageIds < 0 || immutableOverride < capturedImageIds || firstCleanup < immutableOverride) {
  throw new Error("restore drill does not bind captured image IDs before its first Docker mutation");
}
if (/docker compose --profile restore-drill (?:rm|run|up)/.test(restoreRunner)) {
  throw new Error("restore drill has a mutable-tag Compose mutation outside its immutable override");
}

const restoreEvidence = read("deploy/backup/record-restore-evidence.sh");
for (const expected of [
  'RESTORE_RPO_SECONDS="${RESTORE_RPO_SECONDS:-21600}"',
  'RESTORE_RTO_SECONDS="${RESTORE_RTO_SECONDS:-14400}"',
  "RESTORE_RPO_SECONDS <= 21600",
  "RESTORE_RTO_SECONDS <= 14400",
  'RESTORE_REQUIRE_OFFSITE_EVIDENCE="${RESTORE_REQUIRE_OFFSITE_EVIDENCE:-true}"',
  'RESTORE_ALLOW_EMPTY_SECRET_FIXTURES="${RESTORE_ALLOW_EMPTY_SECRET_FIXTURES:-false}"',
  "BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE",
  "BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256",
  "openssl pkeyutl -verify -rawin -pubin",
  "offSiteReceiptSignature",
  "recoveryPointAgeSeconds",
  "recoveryDurationSeconds",
  "recoveryPointObjectiveMet",
  "recoveryTimeObjectiveMet",
  "verified-diagnostic-no-offsite",
  "verified-diagnostic-empty-secret-fixtures",
  "productionRecoveryEvidence",
  "explicit passing checks",
  "accounting-prebootstrap_",
  "pre-bootstrap accounting evidence did not pass its explicit checks",
  ".checks.encryptedPartyDecryption == (.counts.encryptedPartyNames > 0)",
  ".checks.encryptedAddressDecryption == (.counts.encryptedPartyAddresses > 0)",
  "and $allowDiagnostic",
  "diagnosticKeyRecovery",
  "key-recovery evidence did not pass its explicit checks",
  "restored-runtime evidence did not pass its explicit checks",
  ".checks.auditOutboxIntegrity == true",
]) requireText(restoreEvidence, expected, "restore-objective evidence recorder");

const restoredSecretVerifier = read("scripts/operations/verify-restored-secrets.ts");
for (const expected of [
  "verifyRestoredIdentityCiphertexts",
  "RESTORED_MASTER_DATA_FIELD_SPECIFICATIONS",
  "verifyRestoredMasterDataCiphertexts",
  "RESTORE_ALLOW_EMPTY_SECRET_FIXTURES",
  'status: diagnosticEscapeUsed ? "verified-diagnostic"',
]) requireText(restoredSecretVerifier, expected, "restored secret verifier");
if (restoredSecretVerifier.includes("email_ciphertext LIKE 'idv1:%'")) {
  throw new Error("restored secret verifier filters unsupported identity ciphertext away");
}

const restoredRuntimeVerifier = read("deploy/backup/verify-restored-runtime.sh");
for (const expected of [
  "/usr/local/bin/business-finlynq-verify-accounting-evidence",
  "write_runtime_evidence",
  "auditOutboxIntegrity: true",
]) requireText(restoredRuntimeVerifier, expected, "restored runtime verifier");

const accountingEvidenceQuery = read("scripts/operations/accounting-evidence-query.sql");
for (const expected of [
  "root_anomalies",
  "leaf_anomalies",
  "missing_predecessors",
  "forked_predecessors",
  "unreachable_events",
  "audit_hash_contract",
  "tenant-business-v1",
  "journal-posted-v1",
  "period-transition-v1",
  "audit.safe_metadata::text",
  "hash_mismatch_count",
  "invalid_outbox_contract_count",
  "audit_without_required_outbox_count",
  "outbox_without_correct_audit_count",
  "paired_count_mismatch_count",
]) requireText(accountingEvidenceQuery, expected, "accounting-evidence query");
for (const forbidden of ["outbox.payload", "auth_email_outbox"]) {
  if (accountingEvidenceQuery.includes(forbidden)) {
    throw new Error(`accounting-evidence query can select sensitive content: ${forbidden}`);
  }
}
if ((accountingEvidenceQuery.match(/audit\.safe_metadata::text/g) ?? []).length !== 1) {
  throw new Error("accounting-evidence query does not confine metadata to one canonical hash input");
}
const accountingEvidenceProjection = accountingEvidenceQuery.slice(
  accountingEvidenceQuery.lastIndexOf("\nSELECT\n"),
);
for (const forbidden of ["safe_metadata", "payload", "request_id", "entity_id", "event_hash"]) {
  if (accountingEvidenceProjection.includes(forbidden)) {
    throw new Error(`accounting-evidence output can expose event material: ${forbidden}`);
  }
}

process.stdout.write("Scheduled operations paths and demo-reset boundaries verified\n");
