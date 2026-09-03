import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const runDatabaseTests = ownerUrl && appUrl ? describe : describe.skip;

const ids = {
  organization: randomUUID(),
  actor: randomUUID(),
  unauthorizedActor: randomUUID(),
  membership: randomUUID(),
  unauthorizedMembership: randomUUID(),
  session: randomUUID(),
  unauthorizedSession: randomUUID(),
  role: randomUUID(),
  entity: randomUUID(),
  conflictingEntity: randomUUID(),
  ledger: randomUUID(),
  conflictingLedger: randomUUID(),
  january: randomUUID(),
  overlap: randomUUID(),
};

type PeriodCreationResult = Readonly<{
  accepted: boolean;
  idempotentReplay: boolean;
  summary: Readonly<{ created: number; existing: number; rejected: number }>;
  periods: readonly Readonly<{
    periodId: string | null;
    periodNumber: number;
    label: string;
    outcome: "CREATED" | "ALREADY_EXISTING" | "REJECTED";
    rejectionCode: string | null;
  }>[];
  conflicts: readonly Readonly<{
    periodId: string;
    rejectionCode: string;
  }>[];
}>;

runDatabaseTests("fiscal-period creation PostgreSQL boundary", () => {
  const owner = new Pool({ connectionString: ownerUrl });
  const app = new Pool({ connectionString: appUrl });

  async function asSession<T>(input: Readonly<{
    actorId: string;
    sessionId: string;
    requestId: string;
    reason: string;
  }>, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [ids.organization]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [input.actorId]);
      await client.query("SELECT set_config('app.session_id', $1, true)", [input.sessionId]);
      await client.query("SELECT set_config('app.session_mode', 'real', true)");
      await client.query("SELECT set_config('app.auth_method', 'password+mfa', true)");
      await client.query("SELECT set_config('app.request_id', $1, true)", [input.requestId]);
      await client.query("SELECT set_config('app.reason', $1, true)", [input.reason]);
      await client.query("SELECT set_config('app.source_surface', 'MCP', true)");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function createPeriods(
    client: PoolClient,
    ledgerId: string,
    fiscalYear: number,
    commandHash: string,
  ): Promise<PeriodCreationResult> {
    const result = await client.query<{ result: PeriodCreationResult }>(
      `SELECT app.accounting_create_fiscal_periods(
         $1::uuid,$2::integer,'MONTHLY'::text,'OPEN'::period_state,$3::text
       ) AS result`,
      [ledgerId, fiscalYear, commandHash],
    );
    const created = result.rows[0]?.result;
    if (!created) throw new Error("Fiscal-period function returned no result");
    return created;
  }

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO organizations(
         id, slug, display_name, active, is_demo, organization_mode, writes_enabled_at
       ) VALUES ($1,$2,'Period creation integration',true,false,'REAL',now())`,
      [ids.organization, `period-create-${ids.organization.slice(0, 12)}`],
    );
    await owner.query(
      `INSERT INTO users(
         id, email_lookup_hash, email_ciphertext, password_hash, active
       ) VALUES
         ($1,$2,'encrypted-period-owner','password-hash',true),
         ($3,$4,'encrypted-period-other','password-hash',true)`,
      [
        ids.actor,
        `period-owner-${ids.actor}`,
        ids.unauthorizedActor,
        `period-other-${ids.unauthorizedActor}`,
      ],
    );
    await owner.query(
      `INSERT INTO organization_memberships(id, organization_id, user_id, active)
       VALUES ($1,$2,$3,true), ($4,$2,$5,true)`,
      [
        ids.membership,
        ids.organization,
        ids.actor,
        ids.unauthorizedMembership,
        ids.unauthorizedActor,
      ],
    );
    await owner.query(
      `INSERT INTO auth_sessions(
         id, token_hash, user_id, organization_id, membership_id,
         auth_method, session_mode, user_agent_hash, idle_timeout_seconds,
         idle_expires_at, expires_at, mfa_verified_at, step_up_expires_at
       ) VALUES
         ($1,$2,$3,$4,$5,'PASSWORD','REAL',repeat('a',64),7200,
           now() + interval '2 hours', now() + interval '24 hours',
           now(), now() + interval '2 hours'),
         ($6,$7,$8,$4,$9,'PASSWORD','REAL',repeat('b',64),7200,
           now() + interval '2 hours', now() + interval '24 hours',
           now(), now() + interval '2 hours')`,
      [
        ids.session,
        `period-session-${ids.session}`,
        ids.actor,
        ids.organization,
        ids.membership,
        ids.unauthorizedSession,
        `period-session-${ids.unauthorizedSession}`,
        ids.unauthorizedActor,
        ids.unauthorizedMembership,
      ],
    );
    await owner.query(
      `INSERT INTO roles(id, organization_id, key, display_name, system_template)
       VALUES ($1,$2,'PERIOD_CREATOR_TEST','Period creator test',false)`,
      [ids.role, ids.organization],
    );
    await owner.query(
      `INSERT INTO role_permissions(organization_id, role_id, permission_key)
       VALUES ($1,$2,'ledger.period.create')`,
      [ids.organization, ids.role],
    );
    await owner.query(
      `INSERT INTO membership_roles(organization_id, membership_id, role_id, assigned_by)
       VALUES ($1,$2,$3,$4)`,
      [ids.organization, ids.membership, ids.role, ids.actor],
    );
    await owner.query(
      `INSERT INTO legal_entities(
         id, organization_id, code, display_name, country_code, region_code, active
       ) VALUES
         ($1,$2,'PERIODS','Period test entity','US','WA',true),
         ($3,$2,'CONFLICT','Conflict test entity','US','WA',true)`,
      [ids.entity, ids.organization, ids.conflictingEntity],
    );
    await owner.query(
      `INSERT INTO ledgers(
         id, organization_id, legal_entity_id, code, display_name, kind,
         accounting_profile, functional_currency, active
       ) VALUES
         ($1,$2,$3,'PERIOD-PRIMARY','Period primary','PRIMARY','US_GAAP_NONPUBLIC','USD',true),
         ($4,$2,$5,'PERIOD-CONFLICT','Period conflict','PRIMARY','US_GAAP_NONPUBLIC','USD',true)`,
      [ids.ledger, ids.organization, ids.entity, ids.conflictingLedger, ids.conflictingEntity],
    );
    await owner.query(
      `INSERT INTO fiscal_periods(
         id, organization_id, ledger_id, fiscal_year, period_number,
         label, starts_on, ends_on, state
       ) VALUES
         ($1,$2,$3,2026,1,'Preserved January','2026-01-01','2026-01-31','OPEN'),
         ($4,$2,$5,2025,13,'Overlapping legacy period','2027-01-01','2027-01-31','OPEN')`,
      [
        ids.january,
        ids.organization,
        ids.ledger,
        ids.overlap,
        ids.conflictingLedger,
      ],
    );
  });

  afterAll(async () => {
    // Like the organization-administration integration suite, retain the audited
    // fixture until the disposable database is destroyed. Audit rows are append-only.
    await Promise.all([owner.end(), app.end()]);
  });

  it("creates missing months, preserves exact periods, and makes all twelve visible immediately", async () => {
    const result = await asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: "period-create:integration-success",
      reason: "Create the approved 2026 fiscal calendar",
    }, async (client) => {
      const created = await createPeriods(client, ids.ledger, 2026, "a".repeat(64));
      const visible = await client.query<{ id: string }>(
        `SELECT id FROM fiscal_periods
         WHERE organization_id = $1 AND ledger_id = $2 AND fiscal_year = 2026
         ORDER BY period_number`,
        [ids.organization, ids.ledger],
      );
      expect(visible.rows).toHaveLength(12);
      return created;
    });

    expect(result.accepted).toBe(true);
    expect(result.summary).toEqual({ created: 11, existing: 1, rejected: 0 });
    expect(result.periods).toHaveLength(12);
    expect(result.periods[0]).toMatchObject({
      periodId: ids.january,
      label: "Preserved January",
      outcome: "ALREADY_EXISTING",
    });
  });

  it("replays the exact result once and rejects reuse for a different command", async () => {
    const replay = await asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: "period-create:integration-success",
      reason: "Create the approved 2026 fiscal calendar",
    }, (client) => createPeriods(client, ids.ledger, 2026, "a".repeat(64)));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.summary).toEqual({ created: 11, existing: 1, rejected: 0 });

    await expect(asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: "period-create:integration-success",
      reason: "Attempt a different command with the same key",
    }, (client) => createPeriods(client, ids.ledger, 2026, "b".repeat(64))))
      .rejects.toThrow(/Idempotency key was already used/i);

    const auditCount = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE organization_id = $1
         AND request_id = 'period-create:integration-success'
         AND action = 'ledger.fiscal_periods.provisioned'`,
      [ids.organization],
    );
    expect(auditCount.rows[0]?.count).toBe("1");
  });

  it("rejects an overlapping calendar atomically with structured conflicts", async () => {
    const result = await asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: "period-create:integration-overlap",
      reason: "Attempt the conflicting 2027 fiscal calendar",
    }, (client) => createPeriods(client, ids.conflictingLedger, 2027, "c".repeat(64)));

    expect(result.accepted).toBe(false);
    expect(result.summary.created).toBe(0);
    expect(result.periods).toHaveLength(12);
    expect(result.periods[0]).toMatchObject({
      outcome: "REJECTED",
      rejectionCode: "OVERLAPPING_PERIOD",
    });
    expect(result.conflicts).toMatchObject([{
      periodId: ids.overlap,
      rejectionCode: "OVERLAPPING_PERIOD",
    }]);
    const inserted = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM fiscal_periods
       WHERE organization_id = $1 AND ledger_id = $2 AND fiscal_year = 2027`,
      [ids.organization, ids.conflictingLedger],
    );
    expect(inserted.rows[0]?.count).toBe("0");
  });

  it("requires the dedicated permission and exposes no direct INSERT path", async () => {
    await expect(asSession({
      actorId: ids.unauthorizedActor,
      sessionId: ids.unauthorizedSession,
      requestId: "period-create:integration-unauthorized",
      reason: "Attempt period creation without permission",
    }, (client) => createPeriods(client, ids.ledger, 2028, "d".repeat(64))))
      .rejects.toThrow(/permission is required/i);

    await expect(asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: "period-create:integration-direct-insert",
      reason: "Prove direct period insertion remains blocked",
    }, (client) => client.query(
      `INSERT INTO fiscal_periods(
         organization_id, ledger_id, fiscal_year, period_number,
         label, starts_on, ends_on, state
       ) VALUES ($1,$2,2030,1,'Forbidden','2030-01-01','2030-01-31','OPEN')`,
      [ids.organization, ids.ledger],
    ))).rejects.toThrow(/permission denied/i);
  });
});
