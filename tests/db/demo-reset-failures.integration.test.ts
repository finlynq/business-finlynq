import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { resetDemoSandboxes } from "@/modules/onboarding/demo-bootstrap";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;
const FAILURE_TRIGGER = "demo_reset_failure_integration_trigger";
const FAILURE_FUNCTION = "app.demo_reset_failure_integration_trigger";
const FAILURE_CONTROL = "app.demo_reset_failure_integration_control";

type SandboxTarget = Readonly<{
  slot: number;
  organization_id: string;
}>;

function hashFixture(): string {
  return randomUUID().replaceAll("-", "").repeat(2);
}

runDatabaseTests("demo sandbox reset failure containment", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  let target: SandboxTarget | null = null;

  async function setFailureInjection(mode: "" | "FAIL_QUARANTINE" | "SUPPRESS_READY"): Promise<void> {
    await pool.query(
      `UPDATE ${FAILURE_CONTROL}
       SET organization_id = $1, failure_mode = $2
       WHERE singleton`,
      [target?.organization_id ?? null, mode],
    );
  }

  async function selectReadyTarget(): Promise<SandboxTarget> {
    const selected = await pool.query<SandboxTarget>(
      `SELECT slot.slot, slot.organization_id
       FROM demo_sandbox_slots slot
       JOIN organizations organization ON organization.id = slot.organization_id
       WHERE slot.state = 'READY'
         AND organization.active
         AND organization.is_demo
         AND organization.organization_mode = 'SANDBOX'
       ORDER BY slot.slot DESC
       LIMIT 1`,
    );
    const sandbox = selected.rows[0];
    if (!sandbox) throw new Error("No READY demo sandbox exists for reset-failure integration coverage");
    target = sandbox;
    return sandbox;
  }

  async function setDemoAccountantActive(active: boolean): Promise<void> {
    if (!target) return;
    const result = await pool.query(
      `UPDATE roles
       SET active = $2
       WHERE organization_id = $1 AND key = 'demo_accountant'
       RETURNING id`,
      [target.organization_id, active],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Sandbox ${target.slot} has no canonical demo_accountant role`);
    }
  }

  async function restoreTarget(): Promise<void> {
    if (!target) return;
    await setFailureInjection("");
    await setDemoAccountantActive(true);
    await pool.query(
      `UPDATE demo_sandbox_slots
       SET state = 'RESETTING'
       WHERE slot = $1 AND organization_id = $2`,
      [target.slot, target.organization_id],
    );
    await resetDemoSandboxes(pool, { mode: "bootstrap" });
    const restored = await pool.query<{ state: string; baseline_version: number }>(
      `SELECT state, baseline_version
       FROM demo_sandbox_slots
       WHERE slot = $1 AND organization_id = $2`,
      [target.slot, target.organization_id],
    );
    expect(restored.rows[0]).toEqual({ state: "READY", baseline_version: 6 });
    target = null;
  }

  beforeAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${FAILURE_CONTROL}`);
    await pool.query(
      `CREATE TABLE ${FAILURE_CONTROL} (
         singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
         organization_id uuid,
         failure_mode text NOT NULL DEFAULT ''
           CHECK (failure_mode IN ('', 'FAIL_QUARANTINE', 'SUPPRESS_READY'))
       )`,
    );
    await pool.query(`INSERT INTO ${FAILURE_CONTROL} DEFAULT VALUES`);
    await pool.query(
      `CREATE OR REPLACE FUNCTION ${FAILURE_FUNCTION}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $function$
       DECLARE
         selected_mode text;
       BEGIN
         SELECT control.failure_mode INTO selected_mode
         FROM ${FAILURE_CONTROL} control
         WHERE control.singleton AND control.organization_id = NEW.organization_id;
         IF selected_mode = 'FAIL_QUARANTINE' AND NEW.state = 'QUARANTINED' THEN
           RAISE EXCEPTION 'forced quarantine failure';
         END IF;
         IF selected_mode = 'SUPPRESS_READY'
           AND OLD.state = 'RESETTING' AND NEW.state = 'READY' THEN
           RETURN NULL;
         END IF;
         RETURN NEW;
       END
       $function$`,
    );
    await pool.query(
      `DROP TRIGGER IF EXISTS ${FAILURE_TRIGGER} ON demo_sandbox_slots`,
    );
    await pool.query(
      `CREATE TRIGGER ${FAILURE_TRIGGER}
       BEFORE UPDATE ON demo_sandbox_slots
       FOR EACH ROW EXECUTE FUNCTION ${FAILURE_FUNCTION}()`,
    );
  });

  afterEach(async () => {
    await restoreTarget();
  }, 300_000);

  afterAll(async () => {
    await pool.query(`DROP TRIGGER IF EXISTS ${FAILURE_TRIGGER} ON demo_sandbox_slots`);
    await pool.query(`DROP FUNCTION IF EXISTS ${FAILURE_FUNCTION}()`);
    await pool.query(`DROP TABLE IF EXISTS ${FAILURE_CONTROL}`);
    await pool.end();
  });

  it("quarantines a failed reset, excludes the slot from bootstrap, and makes it non-claimable", async () => {
    const sandbox = await selectReadyTarget();
    const before = await pool.query<{ generation: number; last_reset_at: Date | null }>(
      `SELECT generation, last_reset_at
       FROM demo_sandbox_slots
       WHERE slot = $1 AND organization_id = $2`,
      [sandbox.slot, sandbox.organization_id],
    );
    await setDemoAccountantActive(false);
    await pool.query(
      `UPDATE demo_sandbox_slots SET state = 'RESETTING'
       WHERE slot = $1 AND organization_id = $2`,
      [sandbox.slot, sandbox.organization_id],
    );

    await expect(resetDemoSandboxes(pool, { mode: "bootstrap" })).rejects.toThrow(
      new RegExp(`slot ${sandbox.slot}: Demo sandbox slot ${sandbox.slot} has no active demo accountant`),
    );
    const quarantined = await pool.query<{
      state: string;
      generation: number;
      last_reset_at: Date | null;
      active_sessions: number;
      active_claims: number;
    }>(
      `SELECT slot.state, slot.generation, slot.last_reset_at,
         (SELECT count(*)::int FROM auth_sessions session
          WHERE session.organization_id = slot.organization_id
            AND session.session_mode = 'DEMO' AND session.revoked_at IS NULL) AS active_sessions,
         (SELECT count(*)::int FROM demo_daily_claims claim
          WHERE claim.organization_id = slot.organization_id
            AND claim.invalidated_at IS NULL) AS active_claims
       FROM demo_sandbox_slots slot
       WHERE slot.slot = $1 AND slot.organization_id = $2`,
      [sandbox.slot, sandbox.organization_id],
    );
    expect(quarantined.rows[0]).toEqual({
      state: "QUARANTINED",
      generation: before.rows[0]?.generation,
      last_reset_at: before.rows[0]?.last_reset_at,
      active_sessions: 0,
      active_claims: 0,
    });

    // Bootstrap deliberately excludes quarantined slots, so a deploy cannot
    // accidentally turn a failed sandbox back into visitor inventory.
    await resetDemoSandboxes(pool, { mode: "bootstrap" });
    expect((await pool.query(
      `SELECT state FROM demo_sandbox_slots
       WHERE slot = $1 AND organization_id = $2`,
      [sandbox.slot, sandbox.organization_id],
    )).rows[0]).toEqual({ state: "QUARANTINED" });

    // Hold every healthy candidate row. The database claim function must
    // return no lease rather than falling back to the quarantined target.
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      const locked = await locker.query(
        `SELECT slot FROM demo_sandbox_slots
         WHERE state = 'READY' AND organization_id <> $1
         ORDER BY slot FOR UPDATE`,
        [sandbox.organization_id],
      );
      expect(locked.rowCount).toBeGreaterThan(0);
      const claim = await pool.query(
        "SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
        [hashFixture(), null, hashFixture(), hashFixture(), hashFixture(), randomUUID()],
      );
      expect(claim.rowCount).toBe(0);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  }, 300_000);

  it("reports a quarantine failure without hiding the reset failure", async () => {
    const sandbox = await selectReadyTarget();
    await setDemoAccountantActive(false);
    await pool.query(
      `UPDATE demo_sandbox_slots SET state = 'RESETTING'
       WHERE slot = $1 AND organization_id = $2`,
      [sandbox.slot, sandbox.organization_id],
    );
    await setFailureInjection("FAIL_QUARANTINE");

    await expect(resetDemoSandboxes(pool, { mode: "bootstrap" })).rejects.toThrow(
      new RegExp(
        `slot ${sandbox.slot}: Demo sandbox slot ${sandbox.slot} has no active demo accountant; quarantine failed: forced quarantine failure`,
      ),
    );
    expect((await pool.query(
      `SELECT state FROM demo_sandbox_slots
       WHERE slot = $1 AND organization_id = $2`,
      [sandbox.slot, sandbox.organization_id],
    )).rows[0]).toEqual({ state: "RESETTING" });
  }, 300_000);

  it("quarantines a sandbox when the final READY transition loses its reset claim", async () => {
    const sandbox = await selectReadyTarget();
    await pool.query(
      `UPDATE demo_sandbox_slots SET state = 'RESETTING'
       WHERE slot = $1 AND organization_id = $2`,
      [sandbox.slot, sandbox.organization_id],
    );
    await setFailureInjection("SUPPRESS_READY");

    await expect(resetDemoSandboxes(pool, { mode: "bootstrap" })).rejects.toThrow(
      new RegExp(`slot ${sandbox.slot}: Demo sandbox slot ${sandbox.slot} lost its reset claim`),
    );
    expect((await pool.query(
      `SELECT state FROM demo_sandbox_slots
       WHERE slot = $1 AND organization_id = $2`,
      [sandbox.slot, sandbox.organization_id],
    )).rows[0]).toEqual({ state: "QUARANTINED" });
  }, 300_000);
});
