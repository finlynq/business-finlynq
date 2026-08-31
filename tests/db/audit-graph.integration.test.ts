import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;
const runDatabaseTests = databaseUrl && appDatabaseUrl ? describe : describe.skip;

type AuditRow = Readonly<{
  action: string;
  previous_event_hash: string | null;
  event_hash: string;
  occurred_at: Date;
}>;

runDatabaseTests("immutable audit graph leaf", () => {
  const ownerPool = new Pool({ connectionString: databaseUrl });
  const appPool = new Pool({ connectionString: appDatabaseUrl });
  const earlyTransactionOrganization = randomUUID();
  const historicalTimestampOrganization = randomUUID();

  beforeAll(async () => {
    await ownerPool.query(
      `INSERT INTO organizations(id,slug,display_name)
       VALUES($1,$3,'Early transaction audit'),($2,$4,'Historical timestamp audit')`,
      [
        earlyTransactionOrganization,
        historicalTimestampOrganization,
        `audit-early-${earlyTransactionOrganization}`,
        `audit-history-${historicalTimestampOrganization}`,
      ],
    );
  });

  afterAll(async () => {
    await Promise.all([ownerPool.end(), appPool.end()]);
  });

  async function setAuditContext(
    client: PoolClient,
    organizationId: string,
    requestId: string,
  ): Promise<void> {
    await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
    await client.query("SELECT set_config('app.actor_id',$1,true)", [randomUUID()]);
    await client.query("SELECT set_config('app.request_id',$1,true)", [requestId]);
    await client.query("SELECT set_config('app.auth_method','integration-test',true)");
    await client.query("SELECT set_config('app.source_surface','WORKER',true)");
    await client.query(
      "SELECT set_config('app.reason','Verify immutable audit graph ordering',true)",
    );
  }

  async function append(
    client: PoolClient,
    organizationId: string,
    action: string,
  ): Promise<void> {
    await client.query(
      "SELECT app.append_tenant_business_audit($1,$2,'integration_test',$3,$4::jsonb,NULL)",
      [organizationId, action, randomUUID(), JSON.stringify({ action })],
    );
  }

  it("appends an early-started transaction after the later graph leaf with increasing time", async () => {
    const early = await ownerPool.connect();
    const later = await ownerPool.connect();
    try {
      await early.query("BEGIN");
      const earlyStartedAt = await early.query<{ started_at: Date }>(
        "SELECT transaction_timestamp() AS started_at",
      );
      await setAuditContext(early, earlyTransactionOrganization, randomUUID());

      await ownerPool.query("SELECT pg_sleep(0.02)");
      await later.query("BEGIN");
      const laterStartedAt = await later.query<{ started_at: Date }>(
        "SELECT transaction_timestamp() AS started_at",
      );
      await setAuditContext(later, earlyTransactionOrganization, randomUUID());
      await append(later, earlyTransactionOrganization, "integration.audit-later-start");
      await later.query("COMMIT");

      expect(earlyStartedAt.rows[0]!.started_at.getTime()).toBeLessThan(
        laterStartedAt.rows[0]!.started_at.getTime(),
      );
      await append(early, earlyTransactionOrganization, "integration.audit-early-start");
      await early.query("COMMIT");

      const events = await ownerPool.query<AuditRow>(
        `SELECT action,previous_event_hash,event_hash,occurred_at
         FROM audit_events
         WHERE organization_id=$1
         ORDER BY occurred_at,id`,
        [earlyTransactionOrganization],
      );
      expect(events.rows.map((event) => event.action)).toEqual([
        "integration.audit-later-start",
        "integration.audit-early-start",
      ]);
      expect(events.rows[1]!.previous_event_hash).toBe(events.rows[0]!.event_hash);
      const strictOrder = await ownerPool.query<{ ordered: boolean }>(
        `SELECT child.occurred_at > parent.occurred_at AS ordered
         FROM audit_events child
         JOIN audit_events parent
           ON parent.organization_id=child.organization_id
          AND parent.event_hash=child.previous_event_hash
         WHERE child.organization_id=$1
           AND child.action='integration.audit-early-start'`,
        [earlyTransactionOrganization],
      );
      expect(strictOrder.rows[0]?.ordered).toBe(true);
      expect(events.rows[1]!.occurred_at.getTime()).toBeGreaterThan(
        earlyStartedAt.rows[0]!.started_at.getTime(),
      );
    } finally {
      try { await early.query("ROLLBACK"); } catch { /* transaction already closed */ }
      try { await later.query("ROLLBACK"); } catch { /* transaction already closed */ }
      early.release();
      later.release();
    }
  });

  it("uses the graph leaf even when a historical parent has the maximum timestamp", async () => {
    const rootHash = "1".repeat(64);
    const leafHash = "2".repeat(64);
    const fixture = await ownerPool.connect();
    try {
      await fixture.query("BEGIN");
      await fixture.query("SET LOCAL session_replication_role = replica");
      await fixture.query(
        `INSERT INTO audit_events(
           organization_id,actor_type,actor_id,auth_method,source_surface,
           action,entity_type,entity_id,request_id,safe_metadata,
           previous_event_hash,event_hash,occurred_at
         ) VALUES
           ($1,'TEST','fixture','fixture','WORKER','integration.audit-root',
             'integration_test',$2,$3,'{}',NULL,$4,'2040-01-01T00:00:00Z'),
           ($1,'TEST','fixture','fixture','WORKER','integration.audit-leaf',
             'integration_test',$5,$6,'{}',$4,$7,'2030-01-01T00:00:00Z')`,
        [
          historicalTimestampOrganization,
          randomUUID(),
          randomUUID(),
          rootHash,
          randomUUID(),
          randomUUID(),
          leafHash,
        ],
      );
      await fixture.query("COMMIT");
    } catch (error) {
      await fixture.query("ROLLBACK");
      throw error;
    } finally {
      fixture.release();
    }

    const writer = await ownerPool.connect();
    try {
      await writer.query("BEGIN");
      await setAuditContext(writer, historicalTimestampOrganization, randomUUID());
      await append(writer, historicalTimestampOrganization, "integration.audit-after-skew");
      await writer.query("COMMIT");
    } finally {
      try { await writer.query("ROLLBACK"); } catch { /* transaction already closed */ }
      writer.release();
    }

    const appended = await ownerPool.query<AuditRow & { strictly_after_max: boolean }>(
      `SELECT action,previous_event_hash,event_hash,occurred_at,
         occurred_at > '2040-01-01T00:00:00Z'::timestamptz AS strictly_after_max
       FROM audit_events
       WHERE organization_id=$1 AND action='integration.audit-after-skew'`,
      [historicalTimestampOrganization],
    );
    expect(appended.rows[0]?.previous_event_hash).toBe(leafHash);
    expect(appended.rows[0]?.strictly_after_max).toBe(true);

    await expect(ownerPool.query(
      `INSERT INTO audit_events(
         organization_id,actor_type,actor_id,auth_method,source_surface,
         action,entity_type,entity_id,request_id,safe_metadata,
         previous_event_hash,event_hash
       ) VALUES($1,'TEST','fixture','fixture','WORKER','integration.audit-branch',
         'integration_test',$2,$3,'{}',$4,$5)`,
      [
        historicalTimestampOrganization,
        randomUUID(),
        randomUUID(),
        rootHash,
        "3".repeat(64),
      ],
    )).rejects.toMatchObject({ code: "23514" });

    const appClient = await appPool.connect();
    try {
      await appClient.query("BEGIN");
      await appClient.query(
        "SELECT set_config('app.organization_id',$1,true)",
        [historicalTimestampOrganization],
      );
      await expect(appClient.query(
        "SELECT * FROM app.locked_audit_graph_leaf($1)",
        [historicalTimestampOrganization],
      )).rejects.toMatchObject({ code: "42501" });
      await appClient.query("ROLLBACK");
    } finally {
      try { await appClient.query("ROLLBACK"); } catch { /* transaction already closed */ }
      appClient.release();
    }
  });
});
