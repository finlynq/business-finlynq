import { execFileSync } from "node:child_process";

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
    "--profile", "restore-drill",
    "config",
    "--format", "json",
  ],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const configuration = JSON.parse(rendered);
const services = configuration.services ?? {};
const providerSecret = "business_finlynq_resend_api_key";
const appDatabaseSecret = "business_finlynq_app_db_password";
const workerDatabaseSecret = "business_finlynq_auth_worker_db_password";

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
if (app.environment?.BUSINESS_FINLYNQ_DB_PASSWORD) fail("app exposes its database password inline");
if (app.environment?.BUSINESS_FINLYNQ_DB_PASSWORD_FILE !== "/run/secrets/business_finlynq_app_db_password") {
  fail("app does not use its dedicated database-password file");
}
if (!secretSources(app).includes(appDatabaseSecret)) fail("app does not mount its database secret");
if (secretSources(app).includes(workerDatabaseSecret)) fail("app mounts the authentication-worker database secret");
if (secretSources(app).includes(providerSecret)) fail("app mounts the email-provider credential");

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
if (dependencyCondition(services.bootstrap_demo, "reconcile_auth_worker_grants") !== "service_completed_successfully") {
  fail("demo bootstrap can start before grant reconciliation completes");
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
if (dependencyCondition(services.restore_key_verify, "restore_auth_worker_grants") !== "service_completed_successfully") {
  fail("restore key verification can race archive restore or role reconciliation");
}
if (dependencyCondition(services.restore_runtime_verify, "restore_app") !== "service_healthy") {
  fail("restored runtime acceptance can run before the restored app is healthy");
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
for (const disabledFlag of ["ACCOUNT_LOGIN_ENABLED", "AUTH_EMAIL_DELIVERY_ENABLED", "BUSINESS_WRITES_ENABLED"]) {
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
if (secretSources(rehearsalApp).includes(providerSecret) || secretSources(rehearsalApp).includes(workerDatabaseSecret)) {
  fail("restore rehearsal receives an unrelated provider or worker credential");
}
if ((rehearsalVerify.secrets ?? []).length > 0) fail("legacy restore verifier receives a secret");
if (dependencyCondition(rehearsalVerify, "rollback_rehearsal_app") !== "service_healthy") {
  fail("legacy restore verification can run before the hard-pinned app is healthy");
}

process.stdout.write("Compose credential and network boundaries verified\n");
