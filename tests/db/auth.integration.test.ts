import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;
const runRuntimeRoleTests = databaseUrl && appDatabaseUrl ? describe : describe.skip;

runDatabaseTests("PostgreSQL identity controls", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => pool.end());

  it("issues, resolves, and revokes a fixed read-only demo session", async () => {
    const tokenHash = randomUUID().replaceAll("-", "").repeat(2);
    const requestId = randomUUID();
    const issued = await pool.query(
      "SELECT * FROM app.auth_issue_demo_session($1, $2, $3, $4)",
      [tokenHash, "b".repeat(64), "c".repeat(64), requestId],
    );
    expect(issued.rows[0]).toMatchObject({
      user_id: "10000000-0000-4000-8000-000000000002",
      organization_id: "10000000-0000-4000-8000-000000000001",
      role_label: "Demo viewer",
    });

    const resolved = await pool.query("SELECT * FROM app.auth_resolve_session($1, $2)", [tokenHash, "c".repeat(64)]);
    expect(resolved.rows[0]).toMatchObject({ session_mode: "DEMO", auth_method: "DEMO_LINK" });
    await pool.query("UPDATE auth_sessions SET last_seen_at = now() - interval '6 minutes' WHERE token_hash = $1", [tokenHash]);
    const refreshed = await pool.query("SELECT * FROM app.auth_resolve_session($1, $2)", [tokenHash, "c".repeat(64)]);
    expect(refreshed.rows[0]).toMatchObject({ session_mode: "DEMO" });
    const wrongDevice = await pool.query("SELECT * FROM app.auth_resolve_session($1, $2)", [tokenHash, "d".repeat(64)]);
    expect(wrongDevice.rowCount).toBe(0);
    const missingDevice = await pool.query("SELECT * FROM app.auth_resolve_session($1, NULL)", [tokenHash]);
    expect(missingDevice.rowCount).toBe(0);

    await pool.query("INSERT INTO auth_security_events(event_type, outcome, request_id) VALUES ('TEST_EVENT', 'SUCCESS', $1)", [requestId]);
    await expect(pool.query("UPDATE auth_security_events SET outcome = 'FAILURE' WHERE request_id = $1", [requestId])).rejects.toThrow(/append-only/);
    const revoked = await pool.query("SELECT app.auth_revoke_session($1, $2) AS revoked", [tokenHash, randomUUID()]);
    expect(revoked.rows[0].revoked).toBe(true);
    const afterLogout = await pool.query("SELECT * FROM app.auth_resolve_session($1, $2)", [tokenHash, "c".repeat(64)]);
    expect(afterLogout.rowCount).toBe(0);
  });

  it("rate limits durably and resets by window", async () => {
    const key = randomUUID().replaceAll("-", "").repeat(2);
    expect((await pool.query("SELECT * FROM app.auth_consume_rate_limit('test', $1, 2, 60)", [key])).rows[0].allowed).toBe(true);
    expect((await pool.query("SELECT * FROM app.auth_consume_rate_limit('test', $1, 2, 60)", [key])).rows[0].allowed).toBe(true);
    const blocked = (await pool.query("SELECT * FROM app.auth_consume_rate_limit('test', $1, 2, 60)", [key])).rows[0];
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_after_seconds).toBeGreaterThan(0);
  });

  it("consumes a reset token once, revokes sessions, and preserves organization keys", async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const membershipId = randomUUID();
    const emailHash = randomUUID().replaceAll("-", "");
    const resetHash = randomUUID().replaceAll("-", "").repeat(2);
    const sessionHash = randomUUID().replaceAll("-", "").repeat(2);
    await pool.query("INSERT INTO organizations(id, slug, display_name) VALUES ($1, $2, 'Recovery Test')", [orgId, `recovery-${orgId}`]);
    await pool.query(
      "INSERT INTO users(id, email_lookup_hash, email_ciphertext, password_hash, email_verified_at) VALUES ($1, $2, 'encrypted-email', $3, now())",
      [userId, emailHash, "scrypt-v1$32768$8$1$salt$oldhash"],
    );
    await pool.query("INSERT INTO organization_memberships(id, organization_id, user_id) VALUES ($1, $2, $3)", [membershipId, orgId, userId]);
    await pool.query(
      "INSERT INTO organization_key_versions(organization_id, version, key_provider, wrapped_dek) VALUES ($1, 1, 'test', 'unchanged-envelope')",
      [orgId],
    );
    await pool.query(
      "INSERT INTO auth_sessions(token_hash,user_id,organization_id,membership_id,auth_method,session_mode,idle_timeout_seconds,idle_expires_at,expires_at) VALUES ($1,$2,$3,$4,'PASSWORD','REAL',7200,now()+interval '2 hours',now()+interval '24 hours')",
      [sessionHash, userId, orgId, membershipId],
    );

    const prepared = await pool.query("SELECT * FROM app.auth_prepare_password_reset($1, $2, $3, $4)", [emailHash, resetHash, "e".repeat(64), randomUUID()]);
    expect(prepared.rows[0].user_id).toBe(userId);
    const replacementHash = `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`;
    const finished = await pool.query("SELECT app.auth_finish_password_reset($1, $2, $3) AS finished", [resetHash, replacementHash, randomUUID()]);
    expect(finished.rows[0].finished).toBe(true);
    expect((await pool.query("SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE token_hash=$1", [sessionHash])).rows[0].revoked).toBe(true);
    expect((await pool.query("SELECT wrapped_dek FROM organization_key_versions WHERE organization_id=$1", [orgId])).rows[0].wrapped_dek).toBe("unchanged-envelope");
    expect((await pool.query("SELECT app.auth_finish_password_reset($1, $2, $3) AS finished", [resetHash, replacementHash, randomUUID()])).rows[0].finished).toBe(false);
  });
});

runRuntimeRoleTests("PostgreSQL runtime authentication boundary", () => {
  const runtimePool = new Pool({ connectionString: appDatabaseUrl });

  afterAll(async () => runtimePool.end());

  it("executes approved auth functions without direct auth-table access", async () => {
    const tokenHash = randomUUID().replaceAll("-", "").repeat(2);
    const issued = await runtimePool.query(
      "SELECT * FROM app.auth_issue_demo_session($1, $2, $3, $4)",
      [tokenHash, "f".repeat(64), "a".repeat(64), randomUUID()],
    );
    expect(issued.rows[0]?.session_id).toBeTruthy();
    await expect(runtimePool.query("SELECT token_hash FROM auth_sessions LIMIT 1")).rejects.toThrow(/permission denied/);
    const resolved = await runtimePool.query("SELECT * FROM app.auth_resolve_session($1, $2)", [tokenHash, "a".repeat(64)]);
    expect(resolved.rows[0]).toMatchObject({ session_mode: "DEMO" });
    await runtimePool.query("SELECT app.auth_revoke_session($1, $2)", [tokenHash, randomUUID()]);
  });
});
