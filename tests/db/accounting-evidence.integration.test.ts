import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;
const evidenceQuery = readFileSync(
  new URL("../../scripts/operations/accounting-evidence-query.sql", import.meta.url),
  "utf8",
);

type EvidenceRow = Readonly<{
  invalid_hash_contract_count: string;
  hash_mismatch_count: string;
  invalid_outbox_contract_count: string;
  audit_without_required_outbox_count: string;
  outbox_without_correct_audit_count: string;
  paired_count_mismatch_count: string;
}>;

runDatabaseTests("accounting evidence hash recomputation", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  it("detects changed canonical metadata even when graph topology remains linear", async () => {
    const client = await pool.connect();
    const organizationId = randomUUID();
    const entityId = randomUUID();
    const requestId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO organizations(id,slug,display_name) VALUES($1,$2,'Hash evidence fixture')",
        [organizationId, `hash-evidence-${organizationId}`],
      );
      await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
      await client.query("SELECT set_config('app.actor_id','hash-evidence-test',true)");
      await client.query("SELECT set_config('app.request_id',$1,true)", [requestId]);
      await client.query("SELECT set_config('app.auth_method','integration-test',true)");
      await client.query("SELECT set_config('app.source_surface','WORKER',true)");
      await client.query(
        "SELECT app.append_tenant_business_audit($1,'integration.hash-evidence','integration_test',$2,$3::jsonb,NULL)",
        [organizationId, entityId, JSON.stringify({ sequence: 1 })],
      );
      const inserted = await client.query<{ hash_material_version: string }>(
        "SELECT hash_material_version FROM audit_events WHERE organization_id=$1",
        [organizationId],
      );
      expect(inserted.rows[0]?.hash_material_version).toBe("tenant-business-v1");

      const clean = await client.query<EvidenceRow>(evidenceQuery);
      expect(Number(clean.rows[0]?.invalid_hash_contract_count)).toBe(0);
      expect(Number(clean.rows[0]?.hash_mismatch_count)).toBe(0);

      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE audit_events SET safe_metadata=$2::jsonb WHERE organization_id=$1",
        [organizationId, JSON.stringify({ sequence: 2 })],
      );
      await client.query("SET LOCAL session_replication_role = origin");

      const changed = await client.query<EvidenceRow>(evidenceQuery);
      expect(Number(changed.rows[0]?.invalid_hash_contract_count)).toBe(0);
      expect(Number(changed.rows[0]?.hash_mismatch_count)).toBe(1);
    } finally {
      await client.query("SELECT pg_advisory_unlock_all()");
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("detects required audit/outbox corruption in both directions", async () => {
    const client = await pool.connect();
    const organizationId = randomUUID();
    const auditOnlyEntityId = randomUUID();
    const outboxOnlyEntityId = randomUUID();
    const auditRequestId = randomUUID();
    const outboxRequestId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO organizations(id,slug,display_name) VALUES($1,$2,'Pair evidence fixture')",
        [organizationId, `pair-evidence-${organizationId}`],
      );
      await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
      await client.query("SELECT set_config('app.actor_id','pair-evidence-test',true)");
      await client.query("SELECT set_config('app.request_id',$1,true)", [auditRequestId]);
      await client.query("SELECT set_config('app.auth_method','integration-test',true)");
      await client.query("SELECT set_config('app.source_surface','WORKER',true)");
      await client.query(
        "SELECT app.append_tenant_business_audit($1,'journal.draft-created','journal_entry',$2,'{}'::jsonb,NULL)",
        [organizationId, auditOnlyEntityId],
      );

      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO outbox_events(
           organization_id, topic, aggregate_type, aggregate_id, request_id, payload
         ) VALUES($1,'ledger.journal-draft-created','journal_entry',$2,$3,'{}'::jsonb)`,
        [organizationId, outboxOnlyEntityId, outboxRequestId],
      );
      await client.query("SET LOCAL session_replication_role = origin");

      const corrupted = await client.query<EvidenceRow>(evidenceQuery);
      expect(Number(corrupted.rows[0]?.invalid_outbox_contract_count)).toBe(0);
      expect(Number(corrupted.rows[0]?.audit_without_required_outbox_count)).toBeGreaterThan(0);
      expect(Number(corrupted.rows[0]?.outbox_without_correct_audit_count)).toBeGreaterThan(0);
      expect(Number(corrupted.rows[0]?.paired_count_mismatch_count)).toBeGreaterThan(0);
    } finally {
      await client.query("SELECT pg_advisory_unlock_all()");
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("rejects undeclared and mismatched pairs while preserving explicit posting fallback", async () => {
    const client = await pool.connect();
    const organizationId = randomUUID();
    const pairedEntityId = randomUUID();
    const requestId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO organizations(id,slug,display_name) VALUES($1,$2,'Pair enforcement fixture')",
        [organizationId, `pair-enforcement-${organizationId}`],
      );
      await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
      await client.query("SELECT set_config('app.actor_id','pair-enforcement-test',true)");
      await client.query("SELECT set_config('app.request_id',$1,true)", [requestId]);
      await client.query("SELECT set_config('app.auth_method','integration-test',true)");
      await client.query("SELECT set_config('app.source_surface','WORKER',true)");

      await client.query(
        "SELECT app.append_tenant_business_audit($1,'accounting.currency.configuration_changed','organization_currency','CAD','{}'::jsonb,NULL)",
        [organizationId],
      );
      await client.query("SET CONSTRAINTS audit_events_required_outbox IMMEDIATE");
      await client.query("SET CONSTRAINTS audit_events_required_outbox DEFERRED");

      await client.query("SAVEPOINT unknown_contract");
      await expect(client.query(
        `INSERT INTO outbox_events(
           organization_id, topic, aggregate_type, aggregate_id, request_id, payload
         ) VALUES($1,'integration.unknown','integration',$2,$3,'{}'::jsonb)`,
        [organizationId, randomUUID(), requestId],
      )).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT unknown_contract");

      await client.query("SAVEPOINT wrong_aggregate_contract");
      await expect(client.query(
        `INSERT INTO outbox_events(
           organization_id, topic, aggregate_type, aggregate_id, request_id, payload
         ) VALUES($1,'ledger.journal-draft-created','fiscal_period',$2,$3,'{}'::jsonb)`,
        [organizationId, randomUUID(), requestId],
      )).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT wrong_aggregate_contract");

      await client.query("SAVEPOINT wrong_audit_action");
      await expect(client.query(
        `INSERT INTO outbox_events(
           organization_id, topic, aggregate_type, aggregate_id, request_id, payload
         ) VALUES($1,'ledger.journal-draft-created','journal_entry',$2,$3,'{}'::jsonb)`,
        [organizationId, pairedEntityId, requestId],
      )).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT wrong_audit_action");

      await client.query(
        "SELECT app.append_tenant_business_audit($1,'journal.draft-created','journal_entry',$2,'{}'::jsonb,NULL)",
        [organizationId, pairedEntityId],
      );
      await client.query(
        `INSERT INTO outbox_events(
           organization_id, topic, aggregate_type, aggregate_id, request_id, payload
         ) VALUES($1,'ledger.journal-draft-created','journal_entry',$2,$3,'{}'::jsonb)`,
        [organizationId, pairedEntityId, requestId],
      );
      await client.query("SET CONSTRAINTS audit_events_required_outbox IMMEDIATE");
      await client.query("SET CONSTRAINTS audit_events_required_outbox DEFERRED");

      const postingEntityId = randomUUID();
      const postingRequestId = `posting-idempotency-${randomUUID()}`;
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO audit_events(
           organization_id, actor_type, actor_id, auth_method, source_surface,
           action, entity_type, entity_id, request_id, safe_metadata,
           previous_event_hash, event_hash, hash_material_version
         ) VALUES($1,'SYSTEM','pair-enforcement-test','integration-test','WORKER',
           'journal.posted','journal_entry',$2,$3,'{}'::jsonb,NULL,$4,'journal-posted-v1')`,
        [organizationId, postingEntityId, postingRequestId, "a".repeat(64)],
      );
      await client.query("SET LOCAL session_replication_role = origin");
      await client.query("SELECT set_config('app.request_id','',true)");

      await client.query("SAVEPOINT wrong_posting_fallback");
      await expect(client.query(
        `INSERT INTO outbox_events(
           organization_id, topic, aggregate_type, aggregate_id, request_id, payload
         ) VALUES($1,'ledger.journal-posted','journal_entry',$2,$3,'{}'::jsonb)`,
        [organizationId, postingEntityId, `${postingRequestId}-wrong`],
      )).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT wrong_posting_fallback");
      await client.query(
        `INSERT INTO outbox_events(
           organization_id, topic, aggregate_type, aggregate_id, request_id, payload
         ) VALUES($1,'ledger.journal-posted','journal_entry',$2,$3,'{}'::jsonb)`,
        [organizationId, postingEntityId, postingRequestId],
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
