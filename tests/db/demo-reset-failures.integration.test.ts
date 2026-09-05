import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { DEMO_ORGANIZATION_ID } from "@/modules/demo/constants";
import {
  bootstrapDemoOrganization,
  DEMO_BASELINE_VERSION,
  resetSharedDemoOrganization,
} from "@/modules/onboarding/demo-bootstrap";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;
const invalidRegistryTable = "shared_demo_missing_reset_table";

function hashFixture(): string {
  return randomUUID().replaceAll("-", "").repeat(2);
}

runDatabaseTests("shared demo reset failure containment", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  async function setDemoAccountantActive(active: boolean): Promise<void> {
    const result = await pool.query(
      `UPDATE roles SET active = $2
       WHERE organization_id = $1 AND key = 'demo_accountant'
       RETURNING id`,
      [DEMO_ORGANIZATION_ID, active],
    );
    if (result.rowCount !== 1) throw new Error("Shared demo has no canonical demo_accountant role");
  }

  async function restoreSharedDemo(): Promise<void> {
    await pool.query("DELETE FROM demo_sandbox_reset_tables WHERE table_name = $1", [invalidRegistryTable]);
    await setDemoAccountantActive(true);
    await bootstrapDemoOrganization(pool);
    expect((await pool.query(
      `SELECT status, baseline_version, last_error
       FROM shared_demo_reset_state WHERE singleton`,
    )).rows[0]).toEqual({
      status: "READY",
      baseline_version: DEMO_BASELINE_VERSION,
      last_error: null,
    });
  }

  afterEach(restoreSharedDemo, 300_000);
  afterAll(async () => pool.end());

  it("marks the shared demo failed and unavailable when its canonical identity is invalid", async () => {
    const tokenHash = hashFixture();
    const issued = await pool.query(
      "SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
      [tokenHash, null, null, hashFixture(), hashFixture(), randomUUID()],
    );
    expect(issued.rowCount).toBe(1);
    await setDemoAccountantActive(false);

    await expect(resetSharedDemoOrganization(pool, { mode: "nightly" }))
      .rejects.toThrow(/Shared public demo identity has not been installed/);

    const failed = await pool.query<{
      status: string;
      reset_started_at: Date | null;
      last_error: string | null;
      active_sessions: number;
    }>(
      `SELECT reset_state.status, reset_state.reset_started_at,
         reset_state.last_error,
         (SELECT count(*)::int FROM auth_sessions selected_session
          WHERE selected_session.organization_id = $1
            AND selected_session.session_mode = 'DEMO'
            AND selected_session.revoked_at IS NULL) AS active_sessions
       FROM shared_demo_reset_state reset_state
       WHERE reset_state.singleton`,
      [DEMO_ORGANIZATION_ID],
    );
    expect(failed.rows[0]).toMatchObject({
      status: "FAILED",
      reset_started_at: null,
      active_sessions: 0,
    });
    expect(failed.rows[0]?.last_error).toMatch(/Shared public demo identity/);
    const denied = await pool.query(
      "SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
      [hashFixture(), null, null, hashFixture(), hashFixture(), randomUUID()],
    );
    expect(denied.rowCount).toBe(0);
  }, 300_000);

  it("fails closed when the purge registry references a missing tenant table", async () => {
    await pool.query(
      `INSERT INTO demo_sandbox_reset_tables(table_name, purge_order)
       SELECT $1, max(purge_order) + 1 FROM demo_sandbox_reset_tables`,
      [invalidRegistryTable],
    );
    await expect(resetSharedDemoOrganization(pool, { mode: "nightly" }))
      .rejects.toThrow(/reset registry contains an invalid organization-owned table/);
    expect((await pool.query(
      "SELECT status FROM shared_demo_reset_state WHERE singleton",
    )).rows[0]).toEqual({ status: "FAILED" });
  }, 300_000);

  it("revokes every visitor session and restores shared organization changes", async () => {
    const tokens = [hashFixture(), hashFixture()];
    for (const token of tokens) {
      const issued = await pool.query(
        "SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
        [token, null, null, hashFixture(), hashFixture(), randomUUID()],
      );
      expect(issued.rowCount).toBe(1);
    }
    await pool.query(
      "UPDATE organizations SET display_name = 'Visitor changed shared demo' WHERE id = $1",
      [DEMO_ORGANIZATION_ID],
    );

    await resetSharedDemoOrganization(pool, { mode: "nightly" });

    const restored = await pool.query<{
      display_name: string;
      active_sessions: number;
      source_documents: number;
    }>(
      `SELECT organization.display_name,
         (SELECT count(*)::int FROM auth_sessions selected_session
          WHERE selected_session.organization_id = organization.id
            AND selected_session.session_mode = 'DEMO'
            AND selected_session.revoked_at IS NULL) AS active_sessions,
         (SELECT count(*)::int FROM source_documents source
          WHERE source.organization_id = organization.id) AS source_documents
       FROM organizations organization WHERE organization.id = $1`,
      [DEMO_ORGANIZATION_ID],
    );
    expect(restored.rows[0]).toEqual({
      display_name: "Northstar Demo Group",
      active_sessions: 0,
      source_documents: 8,
    });
  }, 300_000);
});
