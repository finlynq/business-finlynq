import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("production recovery evidence contract", () => {
  it("allows operators to tighten but never weaken the recorded RPO or RTO", () => {
    const recorder = source("deploy/backup/record-restore-evidence.sh");
    const drill = source("deploy/backup/run-restore-drill.sh");
    const fixture = source("deploy/backup/test-restore-evidence-recorder.sh");
    for (const contract of [recorder, drill]) {
      expect(contract).toContain("RESTORE_RPO_SECONDS <= 21600");
      expect(contract).toContain("RESTORE_RTO_SECONDS <= 14400");
    }
    expect(fixture).toContain("accepted a weakened production RPO");
    expect(fixture).toContain("accepted a weakened production RTO");
    expect(recorder).toContain('result="verified-diagnostic-no-offsite"');
    expect(recorder).toContain('result="verified-diagnostic-empty-secret-fixtures"');
    expect(recorder).toContain("productionRecoveryEvidence");
    expect(fixture).toContain(".productionRecoveryEvidence == false");
  });

  it("propagates empty encrypted fixture diagnostics without weakening production evidence", () => {
    const wrapper = source("deploy/backup/run-restore-drill.sh");
    const compose = source("docker-compose.yml");
    const recorder = source("deploy/backup/record-restore-evidence.sh");
    const fixture = source("deploy/backup/test-restore-evidence-recorder.sh");

    expect(wrapper).toContain(
      'RESTORE_ALLOW_EMPTY_SECRET_FIXTURES="${RESTORE_ALLOW_EMPTY_SECRET_FIXTURES:-false}"',
    );
    expect(wrapper).toContain("export RESTORE_ALLOW_EMPTY_SECRET_FIXTURES");
    expect(compose).toContain(
      "RESTORE_ALLOW_EMPTY_SECRET_FIXTURES: ${RESTORE_ALLOW_EMPTY_SECRET_FIXTURES:-false}",
    );
    expect(recorder).toContain('RESTORE_ALLOW_EMPTY_SECRET_FIXTURES="${RESTORE_ALLOW_EMPTY_SECRET_FIXTURES:-false}"');
    expect(recorder).toContain('result="verified-diagnostic-empty-secret-fixtures"');
    expect(recorder).toContain("production_recovery_evidence=false");
    expect(recorder).toContain("--argjson keyRecoveryVerified");
    expect(fixture).toContain("accepted diagnostic key evidence without the explicit escape");
    expect(fixture).toContain('.result == "verified-diagnostic-empty-secret-fixtures"');
    expect(fixture).toContain(".productionRecoveryEvidence == false");
    expect(fixture).toContain(".checks.keyRecovery == false");
  });

  it("versions and verifies every historical audit hash-material family", () => {
    const migration = compact(source("migrations/drizzle/0032_observability_correlation_metrics.sql"));
    const schema = source("src/db/schema/audit.ts");
    const query = compact(source("scripts/operations/accounting-evidence-query.sql"));

    for (const version of ["tenant-business-v1", "journal-posted-v1", "period-transition-v1"]) {
      expect(migration).toContain(version);
      expect(schema).toContain(version);
      expect(query).toContain(version);
    }
    expect(migration).toContain("Existing business audit history does not match its canonical hash-material contract");
    expect(migration).toContain("CREATE TRIGGER audit_events_hash_material_version");
    expect(query).toContain(
      "audit.entity_id || audit.request_id || audit.action || audit.safe_metadata::text",
    );
    expect(query).toContain(
      "audit.entity_id || audit.request_id || audit.action WHEN 'period-transition-v1'",
    );
    expect(query).toContain("contract.event_hash IS DISTINCT FROM contract.expected_event_hash");
  });

  it("locks the audit table and restores its append-only guard before hash verification", () => {
    const migration = source("migrations/drizzle/0032_observability_correlation_metrics.sql");
    const orderedMarkers = [
      "LOCK TABLE public.audit_events IN SHARE ROW EXCLUSIVE MODE;",
      "DISABLE TRIGGER audit_events_append_only;",
      "UPDATE public.audit_events AS audit",
      "ENABLE TRIGGER audit_events_append_only;",
      "DO $audit_hash_material_preflight$",
    ];
    const positions = orderedMarkers.map((marker) => migration.indexOf(marker));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(migration).not.toContain("session_replication_role");
  });

  it("pins the canonical v1 digest preimages independently of topology", () => {
    const previous = "a".repeat(64);
    const organization = "11111111-1111-4111-8111-111111111111";
    const entity = "22222222-2222-4222-8222-222222222222";
    const request = "33333333-3333-4333-8333-333333333333";
    const digest = (material: string) => createHash("sha256").update(material, "utf8").digest("hex");

    expect(digest(
      previous + organization + entity + request +
      "organization.settings-updated" + '{"settingsVersion": 2}',
    )).toBe("d2704d7b4b49a4edd6ef60021acee6a39fd431acb2e372f9751d4162fc8932af");
    expect(digest(previous + organization + entity + request + "journal.posted"))
      .toBe("37e661fda8aca21009541724442b9e5654b6d11a05a02e7820985bd46f61c5f6");
    expect(digest(previous + organization + entity + request + "period.transition"))
      .toBe("ba8db97b82f9c1554e2e2371f18603a2a946469b2f3de12267c81ae00fc6b968");
  });

  it("keeps event material out of the aggregate verifier projection", () => {
    const query = source("scripts/operations/accounting-evidence-query.sql");
    const projection = query.slice(query.lastIndexOf("\nSELECT\n"));
    for (const sensitive of ["safe_metadata", "payload", "request_id", "entity_id", "event_hash"]) {
      expect(projection).not.toContain(sensitive);
    }
  });

  it("covers every durable subledger audit/outbox pair", () => {
    const query = source("scripts/operations/accounting-evidence-query.sql");
    const migration = source("migrations/drizzle/0032_observability_correlation_metrics.sql");
    for (const pair of [
      "subledger.settlement-allocation-apply",
      "subledger.settlement-allocation-reversal",
      "receivables.source-document-draft",
      "receivables.source-document-posted",
      "receivables.source-document-voided",
      "payables.source-document-draft",
      "payables.source-document-posted",
      "payables.source-document-voided",
    ]) {
      expect(migration).toContain(pair);
    }
    expect(query).toContain("FROM public.audit_outbox_pair_contract AS contract");
    expect(query).not.toContain("VALUES\n    ('journal.draft-created'");
  });

  it("uses one owner-only versioned contract for every required pair", () => {
    const migration = source("migrations/drizzle/0032_observability_correlation_metrics.sql");
    const schema = source("src/db/schema/audit.ts");
    const rows = [...migration.matchAll(
      /\('([^']+)', '([^']+)', '([^']+)', 'business-audit-outbox-v1'\)/g,
    )].map((match) => match.slice(1, 4).join("|"));

    expect(rows).toHaveLength(24);
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows).toContain(
      "organization.member-sessions-revoked|organization.member-sessions-revoked|organization_membership",
    );
    for (const auditOnly of [
      "accounting.currency.configuration_changed",
      "accounting.hierarchy.published",
      "banking.connection.created",
    ]) {
      expect(rows.some((row) => row.startsWith(`${auditOnly}|`))).toBe(false);
    }
    expect(migration).toContain("audit_outbox_pair_contract_owner_only_policy");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(schema).toContain("auditOutboxPairContract");
    expect(schema).toContain("outbox_events_topic_aggregate_contract_fk");
    expect(schema).toContain("outbox_events_audit_pair_unique");
  });

  it("backfills only pre-G0 NULL correlation from paired immutable evidence", () => {
    const migration = source("migrations/drizzle/0032_observability_correlation_metrics.sql");
    const backfill = migration.slice(
      migration.indexOf("-- BEGIN OUTBOX REQUEST CORRELATION BACKFILL"),
      migration.indexOf("-- END OUTBOX REQUEST CORRELATION BACKFILL"),
    );

    expect(backfill).toContain("audit.safe_metadata <@ outbox.payload");
    expect(backfill).toContain("candidate.candidate_count = 1");
    expect(backfill).toContain("cannot be correlated unambiguously");
    expect(backfill).toContain("audit.occurred_at = outbox.created_at");
    expect(backfill).toContain("outbox.request_id IS NULL");
    expect(backfill).not.toContain("audit.xmin");
    expect(backfill).not.toContain("'legacy:' || outbox.id::text");
  });

  it("binds new outbox correlation to the exact paired audit action", () => {
    const migration = source("migrations/drizzle/0032_observability_correlation_metrics.sql");
    const trigger = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION app.enforce_outbox_request_correlation"),
      migration.indexOf("CREATE TRIGGER outbox_events_request_correlation"),
    );

    expect(trigger).toContain("FROM public.audit_outbox_pair_contract AS contract");
    expect(trigger).toContain("contract.outbox_topic = NEW.topic");
    expect(trigger).toContain("audit.action = expected_action");
    expect(trigger).toContain("audit.request_id = request_context");
    expect(trigger).toContain("NEW.topic <> 'ledger.journal-posted'");
    expect(trigger).toContain("request_context := NEW.request_id");
  });

  it("enforces paired audits in both directions while retaining audit-only actions", () => {
    const migration = source("migrations/drizzle/0032_observability_correlation_metrics.sql");
    const query = source("scripts/operations/accounting-evidence-query.sql");

    expect(migration).toContain("CREATE CONSTRAINT TRIGGER audit_events_required_outbox");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("The absence of a contract row deliberately means this action is audit-only");
    expect(query).toContain("audit_without_required_outbox_count");
    expect(query).toContain("outbox_without_correct_audit_count");
    expect(query).toContain("invalid_outbox_contract_count");
    expect(query).toContain("contract.audit_action");
  });

  it("serializes and bounds full-history accounting verification", () => {
    const query = source("scripts/operations/accounting-evidence-query.sql");
    const verifier = source("deploy/backup/verify-accounting-evidence.sh");
    const scheduled = source("deploy/monitoring/run-accounting-evidence-check.sh");

    expect(query).toContain("pg_advisory_lock");
    expect(verifier).toContain("ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS");
    expect(verifier).toContain('PGOPTIONS="-c statement_timeout=');
    expect(scheduled).toContain("flock --exclusive");
    expect(scheduled).toContain("ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS");
    expect(scheduled).toContain("business_finlynq_accounting_evidence_verification_last_success_unixtime");
  });

  it("retains accounting evidence before any demo mutation and repeats it at runtime", () => {
    const drill = source("deploy/backup/run-restore-drill.sh");
    const recorder = source("deploy/backup/record-restore-evidence.sh");
    const accounting = "restore_compose --profile restore-drill run --rm --no-deps --no-build restore_accounting_verify";
    const key = "restore_compose --profile restore-drill run --rm --no-deps --no-build restore_key_verify";
    const demo = "restore_compose --profile restore-drill run --rm --no-deps --no-build restore_demo_bootstrap";

    expect(drill.indexOf(accounting)).toBeGreaterThan(-1);
    expect(drill.indexOf(accounting)).toBeLessThan(drill.indexOf(key));
    expect(drill.indexOf(key)).toBeLessThan(drill.indexOf(demo));
    expect(drill).toContain("restore_runtime_verify");
    expect(recorder).toContain("accounting-prebootstrap_");
    expect(recorder).toContain("preBootstrapAuditOutboxIntegrity: true");
    expect(recorder).toContain(".checks.auditHashRecomputation == true");
  });

  it("takes a host-wide restore lock before any Compose cleanup or start", () => {
    const drill = source("deploy/backup/run-restore-drill.sh");
    const lock = drill.indexOf('flock --exclusive --wait "$RESTORE_DRILL_LOCK_WAIT_SECONDS" 8');
    const cleanup = drill.indexOf("\nremove_restore_services\n");
    expect(drill).toContain("/var/lib/business-finlynq/restore-drill.lock");
    expect(lock).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(lock);
  });

  it("pins every restore service to captured immutable IDs before Docker mutation", () => {
    const drill = source("deploy/backup/run-restore-drill.sh");
    const capture = drill.indexOf('RESTORE_OPERATIONS_IMAGE_ID="$(verify_recovery_image');
    const override = drill.indexOf('RESTORE_IMAGE_OVERRIDE_FILE="$(mktemp');
    const firstMutation = drill.indexOf("\nremove_restore_services\n");
    expect(capture).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(capture);
    expect(firstMutation).toBeGreaterThan(override);
    expect(drill).toContain("build: !reset null");
    expect(drill).toContain("pinned_restore_images");
    expect(drill).toContain("DOCKER_HOST DOCKER_CONTEXT COMPOSE_FILE");
    expect(drill).not.toMatch(/docker compose --profile restore-drill (?:rm|run|up)/);
    for (const service of [
      "restore_verify", "restore_migrate", "restore_runtime_grants",
      "restore_auth_worker_grants", "restore_backup_grants", "restore_accounting_verify",
      "restore_demo_bootstrap", "restore_key_verify", "restore_app",
      "restore_runtime_verify", "restore_evidence",
    ]) {
      expect(drill).toContain(`${service}:`);
    }
  });

  it("runs both restore paths from a clean exact private Git snapshot", () => {
    for (const path of [
      "deploy/backup/run-restore-drill.sh",
      "deploy/rollback/run-legacy-restore-rehearsal.sh",
    ]) {
      const wrapper = source(path);
      const headCheck = wrapper.indexOf("rev-parse --verify HEAD");
      const dirtyCheck = wrapper.indexOf("status --porcelain=v1 --untracked-files=all");
      const snapshot = wrapper.indexOf("archive --format=tar");
      const projectDirectory = wrapper.indexOf("--project-directory");
      const firstContainerMutation = Math.min(
        ...[" up --detach", " run --rm", " rm --stop"]
          .map((needle) => wrapper.indexOf(needle))
          .filter((position) => position >= 0),
      );

      expect(headCheck).toBeGreaterThan(-1);
      expect(wrapper).toContain('== "$BUSINESS_FINLYNQ_IMAGE_REVISION"');
      expect(dirtyCheck).toBeGreaterThan(headCheck);
      expect(snapshot).toBeGreaterThan(dirtyCheck);
      expect(projectDirectory).toBeGreaterThan(snapshot);
      expect(firstContainerMutation).toBeGreaterThan(projectDirectory);
      expect(wrapper).toContain("--env-file /dev/null");
      expect(wrapper).not.toContain('--file "$repository_root/docker-compose.yml"');
    }
  });

  it("preflights non-secret restore artifacts and report access for uid/gid 70", () => {
    const drill = source("deploy/backup/run-restore-drill.sh");
    expect(drill).toContain('restore_container_gid="70"');
    expect(drill).toContain('== "$restore_container_gid:750"');
    expect(drill).toContain('== "$restore_operator_uid:$restore_container_gid:770"');
    expect(drill).toContain('== "$restore_operator_uid:$restore_container_gid:440:1"');
    expect(drill).toContain("$restore_prefix.receiver-receipt.json.sig");
  });

  it("serializes the legacy rehearsal and pins current plus retained images before cleanup", () => {
    const legacy = source("deploy/rollback/run-legacy-restore-rehearsal.sh");
    const lock = legacy.indexOf('flock --exclusive --wait "$RESTORE_DRILL_LOCK_WAIT_SECONDS" 8');
    const immutableOverride = legacy.indexOf('immutable_override="$(mktemp');
    const cleanup = legacy.indexOf("\nremove_rehearsal_services\n");
    expect(legacy).toContain("/var/lib/business-finlynq/restore-drill.lock");
    expect(lock).toBeGreaterThan(-1);
    expect(immutableOverride).toBeGreaterThan(lock);
    expect(cleanup).toBeGreaterThan(immutableOverride);
    expect(legacy).toContain("pinned to its captured image ID");
    expect(legacy).toContain("build: !reset null");
    expect(legacy).toContain("DOCKER_HOST DOCKER_CONTEXT COMPOSE_FILE");
    expect(legacy).toContain('archive --format=tar "$BUSINESS_FINLYNQ_IMAGE_REVISION"');
    expect(legacy).toContain('--project-directory "$restore_source_snapshot"');
    expect(legacy).toContain("sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5");
    expect(legacy.match(/--no-build --pull never/g)?.length).toBeGreaterThanOrEqual(11);
    for (const service of [
      "restore_verify", "restore_migrate", "restore_runtime_grants",
      "restore_auth_worker_grants", "restore_backup_grants", "restore_accounting_verify",
      "restore_demo_bootstrap", "restore_key_verify", "restore_app",
      "restore_runtime_verify", "restore_evidence", "rollback_rehearsal_app",
      "rollback_rehearsal_verify",
    ]) {
      expect(legacy).toContain(`[${service}]`);
    }
  });

  it("requires a receiver-attested Ed25519 receipt for production recovery evidence", () => {
    const ingester = source("deploy/backup-receiver/ingest-backups.sh");
    const recorder = source("deploy/backup/record-restore-evidence.sh");
    const fixture = source("deploy/backup/test-restore-evidence-recorder.sh");

    expect(ingester).toContain("schemaVersion: 2");
    expect(ingester).toContain('signatureAlgorithm: "ed25519"');
    expect(ingester).toContain("openssl pkeyutl -sign -rawin");
    expect(recorder).toContain("BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256");
    expect(recorder).toContain("openssl pkeyutl -verify -rawin -pubin");
    expect(recorder).toContain("offSiteReceiptSignature");
    expect(fixture).toContain("accepted an unsigned receiver receipt for production");
    expect(fixture).toContain("accepted a receipt signed by an unpinned key");
  });

  it("requires actual identity, party, and address decryption for production evidence", () => {
    const verifier = source("scripts/operations/verify-restored-secrets.ts");
    const recorder = source("deploy/backup/record-restore-evidence.sh");
    expect(verifier).not.toContain("email_ciphertext LIKE 'idv1:%'");
    expect(verifier).toContain("verifyRestoredIdentityCiphertexts");
    expect(verifier).toContain("verifyRestoredMasterDataCiphertexts");
    expect(verifier).toContain("RESTORE_ALLOW_EMPTY_SECRET_FIXTURES");
    expect(verifier).toContain('"verified-diagnostic"');
    for (const check of [
      "encryptedIdentityDecryption",
      "encryptedPartyDecryption",
      "encryptedAddressDecryption",
      "diagnosticEscapeUsed",
    ]) {
      expect(recorder).toContain(check);
    }
    expect(recorder).toContain(".counts.encryptedIdentities");
    expect(recorder).toContain(".counts.encryptedPartyNames");
    expect(recorder).toContain(".counts.encryptedPartyAddresses");
  });
});
