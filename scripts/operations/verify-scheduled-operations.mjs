import { readFileSync } from "node:fs";

const targetRoot = "/home/deploy/business-finlynq";

function read(path) {
  return readFileSync(path, "utf8");
}

function requireText(content, expected, label) {
  if (!content.includes(expected)) throw new Error(`${label} is missing: ${expected}`);
}

for (const [path, script] of [
  ["deploy/systemd/business-finlynq-backup.service", "deploy/backup/run-scheduled-backup.sh"],
  ["deploy/systemd/business-finlynq-monitor.service", "deploy/monitoring/check-production.sh"],
]) {
  const unit = read(path);
  requireText(unit, `WorkingDirectory=${targetRoot}`, path);
  requireText(unit, `ExecStart=${targetRoot}/${script}`, path);
  requireText(unit, "ProtectHome=read-only", path);
  requireText(unit, "EnvironmentFile=/etc/business-finlynq/operations.env", path);
  if (unit.includes("EnvironmentFile=-/etc/business-finlynq/operations.env")) {
    throw new Error(`${path} treats mandatory operations configuration as optional`);
  }
}

const notifier = read("deploy/systemd/business-finlynq-monitor-notify@.service");
requireText(notifier, `ExecStart=${targetRoot}/deploy/monitoring/notify-failure.sh`, "failure notifier");
requireText(notifier, "ProtectHome=read-only", "failure notifier");
requireText(notifier, "EnvironmentFile=-/etc/business-finlynq/operations.env", "failure notifier");

for (const [path, script] of [
  ["deploy/systemd/business-finlynq-demo-reset.service", "deploy/demo-sandbox/run-dirty-reset.sh"],
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

const frequentTimer = read("deploy/systemd/business-finlynq-demo-reset.timer");
requireText(frequentTimer, "OnUnitInactiveSec=5m", "frequent demo reset timer");
const nightlyTimer = read("deploy/systemd/business-finlynq-demo-reconcile.timer");
requireText(nightlyTimer, "OnCalendar=*-*-* 04:15:00 America/Toronto", "nightly demo reconciliation timer");
requireText(nightlyTimer, "Persistent=true", "nightly demo reconciliation timer");

const dirtyWrapper = read("deploy/demo-sandbox/run-dirty-reset.sh");
requireText(dirtyWrapper, "flock --nonblock", "dirty-sandbox wrapper");
requireText(dirtyWrapper, "run --rm --no-deps reset_demo_sandboxes", "dirty-sandbox wrapper");
const nightlyWrapper = read("deploy/demo-sandbox/run-nightly-reconciliation.sh");
requireText(nightlyWrapper, "flock --wait 600", "nightly-sandbox wrapper");
requireText(nightlyWrapper, "run --rm --no-deps reconcile_demo_sandboxes", "nightly-sandbox wrapper");

for (const content of [dirtyWrapper, nightlyWrapper]) {
  if (/\$\{?1\}?/.test(content) || /--(?:organization|tenant|slot)/.test(content)) {
    throw new Error("demo-sandbox wrapper accepts a forbidden caller-selected target");
  }
}

const resetImplementation = read("src/modules/onboarding/demo-bootstrap.ts");
requireText(resetImplementation, "resetDemoSandboxes", "demo-sandbox reset implementation");
requireText(resetImplementation, "open_item_void_events", "demo-sandbox reset table coverage");

const monitor = read("deploy/monitoring/check-production.sh");
for (const expected of [
  "BUSINESS_FINLYNQ_IMAGE_REVISION is required",
  "MONITOR_EXPECT_REVISION is required",
  "MONITOR_EXPECT_DEMO_LOGIN_ENABLED",
  "MONITOR_EXPECT_DEMO_WRITES_ENABLED",
  "MONITOR_EXPECT_ACCOUNT_LOGIN_ENABLED",
  "MONITOR_EXPECT_BUSINESS_WRITES_ENABLED",
  "MONITOR_EXPECT_DEMO_POOL_SIZE",
  "MONITOR_MIN_DEMO_READY_SLOTS",
  "FROM demo_sandbox_slots",
  "quarantined slot(s)",
  "stranded resetting slot(s)",
  "app image OCI revision label does not match the monitored release",
]) requireText(monitor, expected, "production monitor");

const dockerfile = read("Dockerfile");
requireText(dockerfile, "org.opencontainers.image.revision=$BUSINESS_FINLYNQ_IMAGE_REVISION", "application image");

const scheduledBackup = read("deploy/backup/run-scheduled-backup.sh");
requireText(scheduledBackup, "BUSINESS_FINLYNQ_IMAGE_REVISION is required", "scheduled backup wrapper");
if (scheduledBackup.includes("git rev-parse") || scheduledBackup.includes("printf unknown")) {
  throw new Error("scheduled backup wrapper can record an unreviewed revision fallback");
}
const backupImplementation = read("deploy/backup/run-backup.sh");
requireText(backupImplementation, "BUSINESS_FINLYNQ_IMAGE_REVISION is required", "backup implementation");
if (backupImplementation.includes("BACKUP_GIT_COMMIT") || backupImplementation.includes(":-unknown")) {
  throw new Error("backup implementation can record an unreviewed revision fallback");
}

process.stdout.write("Scheduled operations paths and demo-reset boundaries verified\n");
