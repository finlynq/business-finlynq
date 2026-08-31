import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { assertWritableOrganization } from "@/modules/workspace/write-policy";
import { executeOrganizationWriteCommand } from "../../scripts/organization-writes-command";

const databaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;
const runDatabaseTests = databaseUrl && appDatabaseUrl ? describe : describe.skip;

type ActivationRow = Readonly<{
  organization_id: string;
  active: boolean;
  organization_mode: string;
  writes_enabled_at: Date | null;
  changed: boolean;
}>;

runDatabaseTests("organization write activation", () => {
  const ownerPool = new Pool({ connectionString: databaseUrl });
  const appPool = new Pool({ connectionString: appDatabaseUrl });
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const demoOrganization = randomUUID();
  const inactiveOrganization = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const sessionId = randomUUID();
  const sessionTokenHash = randomUUID().replaceAll("-", "").repeat(2);
  const sessionUserAgentHash = "a".repeat(64);

  beforeAll(async () => {
    await ownerPool.query(
      `INSERT INTO organizations(id, slug, display_name, active, is_demo, organization_mode)
       VALUES
         ($1, $5, 'Activation A', true, false, 'REAL'),
         ($2, $6, 'Activation B', true, false, 'REAL'),
         ($3, $7, 'Activation demo', true, true, 'SANDBOX'),
         ($4, $8, 'Activation inactive', false, false, 'REAL')`,
      [
        organizationA,
        organizationB,
        demoOrganization,
        inactiveOrganization,
        `activation-a-${organizationA}`,
        `activation-b-${organizationB}`,
        `activation-demo-${demoOrganization}`,
        `activation-inactive-${inactiveOrganization}`,
      ],
    );
    await ownerPool.query(
      `INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active,is_demo)
       VALUES($1,$2,'encrypted-activation-email','activation-password-hash',true,false)`,
      [userId, `activation-user-${userId}`],
    );
    await ownerPool.query(
      `INSERT INTO organization_memberships(id,organization_id,user_id,active)
       VALUES($1,$2,$3,true)`,
      [membershipId, organizationA, userId],
    );
    await ownerPool.query(
      `INSERT INTO auth_sessions(
         id,token_hash,user_id,organization_id,membership_id,auth_method,
         session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at
       ) VALUES($1,$2,$3,$4,$5,'PASSWORD','REAL',$6,7200,
         now()+interval '2 hours',now()+interval '24 hours')`,
      [sessionId, sessionTokenHash, userId, organizationA, membershipId, sessionUserAgentHash],
    );
  });

  afterAll(async () => {
    await Promise.all([ownerPool.end(), appPool.end()]);
  });

  async function transition(
    organizationId: string,
    enabled: boolean,
    requestId = randomUUID(),
  ): Promise<ActivationRow> {
    const result = await ownerPool.query<ActivationRow>(
      "SELECT * FROM app.operator_set_organization_writes($1,$2,$3,$4,$5)",
      [
        organizationId,
        enabled,
        "integration-release-operator",
        enabled
          ? "Approve the named integration organization for real writes"
          : "Emergency-disable the named integration organization writes",
        requestId,
      ],
    );
    return result.rows[0]!;
  }

  it("defaults every real organization to disabled and activates only the named organization", async () => {
    const unactivatedSession = await appPool.query<{ organization_writes_enabled: boolean }>(
      "SELECT organization_writes_enabled FROM app.auth_resolve_session_v3($1,$2)",
      [sessionTokenHash, sessionUserAgentHash],
    );
    expect(unactivatedSession.rows[0]?.organization_writes_enabled).toBe(false);

    const initial = await ownerPool.query<{
      id: string;
      writes_enabled_at: Date | null;
    }>(
      "SELECT id, writes_enabled_at FROM organizations WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[organizationA, organizationB]],
    );
    expect(initial.rows).toHaveLength(2);
    expect(initial.rows.every((row) => row.writes_enabled_at === null)).toBe(true);

    const enabled = await transition(organizationA, true);
    expect(enabled).toMatchObject({
      organization_id: organizationA,
      active: true,
      organization_mode: "REAL",
      changed: true,
    });
    expect(enabled.writes_enabled_at).toBeInstanceOf(Date);
    const activatedSession = await appPool.query<{ organization_writes_enabled: boolean }>(
      "SELECT organization_writes_enabled FROM app.auth_resolve_session_v3($1,$2)",
      [sessionTokenHash, sessionUserAgentHash],
    );
    expect(activatedSession.rows[0]?.organization_writes_enabled).toBe(true);

    const states = await ownerPool.query<{ id: string; enabled: boolean }>(
      `SELECT id, writes_enabled_at IS NOT NULL AS enabled
       FROM organizations WHERE id = ANY($1::uuid[])`,
      [[organizationA, organizationB]],
    );
    expect(Object.fromEntries(states.rows.map((row) => [row.id, row.enabled]))).toEqual({
      [organizationA]: true,
      [organizationB]: false,
    });

    const replay = await transition(organizationA, true);
    expect(replay).toMatchObject({
      organization_id: organizationA,
      changed: false,
    });
    expect(replay.writes_enabled_at?.toISOString()).toBe(enabled.writes_enabled_at?.toISOString());

    const evidence = await ownerPool.query<{ audits: number; outbox: number }>(
      `SELECT
         (SELECT count(*)::int FROM audit_events
           WHERE organization_id=$1 AND action='organization.writes-enabled') AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE organization_id=$1 AND topic='organization.writes-enabled') AS outbox`,
      [organizationA],
    );
    expect(evidence.rows[0]).toEqual({ audits: 1, outbox: 1 });
  });

  it("rejects demo and inactive activation and keeps the operator function outside the app ACL", async () => {
    await expect(transition(demoOrganization, true)).rejects.toMatchObject({ code: "22023" });
    await expect(transition(inactiveOrganization, true)).rejects.toMatchObject({ code: "55000" });

    for (const invalidArguments of [
      [null, true, "integration-release-operator", "A sufficiently detailed activation reason", randomUUID()],
      [organizationB, true, null, "A sufficiently detailed activation reason", randomUUID()],
      [organizationB, true, "integration-release-operator", null, randomUUID()],
      [organizationB, true, "integration-release-operator", "A sufficiently detailed activation reason", null],
      [organizationB, true, "owner@example.com", "A sufficiently detailed activation reason", randomUUID()],
      [organizationB, true, "integration-release-operator", "Contact owner@example.com before activation", randomUUID()],
      [organizationB, true, "integration-release-operator", "A sufficiently detailed activation reason", "not-a-request-uuid"],
    ]) {
      await expect(ownerPool.query(
        "SELECT * FROM app.operator_set_organization_writes($1,$2,$3,$4,$5)",
        invalidArguments,
      )).rejects.toMatchObject({ code: "22023" });
    }

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationA]);
      await expect(client.query(
        "SELECT * FROM app.operator_set_organization_writes($1,true,$2,$3,$4)",
        [
          organizationA,
          "untrusted-runtime",
          "The runtime role must never perform an activation transition",
          randomUUID(),
        ],
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("keeps the audit chain linear when an earlier transaction appends after a later one", async () => {
    const earlyOperator = await ownerPool.connect();
    try {
      await earlyOperator.query("BEGIN");
      await earlyOperator.query("SELECT now()");
      await ownerPool.query("SELECT pg_sleep(0.02)");

      const first = await transition(organizationB, true);
      expect(first.changed).toBe(true);

      const second = await earlyOperator.query<ActivationRow>(
        "SELECT * FROM app.operator_set_organization_writes($1,false,$2,$3,$4)",
        [
          organizationB,
          "integration-release-operator",
          "Disable after a later transaction committed its activation",
          randomUUID(),
        ],
      );
      expect(second.rows[0]?.changed).toBe(true);
      await earlyOperator.query("COMMIT");

      const third = await transition(organizationB, true);
      expect(third.changed).toBe(true);

      const chain = await ownerPool.query<{
        action: string;
        event_hash: string;
        previous_event_hash: string | null;
        occurred_at: Date;
      }>(
        `SELECT action,event_hash,previous_event_hash,occurred_at
         FROM audit_events
         WHERE organization_id=$1
         ORDER BY occurred_at,id`,
        [organizationB],
      );
      expect(chain.rows.map((event) => event.action)).toEqual([
        "organization.writes-enabled",
        "organization.writes-disabled",
        "organization.writes-enabled",
      ]);
      expect(chain.rows[0]?.previous_event_hash).toBeNull();
      expect(chain.rows[1]?.previous_event_hash).toBe(chain.rows[0]?.event_hash);
      expect(chain.rows[2]?.previous_event_hash).toBe(chain.rows[1]?.event_hash);
      expect(chain.rows[1]!.occurred_at.getTime()).toBeGreaterThanOrEqual(
        chain.rows[0]!.occurred_at.getTime(),
      );
      expect(chain.rows[2]!.occurred_at.getTime()).toBeGreaterThanOrEqual(
        chain.rows[1]!.occurred_at.getTime(),
      );
    } finally {
      try { await earlyOperator.query("ROLLBACK"); } catch { /* transaction already closed */ }
      earlyOperator.release();
    }
  });

  it("lets the operator wait for an in-flight writer and then extends that writer's audit leaf", async () => {
    const writer = await ownerPool.connect();
    const operator = await ownerPool.connect();
    const writerRequestId = randomUUID();
    const operatorRequestId = randomUUID();
    let operatorCommand: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT set_config('app.organization_id',$1,true)", [organizationB]);
      await writer.query("SELECT set_config('app.actor_id',$1,true)", [userId]);
      await writer.query("SELECT set_config('app.request_id',$1,true)", [writerRequestId]);
      await writer.query("SELECT set_config('app.auth_method','password',true)");
      await writer.query("SELECT set_config('app.source_surface','API',true)");
      await assertWritableOrganization(writer, {
        organizationId: organizationB,
        actorId: userId,
        sessionMode: "real",
        requestId: writerRequestId,
        authMethod: "password",
        sourceSurface: "API",
      });
      await writer.query(
        `SELECT app.append_tenant_business_audit(
           $1,'integration.writer-before-disable','integration_test',$2,$3::jsonb,NULL
         )`,
        [organizationB, randomUUID(), JSON.stringify({ source: "in-flight-writer" })],
      );

      const operatorPid = await operator.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      operatorCommand = executeOrganizationWriteCommand(operator, {
        action: "disable",
        organizationId: organizationB,
        operatorId: "integration-release-operator",
        reason: "Disable after the in-flight writer drains safely",
      }, {
        globalGateEnabled: true,
        requestId: operatorRequestId,
      });

      let observedWait = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const lockState = await ownerPool.query<{ waiting: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM pg_locks
             WHERE pid=$1 AND locktype='advisory' AND NOT granted
           ) AS waiting`,
          [operatorPid.rows[0]!.pid],
        );
        if (lockState.rows[0]?.waiting) {
          observedWait = true;
          break;
        }
        await ownerPool.query("SELECT pg_sleep(0.01)");
      }
      expect(observedWait).toBe(true);

      await writer.query("COMMIT");
      await expect(operatorCommand).resolves.toMatchObject({
        outcome: "disabled",
        organizationId: organizationB,
        requestId: operatorRequestId,
      });

      const linkedEvents = await ownerPool.query<{
        request_id: string;
        previous_event_hash: string | null;
        event_hash: string;
      }>(
        `SELECT request_id,previous_event_hash,event_hash
         FROM audit_events
         WHERE organization_id=$1 AND request_id=ANY($2::text[])`,
        [organizationB, [writerRequestId, operatorRequestId]],
      );
      const eventsByRequest = Object.fromEntries(
        linkedEvents.rows.map((event) => [event.request_id, event]),
      );
      expect(eventsByRequest[operatorRequestId]?.previous_event_hash).toBe(
        eventsByRequest[writerRequestId]?.event_hash,
      );
    } finally {
      try { await writer.query("ROLLBACK"); } catch { /* transaction already closed */ }
      if (operatorCommand) {
        try { await operatorCommand; } catch { /* assertion reports the primary failure */ }
      }
      try { await operator.query("ROLLBACK"); } catch { /* transaction already closed */ }
      writer.release();
      operator.release();
    }
  });

  it("fences disable against in-flight authorized writes and then preserves read history", async () => {
    const writer = await ownerPool.connect();
    const operator = await ownerPool.connect();
    try {
      // UUID input is case-insensitive, but the advisory-lock key must use
      // PostgreSQL's canonical UUID text on both the writer and operator path.
      const uppercaseOrganizationA = organizationA.toUpperCase();
      await writer.query("BEGIN");
      await writer.query("SELECT set_config('app.organization_id', $1, true)", [uppercaseOrganizationA]);
      await assertWritableOrganization(writer, {
        organizationId: uppercaseOrganizationA,
        actorId: "22222222-2222-4222-8222-222222222222",
        sessionMode: "real",
        requestId: randomUUID(),
        authMethod: "password+mfa",
        sourceSurface: "API",
      });

      await operator.query("BEGIN");
      await operator.query("SET LOCAL lock_timeout = '150ms'");
      await expect(operator.query(
        "SELECT * FROM app.operator_set_organization_writes($1,false,$2,$3,$4)",
        [
          organizationA,
          "integration-release-operator",
          "Emergency-disable waits for the already authorized writer",
          randomUUID(),
        ],
      )).rejects.toMatchObject({ code: "55P03" });
      await operator.query("ROLLBACK");
      await writer.query("COMMIT");

      const disabled = await transition(organizationA, false);
      expect(disabled).toMatchObject({
        organization_id: organizationA,
        writes_enabled_at: null,
        changed: true,
      });

      const reader = await appPool.connect();
      try {
        await reader.query("BEGIN");
        await reader.query("SELECT set_config('app.organization_id', $1, true)", [organizationA]);
        await expect(assertWritableOrganization(reader, {
          organizationId: organizationA,
          actorId: "22222222-2222-4222-8222-222222222222",
          sessionMode: "real",
          requestId: randomUUID(),
          authMethod: "password+mfa",
          sourceSurface: "API",
        })).rejects.toThrow("Business writes are not enabled for this organization");
        const readableStatus = await reader.query<{
          id: string;
          active: boolean;
          writes_enabled_at: Date | null;
        }>(
          "SELECT id, active, writes_enabled_at FROM organizations WHERE id=$1",
          [organizationA],
        );
        expect(readableStatus.rows[0]).toEqual({
          id: organizationA,
          active: true,
          writes_enabled_at: null,
        });
        await reader.query("COMMIT");
      } finally {
        try { await reader.query("ROLLBACK"); } catch { /* transaction already closed */ }
        reader.release();
      }

      const history = await ownerPool.query<{ audits: number; outbox: number }>(
        `SELECT
           (SELECT count(*)::int FROM audit_events WHERE organization_id=$1) AS audits,
           (SELECT count(*)::int FROM outbox_events WHERE organization_id=$1) AS outbox`,
        [organizationA],
      );
      expect(history.rows[0]).toEqual({ audits: 2, outbox: 2 });
    } finally {
      try { await writer.query("ROLLBACK"); } catch { /* transaction already closed */ }
      try { await operator.query("ROLLBACK"); } catch { /* transaction already closed */ }
      writer.release();
      operator.release();
    }
  });
});
