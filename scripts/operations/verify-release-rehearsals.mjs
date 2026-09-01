import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

function fail(message) {
  throw new Error(`Release rehearsal evidence verification failed: ${message}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function verifyChecksums(directory) {
  const checksumText = await readFile(resolve(directory, "SHA256SUMS"), "utf8");
  const records = checksumText.trim().split("\n").filter(Boolean);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS")
    .map((entry) => entry.name)
    .sort();
  const recorded = [];
  for (const record of records) {
    const match = record.match(/^([a-f0-9]{64})  \.\/(.+)$/);
    if (!match) fail(`${basename(directory)} has a malformed checksum record`);
    const [, expected, name] = match;
    if (name.includes("/") || name === "SHA256SUMS") fail(`${basename(directory)} checksum target is unsafe`);
    const actual = createHash("sha256").update(await readFile(resolve(directory, name))).digest("hex");
    if (actual !== expected) fail(`${basename(directory)}/${name} failed checksum verification`);
    recorded.push(name);
  }
  if (recorded.sort().join("\n") !== files.join("\n")) fail(`${basename(directory)} checksum inventory is incomplete`);
}

const requiredRehearsalFiles = [
  "00-release-plan.json",
  "01-clean-environment.log",
  "02-clean-environment.json",
  "03-candidate-git-tree.txt",
  "04-staged-tree-sha256.txt",
  "10-image-build.log",
  "11-images.json",
  "12-rollback-artifact.json",
  "25-stop-write-surfaces.log",
  "26-write-surfaces-stopped.json",
  "29-rehearsal-database-start.log",
  "29-rehearsal-database-image.json",
  "30-provision-backup-role.log",
  "31-encrypted-backup.log",
  "32-backup-verification.log",
  "33-backup-evidence.json",
  "34-database-start.log",
  "35-database-image.json",
  "49-pretraffic-reset.log",
  "50-pretraffic-up.log",
  "51-pretraffic-wait.log",
  "52-pretraffic-services.log",
  "53-pretraffic-verification.json",
  "54-bootstrap-reset.log",
  "55-bootstrap-up.log",
  "56-bootstrap-wait.log",
  "57-post-bootstrap-accounting-reset.log",
  "58-post-bootstrap-accounting-up.log",
  "59-post-bootstrap-accounting-wait.log",
  "59-post-bootstrap-accounting-services.log",
  "60-quiesced-app-start.log",
  "61-quiesced-readiness.json",
  "63-app-start.log",
  "64-internal-readiness.json",
  "65-public-readiness.headers",
  "65-public-readiness.json",
  "70-browser-acceptance.log",
  "71-browser-acceptance.json",
  "72-final-app-start.log",
  "73-final-readiness.json",
  "80-clean-rehearsal.log",
  "90-release-complete.json",
];

function expectObject(value, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${description} is not an object`);
  return value;
}

function expectCheckpoint(value, identity, stage, description) {
  const selected = expectObject(value, description);
  if (selected.schemaVersion !== 1 || selected.product !== "business-finlynq"
    || selected.mode !== "rehearsal" || selected.revision !== identity.revision
    || selected.runId !== identity.runId || selected.stage !== stage
    || typeof selected.completedAt !== "string") {
    fail(`${description} has invalid identity or stage fields`);
  }
}

async function verifyDirectory(directory) {
  await verifyChecksums(directory);
  const inventory = new Set((await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name));
  for (const required of requiredRehearsalFiles) {
    if (!inventory.has(required)) fail(`${basename(directory)} lacks runner evidence ${required}`);
  }

  const plan = await readJson(resolve(directory, "00-release-plan.json"));
  const complete = await readJson(resolve(directory, "90-release-complete.json"));
  if (plan.schemaVersion !== 1 || plan.product !== "business-finlynq"
    || plan.status !== "started" || plan.mode !== "rehearsal" || plan.cleanEnvironment !== true
    || typeof plan.startedAt !== "string" || !/^[a-f0-9]{40}$/.test(plan.revision)
    || !/^[a-f0-9]{40,64}$/.test(plan.candidateTreeId)
    || !/^[a-f0-9]{64}$/.test(plan.gitTreeManifestSha256)
    || !/^[a-f0-9]{64}$/.test(plan.stagedTreeManifestSha256)
    || !/^rehearsal-[a-z0-9._-]{1,21}$/.test(plan.runId)
    || plan.composeProject !== `business-finlynq-${plan.runId.replaceAll("_", "-")}`
    || !/^[a-f0-9]{64}$/.test(plan.composeConfigurationSha256)
    || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(plan.acceptanceBaseUrl)) {
    fail(`${basename(directory)} does not satisfy the clean rehearsal evidence format`);
  }
  const gitTreeManifest = await readFile(resolve(directory, "03-candidate-git-tree.txt"));
  const stagedTreeManifest = await readFile(resolve(directory, "04-staged-tree-sha256.txt"));
  if (createHash("sha256").update(gitTreeManifest).digest("hex") !== plan.gitTreeManifestSha256
    || createHash("sha256").update(stagedTreeManifest).digest("hex") !== plan.stagedTreeManifestSha256) {
    fail(`${basename(directory)} staged Git-tree manifests disagree with the release plan`);
  }
  if (complete.status !== "accepted" || complete.mode !== "rehearsal") fail(`${basename(directory)} is not accepted`);
  if (complete.revision !== plan.revision || complete.runId !== plan.runId) fail(`${basename(directory)} identity fields disagree`);
  if (complete.preTrafficDatabaseContractVerified !== true
    || complete.postBootstrapAccountingEvidenceVerified !== true
    || complete.browserAcceptancePassed !== true) {
    fail(`${basename(directory)} lacks database or browser acceptance`);
  }
  if (complete.schemaVersion !== 1 || complete.product !== "business-finlynq"
    || complete.databaseRollback !== "forward-repair-only"
    || typeof complete.completedAt !== "string" || !/^[a-f0-9]{64}$/.test(complete.browserLogSha256)
    || !/^sha256:[a-f0-9]{64}$/.test(complete.candidateAppImageId)
    || complete.previousAppImageId !== null) {
    fail(`${basename(directory)} completion record is incomplete`);
  }

  const identity = { revision: plan.revision, runId: plan.runId };
  expectCheckpoint(await readJson(resolve(directory, "02-clean-environment.json")), identity,
    "clean-environment-confirmed", `${basename(directory)} clean checkpoint`);
  expectCheckpoint(await readJson(resolve(directory, "26-write-surfaces-stopped.json")), identity,
    "write-surfaces-stopped-before-backup", `${basename(directory)} quiesce checkpoint`);
  expectCheckpoint(await readJson(resolve(directory, "71-browser-acceptance.json")), identity,
    "browser-acceptance-passed", `${basename(directory)} browser checkpoint`);

  const imageRecord = expectObject(await readJson(resolve(directory, "11-images.json")), `${basename(directory)} image record`);
  const expectedImages = new Map([
    ["database", `business-finlynq-database:${plan.revision}`],
    ["app", `business-finlynq-app:${plan.revision}`],
    ["migrator", `business-finlynq-migrator:${plan.revision}`],
    ["authWorker", `business-finlynq-auth-worker:${plan.revision}`],
    ["operations", `business-finlynq-operations:${plan.revision}`],
    ["acceptance", `business-finlynq-acceptance:${plan.revision}`],
  ]);
  if (imageRecord.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(imageRecord.pinnedComposeConfigurationSha256)
    || !Array.isArray(imageRecord.images)
    || imageRecord.images.length !== expectedImages.size) fail(`${basename(directory)} image inventory is incomplete`);
  const imageIds = new Map();
  for (const selected of imageRecord.images) {
    const expectedReference = expectedImages.get(selected?.name);
    if (!expectedReference || selected.reference !== expectedReference
      || selected.ociRevision !== plan.revision || !/^sha256:[a-f0-9]{64}$/.test(selected.imageId)
      || imageIds.has(selected.name)) fail(`${basename(directory)} image evidence is invalid`);
    imageIds.set(selected.name, selected.imageId);
  }
  if (complete.candidateAppImageId !== imageIds.get("app")) fail(`${basename(directory)} candidate image identity disagrees`);
  for (const evidenceName of ["29-rehearsal-database-image.json", "35-database-image.json"]) {
    const databaseUse = expectObject(
      await readJson(resolve(directory, evidenceName)),
      `${basename(directory)} ${evidenceName}`,
    );
    if (Object.keys(databaseUse).sort().join(",") !== "imageId,product,revision,schemaVersion,service,verifiedAt"
      || databaseUse.schemaVersion !== 1 || databaseUse.product !== "business-finlynq"
      || databaseUse.service !== "database" || databaseUse.revision !== plan.revision
      || databaseUse.imageId !== imageIds.get("database")
      || typeof databaseUse.verifiedAt !== "string"
      || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(databaseUse.verifiedAt)) {
      fail(`${basename(directory)} ${evidenceName} does not prove use of the reviewed database image`);
    }
  }

  const rollback = expectObject(await readJson(resolve(directory, "12-rollback-artifact.json")), `${basename(directory)} rollback record`);
  if (rollback.schemaVersion !== 1 || rollback.previous !== null
    || rollback.databaseRollback !== "forward-repair-only"
    || rollback.rollbackTool !== "deploy/release/run-application-rollback.sh"
    || rollback.candidate?.revision !== plan.revision
    || rollback.candidate?.imageId !== imageIds.get("app")) fail(`${basename(directory)} rollback evidence is invalid`);

  const backup = expectObject(await readJson(resolve(directory, "33-backup-evidence.json")), `${basename(directory)} backup record`);
  if (backup.schemaVersion !== 1 || backup.product !== "business-finlynq"
    || backup.applicationRevision !== plan.revision || backup.sourceApplicationRevision !== plan.revision
    || backup.backupToolRevision !== plan.revision || backup.encryption !== "age"
    || backup.format !== "postgres-custom" || !/^[a-f0-9]{64}$/.test(backup.sha256)
    || typeof backup.encryptedArchive !== "string" || !Number.isSafeInteger(backup.encryptedBytes)
    || backup.encryptedBytes <= 0) fail(`${basename(directory)} backup evidence is invalid`);

  const pretraffic = expectObject(await readJson(resolve(directory, "53-pretraffic-verification.json")), `${basename(directory)} pretraffic record`);
  const serviceImages = new Map([
    ["provision_auth_worker_role", imageIds.get("operations")],
    ["migrate", imageIds.get("migrator")],
    ["reconcile_runtime_grants", imageIds.get("operations")],
    ["reconcile_auth_worker_grants", imageIds.get("operations")],
    ["reconcile_backup_grants", imageIds.get("operations")],
    ["verify_database_contract", imageIds.get("migrator")],
    ["verify_accounting_evidence", imageIds.get("operations")],
    ["bootstrap_demo", imageIds.get("migrator")],
    ["verify_accounting_evidence_post_bootstrap", imageIds.get("operations")],
  ]);
  if (pretraffic.schemaVersion !== 1 || pretraffic.trafficBlocked !== true
    || pretraffic.postBootstrapAccountingEvidenceVerified !== true
    || pretraffic.databaseRollback !== "forward-repair-only" || !Array.isArray(pretraffic.services)
    || pretraffic.services.length !== serviceImages.size) fail(`${basename(directory)} pretraffic inventory is incomplete`);
  const seenServices = new Set();
  for (const service of pretraffic.services) {
    if (!serviceImages.has(service?.service) || seenServices.has(service.service)
      || service.exitCode !== 0 || service.imageId !== serviceImages.get(service.service)) {
      fail(`${basename(directory)} pretraffic service evidence is invalid`);
    }
    seenServices.add(service.service);
  }

  for (const readinessName of ["61-quiesced-readiness.json", "64-internal-readiness.json", "73-final-readiness.json"]) {
    const readiness = expectObject(await readJson(resolve(directory, readinessName)), `${basename(directory)} ${readinessName}`);
    if (readiness.status !== "ready" || readiness.revision !== plan.revision || !readiness.checks) {
      fail(`${basename(directory)} ${readinessName} is invalid`);
    }
  }
  const quiesced = await readJson(resolve(directory, "61-quiesced-readiness.json"));
  for (const check of ["accountAuthentication", "accountSignup", "emailWorker", "bankFeeds"]) {
    if (quiesced.checks[check] !== "disabled") fail(`${basename(directory)} quiesced readiness enabled ${check}`);
  }
  const publicReadiness = await readJson(resolve(directory, "65-public-readiness.json"));
  if (JSON.stringify(publicReadiness) !== JSON.stringify({ status: "ready" })) {
    fail(`${basename(directory)} public readiness is not minimal`);
  }
  const publicHeaders = await readFile(resolve(directory, "65-public-readiness.headers"), "utf8");
  if (!/^cache-control:.*no-store/im.test(publicHeaders)) fail(`${basename(directory)} public readiness headers are incomplete`);
  const browserLog = await readFile(resolve(directory, "70-browser-acceptance.log"));
  const browserLogSha256 = createHash("sha256").update(browserLog).digest("hex");
  if (browserLogSha256 !== complete.browserLogSha256) fail(`${basename(directory)} browser log digest disagrees`);
  return { revision: complete.revision, runId: complete.runId };
}

const directories = process.argv.slice(2).map((path) => resolve(path));
if (directories.length !== 2 || directories[0] === directories[1]) {
  fail("pass exactly two distinct evidence directories");
}
const [first, second] = await Promise.all(directories.map(verifyDirectory));
if (first.revision !== second.revision) fail("the two rehearsals target different revisions");
if (first.runId === second.runId) fail("the two rehearsals are not independent runs");
process.stdout.write(`Two independent clean release rehearsals accepted for ${first.revision}\n`);
