import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const runDatabaseTests = ownerUrl && appUrl ? describe : describe.skip;

const ids = {
  organization: randomUUID(),
  otherOrganization: randomUUID(),
  actor: randomUUID(),
  unauthorizedActor: randomUUID(),
  membership: randomUUID(),
  unauthorizedMembership: randomUUID(),
  session: randomUUID(),
  unauthorizedSession: randomUUID(),
  role: randomUUID(),
};

runDatabaseTests("FX provider-policy PostgreSQL boundary", () => {
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

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO organizations(
         id, slug, display_name, active, is_demo, organization_mode, writes_enabled_at
       ) VALUES
         ($1,$2,'FX policy integration',true,false,'REAL',now()),
         ($3,$4,'Other FX policy tenant',true,false,'REAL',now())`,
      [
        ids.organization,
        `fx-policy-${ids.organization.slice(0, 12)}`,
        ids.otherOrganization,
        `fx-policy-other-${ids.otherOrganization.slice(0, 12)}`,
      ],
    );
    await owner.query(
      `INSERT INTO users(
         id, email_lookup_hash, email_ciphertext, password_hash, active
       ) VALUES
         ($1,$2,'encrypted-fx-policy-owner','password-hash',true),
         ($3,$4,'encrypted-fx-policy-other','password-hash',true)`,
      [
        ids.actor,
        `fx-policy-owner-${ids.actor}`,
        ids.unauthorizedActor,
        `fx-policy-other-${ids.unauthorizedActor}`,
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
        `fx-policy-session-${ids.session}`,
        ids.actor,
        ids.organization,
        ids.membership,
        ids.unauthorizedSession,
        `fx-policy-session-${ids.unauthorizedSession}`,
        ids.unauthorizedActor,
        ids.unauthorizedMembership,
      ],
    );
    await owner.query(
      `INSERT INTO roles(id, organization_id, key, display_name, system_template)
       VALUES ($1,$2,'FX_POLICY_ADMIN_TEST','FX policy admin test',false)`,
      [ids.role, ids.organization],
    );
    await owner.query(
      `INSERT INTO role_permissions(organization_id, role_id, permission_key)
       VALUES ($1,$2,'organization.settings.manage')`,
      [ids.organization, ids.role],
    );
    await owner.query(
      `INSERT INTO membership_roles(organization_id, membership_id, role_id, assigned_by)
       VALUES ($1,$2,$3,$4)`,
      [ids.organization, ids.membership, ids.role, ids.actor],
    );
    await owner.query(
      `INSERT INTO organization_fx_provider_policy_versions(
         organization_id, version, provider_mode, max_lookback_days,
         licensed_and_authorized_use_acknowledged, reason, created_by
       ) VALUES ($1,1,'STORED_ONLY',7,false,'Retain stored rates for the other tenant',$2)`,
      [ids.otherOrganization, ids.actor],
    );
  });

  afterAll(async () => {
    await Promise.all([owner.end(), app.end()]);
  });

  it("defaults to stored-only, isolates another tenant, and appends one audited version", async () => {
    const created = await asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: `fx-policy-create-${ids.organization}`,
      reason: "Approve licensed Yahoo Finance use",
    }, async (client) => {
      const before = await client.query(
        "SELECT organization_id FROM organization_fx_provider_policy_versions",
      );
      expect(before.rows).toEqual([]);
      const result = await client.query<{
        policy_version: number;
        selected_provider_mode: string;
        selected_max_lookback_days: number;
        selected_licensed_acknowledgement: boolean;
      }>(
        "SELECT * FROM app.accounting_set_fx_provider_policy(0,'YAHOO_FINANCE_EXPERIMENTAL',5,true)",
      );
      return result.rows[0];
    });
    expect(created).toMatchObject({
      policy_version: 1,
      selected_provider_mode: "YAHOO_FINANCE_EXPERIMENTAL",
      selected_max_lookback_days: 5,
      selected_licensed_acknowledgement: true,
    });

    await asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: `fx-policy-retry-${ids.organization}`,
      reason: "Retry licensed Yahoo Finance use",
    }, (client) => client.query(
      "SELECT * FROM app.accounting_set_fx_provider_policy(0,'YAHOO_FINANCE_EXPERIMENTAL',5,true)",
    ));

    const evidence = await owner.query<{ policies: string; audits: string }>(
      `SELECT
         (SELECT count(*)::text FROM organization_fx_provider_policy_versions
           WHERE organization_id = $1) AS policies,
         (SELECT count(*)::text FROM audit_events
           WHERE organization_id = $1
             AND action = 'accounting.fx_provider_policy.changed') AS audits`,
      [ids.organization],
    );
    expect(evidence.rows[0]).toEqual({ policies: "1", audits: "1" });
  });

  it("accepts official central-bank modes without a Yahoo acknowledgement", async () => {
    const bankOfCanada = await asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: `fx-policy-bank-of-canada-${ids.organization}`,
      reason: "Select Bank of Canada reference rates",
    }, async (client) => {
      const result = await client.query<{
        policy_version: number;
        selected_provider_mode: string;
        selected_licensed_acknowledgement: boolean;
      }>(
        "SELECT * FROM app.accounting_set_fx_provider_policy(1,'BANK_OF_CANADA',5,false)",
      );
      return result.rows[0];
    });
    expect(bankOfCanada).toMatchObject({
      policy_version: 2,
      selected_provider_mode: "BANK_OF_CANADA",
      selected_licensed_acknowledgement: false,
    });

    await expect(asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: `fx-policy-ecb-invalid-ack-${ids.organization}`,
      reason: "Reject Yahoo acknowledgement on ECB",
    }, (client) => client.query(
      "SELECT * FROM app.accounting_set_fx_provider_policy(2,'EUROPEAN_CENTRAL_BANK',5,true)",
    ))).rejects.toMatchObject({ code: "22023" });

    const ecb = await asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: `fx-policy-ecb-${ids.organization}`,
      reason: "Select ECB reference rates",
    }, async (client) => {
      const result = await client.query<{
        policy_version: number;
        selected_provider_mode: string;
        selected_licensed_acknowledgement: boolean;
      }>(
        "SELECT * FROM app.accounting_set_fx_provider_policy(2,'EUROPEAN_CENTRAL_BANK',4,false)",
      );
      return result.rows[0];
    });
    expect(ecb).toMatchObject({
      policy_version: 3,
      selected_provider_mode: "EUROPEAN_CENTRAL_BANK",
      selected_licensed_acknowledgement: false,
    });
  });

  it("requires settings permission and licensed-use acknowledgement", async () => {
    await expect(asSession({
      actorId: ids.unauthorizedActor,
      sessionId: ids.unauthorizedSession,
      requestId: `fx-policy-unauthorized-${ids.organization}`,
      reason: "Attempt policy change without permission",
    }, (client) => client.query(
      "SELECT * FROM app.accounting_set_fx_provider_policy(1,'STORED_ONLY',7,false)",
    ))).rejects.toMatchObject({ code: "42501" });

    await expect(asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: `fx-policy-no-ack-${ids.organization}`,
      reason: "Attempt unlicensed Yahoo Finance use",
    }, (client) => client.query(
      "SELECT * FROM app.accounting_set_fx_provider_policy(1,'YAHOO_FINANCE_EXPERIMENTAL',5,false)",
    ))).rejects.toMatchObject({ code: "22023" });
  });

  it("blocks direct mutation and stale versions through the application role", async () => {
    await expect(asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: `fx-policy-direct-${ids.organization}`,
      reason: "Prove direct policy mutation is blocked",
    }, (client) => client.query(
      `INSERT INTO organization_fx_provider_policy_versions(
         organization_id, version, provider_mode, max_lookback_days,
         licensed_and_authorized_use_acknowledged, reason, created_by
       ) VALUES ($1,2,'STORED_ONLY',7,false,'Attempt a direct policy insert',$2)`,
      [ids.organization, ids.actor],
    ))).rejects.toThrow(/permission denied/i);

    await expect(asSession({
      actorId: ids.actor,
      sessionId: ids.session,
      requestId: `fx-policy-stale-${ids.organization}`,
      reason: "Attempt a stale provider policy change",
    }, (client) => client.query(
      "SELECT * FROM app.accounting_set_fx_provider_policy(0,'STORED_ONLY',7,false)",
    ))).rejects.toMatchObject({ code: "40001" });
  });

  it("keeps policy history append-only even for the database owner", async () => {
    await expect(owner.query(
      `UPDATE organization_fx_provider_policy_versions
       SET max_lookback_days = 6
       WHERE organization_id = $1`,
      [ids.otherOrganization],
    )).rejects.toThrow(/append-only/i);
  });
});
