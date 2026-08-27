import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function fail(message) {
  throw new Error(`Compose security-boundary check failed: ${message}`);
}

const rendered = execFileSync(
  "docker",
  [
    "compose",
    "--profile", "auth-email",
    "--profile", "account-operations",
    "--profile", "operations",
    "--profile", "demo-maintenance",
    "--profile", "restore-drill",
    "config",
    "--format", "json",
  ],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const configuration = JSON.parse(rendered);
const services = configuration.services ?? {};
const providerSecret = "business_finlynq_resend_api_key";
const turnstileSecret = "business_finlynq_turnstile_secret_key";
const appDatabaseSecret = "business_finlynq_app_db_password";
const workerDatabaseSecret = "business_finlynq_auth_worker_db_password";
const backupDatabaseSecret = "business_finlynq_backup_db_password";
const backupReceiverPrivateKeySecret = "business_finlynq_backup_receiver_ssh_private_key";
const backupReceiverKnownHostsSecret = "business_finlynq_backup_receiver_known_hosts";
const rootKekSecret = "business_finlynq_root_kek";

function secretSources(service) {
  return (service?.secrets ?? []).map((secret) => typeof secret === "string" ? secret : secret.source);
}

function dependencyCondition(service, dependency) {
  const selected = service?.depends_on?.[dependency];
  return typeof selected === "string" ? selected : selected?.condition;
}

const providerSecretConsumers = Object.entries(services)
  .filter(([, service]) => (service.secrets ?? []).some((secret) => {
    const source = typeof secret === "string" ? secret : secret.source;
    return source === providerSecret;
  }))
  .map(([name]) => name)
  .sort();

if (providerSecretConsumers.join(",") !== "auth_email_worker") {
  fail(`Resend secret consumers must be only auth_email_worker; found ${providerSecretConsumers.join(",") || "none"}`);
}

const turnstileSecretConsumers = Object.entries(services)
  .filter(([, service]) => secretSources(service).includes(turnstileSecret))
  .map(([name]) => name)
  .sort();
if (turnstileSecretConsumers.join(",") !== "app") {
  fail(`Turnstile secret consumers must be only app; found ${turnstileSecretConsumers.join(",") || "none"}`);
}

for (const [name, service] of Object.entries(services)) {
  const providerEnvironmentKeys = Object.keys(service.environment ?? {})
    .filter((key) => key === "RESEND_API_KEY" || key === "RESEND_API_KEY_FILE");
  if (name !== "auth_email_worker" && providerEnvironmentKeys.length > 0) {
    fail(`${name} contains provider credential environment configuration`);
  }
}

const worker = services.auth_email_worker;
if (!worker || !worker.environment?.RESEND_API_KEY_FILE) fail("auth_email_worker has no mounted provider-key path");
if (worker.environment?.BUSINESS_FINLYNQ_DB_PASSWORD) fail("auth_email_worker exposes its database password inline");
if (worker.environment?.BUSINESS_FINLYNQ_DB_PASSWORD_FILE !== "/run/secrets/business_finlynq_auth_worker_db_password") {
  fail("auth_email_worker does not use its dedicated database-password file");
}
if (!secretSources(worker).includes(workerDatabaseSecret)) fail("auth_email_worker does not mount its dedicated database secret");
if (secretSources(worker).includes(appDatabaseSecret)) fail("auth_email_worker mounts the application database secret");
if (secretSources(worker).includes("business_finlynq_root_kek")) fail("auth_email_worker mounts the organization wrapping key");
if ((worker.ports ?? []).length > 0) fail("auth_email_worker publishes a port");
if ((worker.networks ?? {}).business_finlynq_edge) fail("auth_email_worker is attached to the public edge network");

const app = services.app;
if (!app) fail("app service is missing");
if (app.build?.args?.BUSINESS_FINLYNQ_IMAGE_REVISION !== process.env.BUSINESS_FINLYNQ_IMAGE_REVISION) {
  fail("app image build does not embed the configured release revision");
}
if (app.environment?.BUSINESS_FINLYNQ_DB_PASSWORD) fail("app exposes its database password inline");
if (app.environment?.BUSINESS_FINLYNQ_DB_PASSWORD_FILE !== "/run/secrets/business_finlynq_app_db_password") {
  fail("app does not use its dedicated database-password file");
}
if (!secretSources(app).includes(appDatabaseSecret)) fail("app does not mount its database secret");
if (secretSources(app).includes(workerDatabaseSecret)) fail("app mounts the authentication-worker database secret");
if (secretSources(app).includes(providerSecret)) fail("app mounts the email-provider credential");
for (const [gate, expected] of [
  ["DEMO_LOGIN_ENABLED", "true"],
  ["DEMO_WRITES_ENABLED", "true"],
  ["ACCOUNT_LOGIN_ENABLED", "false"],
  ["ACCOUNT_SIGNUP_ENABLED", "false"],
  ["BUSINESS_WRITES_ENABLED", "false"],
]) {
  if (app.environment?.[gate] !== expected) fail(`app release gate ${gate} must render as ${expected}`);
}

const invite = services.invite_account;
if (!invite) fail("invite_account service is missing");
if ((invite.networks ?? {}).business_finlynq_egress) fail("invite_account has outbound-network access");
if ((invite.ports ?? []).length > 0) fail("invite_account publishes a port");

if (dependencyCondition(services.reconcile_runtime_grants, "migrate") !== "service_completed_successfully") {
  fail("runtime grants are not reconciled after canonical migrations");
}
if (dependencyCondition(services.reconcile_auth_worker_grants, "reconcile_runtime_grants") !== "service_completed_successfully") {
  fail("authentication-worker grants are not reconciled after runtime grants");
}
const backupReconciler = services.reconcile_backup_grants;
if (!backupReconciler) fail("mandatory backup-role reconciliation service is missing");
if (dependencyCondition(backupReconciler, "reconcile_auth_worker_grants") !== "service_completed_successfully") {
  fail("backup grants are not reconciled after authentication-worker grants");
}
if (backupReconciler.environment?.BACKUP_DATABASE_PASSWORD_FILE !== "/run/secrets/business_finlynq_backup_db_password") {
  fail("backup-role reconciler does not use the dedicated database-password file");
}
if (!secretSources(backupReconciler).includes(backupDatabaseSecret)) {
  fail("backup-role reconciler does not mount the dedicated backup database secret");
}
if (secretSources(backupReconciler).includes(appDatabaseSecret) || secretSources(backupReconciler).includes(workerDatabaseSecret)) {
  fail("backup-role reconciler mounts an application or worker database secret");
}
if ((backupReconciler.ports ?? []).length > 0) fail("backup-role reconciler publishes a port");
if (Object.keys(backupReconciler.networks ?? {}).join(",") !== "business_finlynq_private") {
  fail("backup-role reconciler is not isolated to the private database network");
}
if (dependencyCondition(services.bootstrap_demo, "reconcile_backup_grants") !== "service_completed_successfully") {
  fail("demo bootstrap can start before grant reconciliation completes");
}

const backup = services.backup;
if (!backup) fail("backup service is missing");
const expectedOperationsImage = `business-finlynq-operations:${process.env.BUSINESS_FINLYNQ_IMAGE_REVISION}`;
if (backup.image !== expectedOperationsImage) fail("backup image is not pinned to the release operations image");
if (backup.pull_policy !== "never") fail("backup may pull an unreviewed release operations image");
if (backup.build?.args?.BUSINESS_FINLYNQ_IMAGE_REVISION !== process.env.BUSINESS_FINLYNQ_IMAGE_REVISION) {
  fail("backup image build does not embed the configured release revision");
}
if (backup.environment?.PGUSER !== "business_finlynq_backup") fail("backup does not use its dedicated role");
if (backup.environment?.PGPASSWORD) fail("backup exposes its database password inline");
if (backup.environment?.BACKUP_DATABASE_PASSWORD_FILE !== "/run/secrets/business_finlynq_backup_db_password") {
  fail("backup does not use its dedicated database-password file");
}
if (!secretSources(backup).includes(backupDatabaseSecret)) fail("backup does not mount its dedicated database secret");
if (secretSources(backup).includes(appDatabaseSecret) || secretSources(backup).includes(workerDatabaseSecret)) {
  fail("backup mounts an application or worker database secret");
}
for (const receiverSecret of [backupReceiverPrivateKeySecret, backupReceiverKnownHostsSecret]) {
  if (!secretSources(backup).includes(receiverSecret)) {
    fail(`backup does not mount receiver transport secret ${receiverSecret}`);
  }
  const consumers = Object.entries(services)
    .filter(([, service]) => secretSources(service).includes(receiverSecret))
    .map(([name]) => name)
    .sort();
  if (consumers.join(",") !== "backup") {
    fail(`receiver transport secret ${receiverSecret} must be mounted only by backup; found ${consumers.join(",") || "none"}`);
  }
}

const latestBackupVerifier = services.verify_latest_backup;
if (!latestBackupVerifier) fail("isolated latest-backup verifier service is missing");
if (latestBackupVerifier.image !== expectedOperationsImage || latestBackupVerifier.image !== backup.image) {
  fail("latest-backup verifier does not use the exact release backup image");
}
if (latestBackupVerifier.build) fail("latest-backup verifier may not build an image during monitoring");
if (latestBackupVerifier.pull_policy !== "never") fail("latest-backup verifier may pull an unreviewed image");
if ((latestBackupVerifier.command ?? []).join(" ") !== "/usr/local/bin/business-finlynq-check-latest-backup") {
  fail("latest-backup verifier does not run the reviewed checker");
}
if ((latestBackupVerifier.secrets ?? []).length > 0) fail("latest-backup verifier receives a secret");
if (latestBackupVerifier.network_mode !== "none" || Object.keys(latestBackupVerifier.networks ?? {}).length > 0) {
  fail("latest-backup verifier has network access");
}
if ((latestBackupVerifier.ports ?? []).length > 0) fail("latest-backup verifier publishes a port");
if (latestBackupVerifier.user !== "70:70") fail("latest-backup verifier does not run as backup UID 70");
if ((latestBackupVerifier.group_add ?? []).join(",") !== process.env.BUSINESS_FINLYNQ_SECRET_GID) {
  fail("latest-backup verifier lacks the sole supplemental group needed to traverse the backup directory");
}
if (latestBackupVerifier.read_only !== true || latestBackupVerifier.restart !== "no") {
  fail("latest-backup verifier is not a read-only one-shot");
}
if (!(latestBackupVerifier.cap_drop ?? []).includes("ALL")) fail("latest-backup verifier retains Linux capabilities");
if (!(latestBackupVerifier.security_opt ?? []).includes("no-new-privileges:true")) {
  fail("latest-backup verifier can gain privileges");
}
if (latestBackupVerifier.stdin_open === true || latestBackupVerifier.tty === true) {
  fail("latest-backup verifier enables interactive input or a TTY");
}
const verifierBackupMount = (latestBackupVerifier.volumes ?? [])
  .find((volume) => typeof volume === "object" && volume.target === "/backups");
if (!verifierBackupMount || verifierBackupMount.type !== "bind" || verifierBackupMount.read_only !== true) {
  fail("latest-backup verifier does not mount backup artifacts read-only");
}
const expectedMonitorBackupDirectory = process.env.MONITOR_BACKUP_DIR ?? "/var/backups/business-finlynq";
if (verifierBackupMount.source !== expectedMonitorBackupDirectory) {
  fail("latest-backup verifier does not inspect the monitored backup directory");
}
if (verifierBackupMount.bind?.create_host_path === true) {
  fail("latest-backup verifier can create a missing host backup path");
}
const composeSource = readFileSync("docker-compose.yml", "utf8").replaceAll("\r\n", "\n");
const verifierSourceStart = composeSource.indexOf("  verify_latest_backup:\n");
const verifierSourceEnd = composeSource.indexOf("\n  restore_database:\n", verifierSourceStart);
if (verifierSourceStart < 0 || verifierSourceEnd < 0) fail("latest-backup verifier source block is missing");
const verifierSource = composeSource.slice(verifierSourceStart, verifierSourceEnd);
if (!/target: \/backups\s+read_only: true\s+bind:\s+create_host_path: false/.test(verifierSource)) {
  fail("latest-backup verifier can create a missing host backup path");
}

if (services.reset_demo_sandboxes) fail("incremental demo reset service must not exist");
for (const [name, expectedMode] of [["reconcile_demo_sandboxes", "nightly"]]) {
  const service = services[name];
  if (!service) fail(`${name} service is missing`);
  if (service.build?.target !== "migrator") fail(`${name} does not use the reviewed operator image`);
  if ((service.command ?? []).join(" ") !== "npm run demo:reset") {
    fail(`${name} can pass an unreviewed command-line selector`);
  }
  if (service.environment?.DEMO_RESET_MODE !== expectedMode) fail(`${name} has the wrong reset mode`);
  if (service.environment?.BUSINESS_FINLYNQ_MIGRATION_DB_USER !== "business_finlynq_owner") {
    fail(`${name} is not explicitly bound to the migration owner`);
  }
  for (const forbiddenKey of ["DEMO_ORGANIZATION_ID", "ORGANIZATION_ID", "DEMO_SANDBOX_SLOT"]) {
    if (service.environment?.[forbiddenKey]) fail(`${name} accepts forbidden target selector ${forbiddenKey}`);
  }
  if (secretSources(service).join(",") !== rootKekSecret) {
    fail(`${name} must receive only the organization wrapping-key secret`);
  }
  if (Object.keys(service.networks ?? {}).join(",") !== "business_finlynq_private") {
    fail(`${name} is not isolated to the private database network`);
  }
  if ((service.ports ?? []).length > 0) fail(`${name} publishes a port`);
  if (service.read_only !== true || service.restart !== "no") fail(`${name} is not a hardened one-shot`);
  if (dependencyCondition(service, "database") !== "service_healthy") {
    fail(`${name} can run before the database is healthy`);
  }
}

for (const [name, service] of Object.entries(services).filter(([serviceName]) => serviceName.startsWith("restore_"))) {
  const networkNames = Object.keys(service.networks ?? {});
  if (networkNames.length !== 1 || networkNames[0] !== "business_finlynq_restore_drill") {
    fail(`${name} is not isolated to the restore-drill network`);
  }
  if ((service.ports ?? []).length > 0) fail(`${name} publishes a port`);
}

if (dependencyCondition(services.restore_migrate, "restore_verify") !== "service_completed_successfully") {
  fail("restore migrations can run before archive verification completes");
}
if (dependencyCondition(services.restore_runtime_grants, "restore_migrate") !== "service_completed_successfully") {
  fail("restore runtime grants can run before forward migrations complete");
}
if (dependencyCondition(services.restore_auth_worker_grants, "restore_runtime_grants") !== "service_completed_successfully") {
  fail("restore worker grants can run before runtime grant reconciliation");
}
const restoreBackupReconciler = services.restore_backup_grants;
if (!restoreBackupReconciler) fail("restore backup-role reconciliation service is missing");
if (dependencyCondition(restoreBackupReconciler, "restore_auth_worker_grants") !== "service_completed_successfully") {
  fail("restore backup grants can run before worker grant reconciliation");
}
if (restoreBackupReconciler.environment?.RESTORE_RECONCILIATION_TARGET !== "backup") {
  fail("restore backup reconciler is not pinned to the backup target");
}
if (restoreBackupReconciler.environment?.BACKUP_DATABASE_PASSWORD_FILE !== "/run/secrets/business_finlynq_backup_db_password") {
  fail("restore backup reconciler does not use the dedicated password file");
}
if (!secretSources(restoreBackupReconciler).includes(backupDatabaseSecret)) {
  fail("restore backup reconciler does not mount the dedicated backup secret");
}
if (secretSources(restoreBackupReconciler).includes(appDatabaseSecret) || secretSources(restoreBackupReconciler).includes(workerDatabaseSecret)) {
  fail("restore backup reconciler mounts an application or worker database secret");
}
const restoreDemoBootstrap = services.restore_demo_bootstrap;
if (!restoreDemoBootstrap) fail("restore demo bootstrap service is missing");
if (dependencyCondition(restoreDemoBootstrap, "restore_key_verify") !== "service_completed_successfully") {
  fail("restore demo bootstrap can run before restored key material is verified");
}
const restoreDemoCommand = (restoreDemoBootstrap.command ?? []).join(" ");
if (!restoreDemoCommand.includes("npm run demo:bootstrap") || !restoreDemoCommand.includes("DEMO_RESET_MODE=nightly exec npm run demo:reset")) {
  fail("restore demo bootstrap does not recreate and fully reconcile the sandbox pool");
}
const restoreDemoSecrets = secretSources(restoreDemoBootstrap).sort();
const expectedRestoreDemoSecrets = ["business_finlynq_restore_db_password", rootKekSecret].sort();
if (restoreDemoSecrets.join(",") !== expectedRestoreDemoSecrets.join(",")) {
  fail("restore demo bootstrap receives credentials outside the restore owner and wrapping key");
}
if (dependencyCondition(services.restore_key_verify, "restore_backup_grants") !== "service_completed_successfully") {
  fail("restore key verification can race archive restore or role reconciliation");
}
if (dependencyCondition(services.restore_runtime_verify, "restore_app") !== "service_healthy") {
  fail("restored runtime acceptance can run before the restored app is healthy");
}
for (const disabledGate of ["DEMO_WRITES_ENABLED", "ACCOUNT_LOGIN_ENABLED", "ACCOUNT_SIGNUP_ENABLED", "SIGNUP_TURNSTILE_ENABLED", "BUSINESS_WRITES_ENABLED"]) {
  if (services.restore_app?.environment?.[disabledGate] !== "false") {
    fail(`restored app does not force ${disabledGate} off`);
  }
}
if (dependencyCondition(services.restore_app, "restore_demo_bootstrap") !== "service_completed_successfully") {
  fail("restored app can start before the sandbox pool is rebuilt");
}
if (services.restore_runtime_verify?.environment?.BACKUP_DATABASE_PASSWORD_FILE !== "/run/secrets/business_finlynq_backup_db_password") {
  fail("restored runtime acceptance cannot validate the backup role");
}
if (!secretSources(services.restore_runtime_verify).includes(backupDatabaseSecret)) {
  fail("restored runtime acceptance does not mount the backup-role credential");
}

const rollbackRendered = execFileSync(
  "docker",
  [
    "compose",
    "-f", "docker-compose.yml",
    "-f", "deploy/rollback/docker-compose.legacy-inline-password.yml",
    "config",
    "--format", "json",
  ],
  {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      ROLLBACK_COMPATIBILITY_ACK: "f8485-one-release-only",
    },
  },
);
const rollbackApp = JSON.parse(rollbackRendered).services?.app;
if (!rollbackApp) fail("legacy rollback app override is missing");
if (rollbackApp.image !== "sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5") {
  fail("legacy rollback override is not pinned to the recorded f8485 production image ID");
}
if (rollbackApp.build) fail("legacy rollback override can rebuild the current worktree instead of using the retained image");
if (rollbackApp.environment?.BUSINESS_FINLYNQ_DB_PASSWORD) fail("legacy rollback override exposes the app password in rendered Compose");
if (rollbackApp.environment?.BUSINESS_FINLYNQ_DB_PASSWORD_FILE !== "/run/secrets/business_finlynq_app_db_password") {
  fail("legacy rollback override does not retain the mounted app password file");
}
if (rollbackApp.environment?.BUSINESS_FINLYNQ_IMAGE_REVISION !== "f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107") {
  fail("legacy rollback override is not pinned to the reviewed prior revision");
}
for (const disabledFlag of ["DEMO_LOGIN_ENABLED", "DEMO_WRITES_ENABLED", "ACCOUNT_LOGIN_ENABLED", "ACCOUNT_SIGNUP_ENABLED", "SIGNUP_TURNSTILE_ENABLED", "AUTH_EMAIL_DELIVERY_ENABLED", "BUSINESS_WRITES_ENABLED"]) {
  if (rollbackApp.environment?.[disabledFlag] !== "false") fail(`legacy rollback override does not force ${disabledFlag} off`);
}
if ((rollbackApp.entrypoint ?? []).join(" ") !== "/bin/sh /usr/local/bin/business-finlynq-legacy-db-password") {
  fail("legacy rollback override does not use the restricted file-to-process adapter");
}

const rehearsalRendered = execFileSync(
  "docker",
  [
    "compose",
    "-f", "docker-compose.yml",
    "-f", "deploy/rollback/docker-compose.restore-rehearsal.yml",
    "--profile", "restore-drill",
    "config",
    "--format", "json",
  ],
  {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ROLLBACK_COMPATIBILITY_ACK: "f8485-one-release-only" },
  },
);
const rehearsalServices = JSON.parse(rehearsalRendered).services ?? {};
const rehearsalApp = rehearsalServices.rollback_rehearsal_app;
const rehearsalVerify = rehearsalServices.rollback_rehearsal_verify;
if (!rehearsalApp || !rehearsalVerify) fail("isolated legacy restore rehearsal services are missing");
if (rehearsalApp.image !== "sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5") {
  fail("restore rehearsal is not pinned to the recorded f8485 production image ID");
}
for (const [name, service] of [["rollback_rehearsal_app", rehearsalApp], ["rollback_rehearsal_verify", rehearsalVerify]]) {
  const networkNames = Object.keys(service.networks ?? {});
  if (networkNames.length !== 1 || networkNames[0] !== "business_finlynq_restore_drill") {
    fail(`${name} is not isolated to the restore-drill network`);
  }
  if ((service.ports ?? []).length > 0) fail(`${name} publishes a port`);
}
if (!secretSources(rehearsalApp).includes(appDatabaseSecret)) fail("restore rehearsal does not mount the app password file");
if (secretSources(rehearsalApp).includes(providerSecret) || secretSources(rehearsalApp).includes(turnstileSecret) || secretSources(rehearsalApp).includes(workerDatabaseSecret)) {
  fail("restore rehearsal receives an unrelated provider, challenge, or worker credential");
}
for (const disabledFlag of ["DEMO_LOGIN_ENABLED", "DEMO_WRITES_ENABLED", "ACCOUNT_LOGIN_ENABLED", "ACCOUNT_SIGNUP_ENABLED", "SIGNUP_TURNSTILE_ENABLED", "AUTH_EMAIL_DELIVERY_ENABLED", "BUSINESS_WRITES_ENABLED"]) {
  if (rehearsalApp.environment?.[disabledFlag] !== "false") fail(`restore rehearsal does not force ${disabledFlag} off`);
}
if ((rehearsalVerify.secrets ?? []).length > 0) fail("legacy restore verifier receives a secret");
if (dependencyCondition(rehearsalVerify, "rollback_rehearsal_app") !== "service_healthy") {
  fail("legacy restore verification can run before the hard-pinned app is healthy");
}

process.stdout.write("Compose credential and network boundaries verified\n");
