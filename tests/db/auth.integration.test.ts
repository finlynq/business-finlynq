import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;
const authWorkerDatabaseUrl = process.env.TEST_AUTH_WORKER_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;
const runRuntimeRoleTests = databaseUrl && appDatabaseUrl ? describe : describe.skip;
const runWorkerRoleTests = databaseUrl && authWorkerDatabaseUrl ? describe : describe.skip;

runDatabaseTests("PostgreSQL identity controls", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => pool.end());

  it("claims, resolves, logs out, and re-enters the same isolated daily sandbox", async () => {
    const tokenHash = randomUUID().replaceAll("-", "").repeat(2);
    const claimHash = randomUUID().replaceAll("-", "").repeat(2);
    const requestId = randomUUID();
    const issued = await pool.query(
      "SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
      [tokenHash, null, claimHash, "b".repeat(64), "c".repeat(64), requestId],
    );
    expect(issued.rows[0]).toMatchObject({ role_label: "Demo owner", claim_created: true });
    expect(issued.rows[0].session_id).toBeTruthy();
    expect(issued.rows[0].user_id).toBeTruthy();
    expect(issued.rows[0].organization_id).toBeTruthy();
    expect(issued.rows[0].membership_id).toBeTruthy();
    expect(issued.rows[0].organization_name).toMatch(/^Northstar Demo Sandbox \d{3}$/);
    const assigned = await pool.query(
      `SELECT slot.state, organization.organization_mode
       FROM demo_sandbox_slots slot
       JOIN organizations organization ON organization.id = slot.organization_id
       WHERE slot.organization_id = $1`,
      [issued.rows[0].organization_id],
    );
    expect(assigned.rows[0]).toMatchObject({
      state: "ASSIGNED",
      organization_mode: "SANDBOX",
    });

    const resolved = await pool.query("SELECT * FROM app.auth_resolve_session_v2($1, $2)", [tokenHash, "c".repeat(64)]);
    expect(resolved.rows[0]).toMatchObject({ session_mode: "DEMO", auth_method: "DEMO_LINK" });
    await pool.query("UPDATE auth_sessions SET last_seen_at = now() - interval '6 minutes' WHERE token_hash = $1", [tokenHash]);
    const refreshed = await pool.query("SELECT * FROM app.auth_resolve_session_v2($1, $2)", [tokenHash, "c".repeat(64)]);
    expect(refreshed.rows[0]).toMatchObject({ session_mode: "DEMO" });
    const wrongDevice = await pool.query("SELECT * FROM app.auth_resolve_session_v2($1, $2)", [tokenHash, "d".repeat(64)]);
    expect(wrongDevice.rowCount).toBe(0);
    const missingDevice = await pool.query("SELECT * FROM app.auth_resolve_session_v2($1, NULL)", [tokenHash]);
    expect(missingDevice.rowCount).toBe(0);
    await expect(pool.query(
      "UPDATE auth_sessions SET user_agent_hash = NULL WHERE token_hash = $1",
      [tokenHash],
    )).rejects.toThrow(/cannot be downgraded/);
    const nullInsertTokenHash = randomUUID().replaceAll("-", "").repeat(2);
    await expect(pool.query(
      `INSERT INTO auth_sessions (
         token_hash, user_id, organization_id, membership_id, auth_method,
         session_mode, ip_hash, user_agent_hash, idle_timeout_seconds,
         idle_expires_at, expires_at, mfa_verified_at, step_up_expires_at,
         demo_generation, demo_claim_id
       )
       SELECT $2, user_id, organization_id, membership_id, auth_method,
              session_mode, ip_hash, NULL, idle_timeout_seconds,
              idle_expires_at, expires_at, mfa_verified_at, step_up_expires_at,
              demo_generation, demo_claim_id
       FROM auth_sessions
       WHERE token_hash = $1`,
      [tokenHash, nullInsertTokenHash],
    )).rejects.toThrow(/require a user-agent fingerprint/);

    // Reproduce a row issued before 0027 without weakening the new-session
    // trigger. CI's owner-only test connection may bypass user triggers for
    // this one transaction; application/runtime roles cannot do so.
    const legacyClient = await pool.connect();
    try {
      await legacyClient.query("BEGIN");
      await legacyClient.query("SET LOCAL session_replication_role = replica");
      await legacyClient.query(
        "UPDATE auth_sessions SET user_agent_hash = NULL WHERE token_hash = $1",
        [tokenHash],
      );
      await legacyClient.query("COMMIT");
    } catch (error) {
      await legacyClient.query("ROLLBACK");
      throw error;
    } finally {
      legacyClient.release();
    }
    const legacyWildcard = await pool.query(
      "SELECT * FROM app.auth_resolve_session_v2($1, $2)",
      [tokenHash, "legacy-request-agent-hash"],
    );
    expect(legacyWildcard.rows[0]).toMatchObject({ session_mode: "DEMO", auth_method: "DEMO_LINK" });

    await pool.query("INSERT INTO auth_security_events(event_type, outcome, request_id) VALUES ('TEST_EVENT', 'SUCCESS', $1)", [requestId]);
    await expect(pool.query("UPDATE auth_security_events SET outcome = 'FAILURE' WHERE request_id = $1", [requestId])).rejects.toThrow(/append-only/);
    const revoked = await pool.query("SELECT app.auth_revoke_session($1, $2) AS revoked", [tokenHash, randomUUID()]);
    expect(revoked.rows[0].revoked).toBe(true);
    const afterLogout = await pool.query("SELECT * FROM app.auth_resolve_session_v2($1, $2)", [tokenHash, "c".repeat(64)]);
    expect(afterLogout.rowCount).toBe(0);
    const preserved = await pool.query(
      "SELECT state FROM demo_sandbox_slots WHERE organization_id = $1",
      [issued.rows[0].organization_id],
    );
    expect(preserved.rows[0]).toMatchObject({ state: "ASSIGNED" });

    const reentryTokenHash = randomUUID().replaceAll("-", "").repeat(2);
    const reentered = await pool.query(
      "SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
      [reentryTokenHash, claimHash, "e".repeat(64), "b".repeat(64), "c".repeat(64), randomUUID()],
    );
    expect(reentered.rows[0]).toMatchObject({
      organization_id: issued.rows[0].organization_id,
      claim_created: false,
    });
    expect((await pool.query(
      "SELECT app.auth_mark_demo_step_up($1, $2) AS marked",
      [reentered.rows[0].session_id, randomUUID()],
    )).rows[0].marked).toBe(true);
    expect((await pool.query(
      "SELECT step_up_expires_at > now() AS stepped_up FROM auth_sessions WHERE id = $1",
      [reentered.rows[0].session_id],
    )).rows[0].stepped_up).toBe(true);
    await pool.query("SELECT app.auth_revoke_session($1, $2)", [reentryTokenHash, randomUUID()]);
  });

  it("allows release-gate retries but caps one network at 16 daily claims", async () => {
    const ipHash = randomUUID().replaceAll("-", "").repeat(2);
    const attempts = Array.from({ length: 17 }, (_, index) => ({
      tokenHash: randomUUID().replaceAll("-", "").repeat(2),
      requestId: `demo-ip-cap-${index}-${randomUUID()}`,
    }));
    const issued = await Promise.all(attempts.map((attempt) => pool.query(
      "SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
      [attempt.tokenHash, null, randomUUID().replaceAll("-", "").repeat(2), ipHash, "d".repeat(64), attempt.requestId],
    )));
    expect(issued.filter((result) => result.rowCount === 1)).toHaveLength(16);
    expect(issued.filter((result) => result.rowCount === 0)).toHaveLength(1);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM auth_sessions
       WHERE session_mode = 'DEMO' AND ip_hash = $1 AND revoked_at IS NULL
         AND expires_at > now() AND idle_expires_at > now()`,
      [ipHash],
    )).rows[0]?.count).toBe(16);
    await Promise.all(attempts.map((attempt, index) =>
      issued[index]?.rowCount === 1
        ? pool.query("SELECT app.auth_revoke_session($1, $2)", [attempt.tokenHash, randomUUID()])
        : Promise.resolve()));
  });

  it("holds a demo lease through the tenant transaction and blocks handoff", async () => {
    const tokenHash = randomUUID().replaceAll("-", "").repeat(2);
    const issued = await pool.query(
      "SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
      [tokenHash, null, randomUUID().replaceAll("-", "").repeat(2), randomUUID().replaceAll("-", "").repeat(2), "e".repeat(64), randomUUID()],
    );
    const principal = issued.rows[0];
    expect(principal?.session_id).toBeTruthy();
    const tenant = await pool.connect();
    const revoker = await pool.connect();
    try {
      await tenant.query("BEGIN");
      await tenant.query("SELECT set_config('app.organization_id', $1, true)", [principal.organization_id]);
      await tenant.query("SELECT set_config('app.actor_id', $1, true)", [principal.user_id]);
      await tenant.query("SELECT set_config('app.session_id', $1, true)", [principal.session_id]);
      await tenant.query("SELECT set_config('app.session_mode', 'demo', true)");
      await tenant.query("SELECT set_config('app.auth_method', 'demo-link', true)");
      await tenant.query("SELECT app.assert_current_demo_session_lease()");

      await revoker.query("BEGIN");
      await revoker.query("SET LOCAL lock_timeout = '100ms'");
      await expect(revoker.query(
        "SELECT app.auth_revoke_session($1, $2)",
        [tokenHash, randomUUID()],
      )).rejects.toThrow(/lock timeout/i);
      await revoker.query("ROLLBACK");

      await tenant.query("COMMIT");
      expect((await pool.query(
        "SELECT app.auth_revoke_session($1, $2) AS revoked",
        [tokenHash, randomUUID()],
      )).rows[0]?.revoked).toBe(true);

      await tenant.query("BEGIN");
      await tenant.query("SELECT set_config('app.organization_id', $1, true)", [principal.organization_id]);
      await tenant.query("SELECT set_config('app.actor_id', $1, true)", [principal.user_id]);
      await tenant.query("SELECT set_config('app.session_id', $1, true)", [principal.session_id]);
      await tenant.query("SELECT set_config('app.session_mode', 'demo', true)");
      await tenant.query("SELECT set_config('app.auth_method', 'demo-link', true)");
      await expect(tenant.query("SELECT app.assert_current_demo_session_lease()"))
        .rejects.toMatchObject({
          code: "28000",
          message: "Demo session claim is not live",
        });
      await tenant.query("ROLLBACK");
    } finally {
      await tenant.query("ROLLBACK").catch(() => undefined);
      await revoker.query("ROLLBACK").catch(() => undefined);
      tenant.release();
      revoker.release();
    }
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
      "INSERT INTO auth_sessions(token_hash,user_id,organization_id,membership_id,auth_method,session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at) VALUES ($1,$2,$3,$4,'PASSWORD','REAL',repeat('u',64),7200,now()+interval '2 hours',now()+interval '24 hours')",
      [sessionHash, userId, orgId, membershipId],
    );

    const outboxId = randomUUID();
    await pool.query("SELECT app.auth_queue_password_reset($1,$2,'encrypted-reset-payload',$3,$4,$5)",
      [emailHash, resetHash, outboxId, "e".repeat(64), randomUUID()]);
    expect((await pool.query("SELECT recovery_policy FROM auth_one_time_tokens WHERE token_hash=$1", [resetHash])).rows[0].recovery_policy).toBe("EMAIL_ONLY");
    expect((await pool.query("SELECT status FROM auth_email_outbox WHERE id=$1", [outboxId])).rows[0].status).toBe("PENDING");
    expect((await pool.query("SELECT * FROM app.auth_consume_password_reset_limits($1)", [resetHash])).rows[0].allowed).toBe(true);
    const replacementHash = `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`;
    const factorId = randomUUID();
    expect((await pool.query("SELECT app.auth_finish_password_reset($1, $2, $3) AS finished", [resetHash, replacementHash, randomUUID()])).rows[0].finished).toBe(false);
    expect((await pool.query(
      "SELECT app.auth_prepare_recovery_mfa($1,$2,$3,$4) AS prepared",
      [resetHash, factorId, "authv1:" + "e".repeat(64), randomUUID()],
    )).rows[0].prepared).toBe(true);
    const finished = await pool.query(
      "SELECT app.auth_finish_password_reset_with_mfa($1,$2,$3,20,$4) AS finished",
      [resetHash, replacementHash, factorId, randomUUID()],
    );
    expect(finished.rows[0].finished).toBe(true);
    expect((await pool.query("SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE token_hash=$1", [sessionHash])).rows[0].revoked).toBe(true);
    expect((await pool.query("SELECT wrapped_dek FROM organization_key_versions WHERE organization_id=$1", [orgId])).rows[0].wrapped_dek).toBe("unchanged-envelope");
    expect((await pool.query("SELECT * FROM app.auth_consume_password_reset_limits($1)", [resetHash])).rows[0].allowed).toBe(true);
    expect((await pool.query(
      "SELECT app.auth_finish_password_reset_with_mfa($1,$2,$3,21,$4) AS finished",
      [resetHash, replacementHash, factorId, randomUUID()],
    )).rows[0].finished).toBe(false);
  });

  it("activates invitations only after TOTP enrollment and prevents code replay", async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const membershipId = randomUUID();
    const inviteHash = randomUUID().replaceAll("-", "").repeat(2);
    const setupHash = randomUUID().replaceAll("-", "").repeat(2);
    const factorId = randomUUID();
    const roleId = randomUUID();
    const invitationId = randomUUID();
    const invitationTokenId = randomUUID();
    await pool.query("INSERT INTO organizations(id,slug,display_name) VALUES($1,$2,'Invite Test')", [orgId, `invite-${orgId}`]);
    await pool.query(
      "INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active,mfa_required) VALUES($1,$2,'encrypted-email','!invitation-pending!',false,true)",
      [userId, randomUUID().replaceAll("-", "")],
    );
    await pool.query(
      "INSERT INTO roles(id,organization_id,key,display_name,system_template,active) VALUES($1,$2,'VIEWER_AUDITOR','Viewer',true,true)",
      [roleId, orgId],
    );
    await pool.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,false)", [membershipId, orgId, userId]);
    await pool.query("INSERT INTO auth_one_time_tokens(id,token_hash,purpose,user_id,organization_id,expires_at) VALUES($1,$2,'INVITATION',$3,$4,now()+interval '1 hour')", [invitationTokenId, inviteHash, userId, orgId]);
    await pool.query(
      `INSERT INTO organization_invitations(
         id,organization_id,user_id,membership_id,role_id,token_id,
         status,invited_by_user_id,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$3,now()+interval '1 hour')`,
      [invitationId, orgId, userId, membershipId, roleId, invitationTokenId],
    );
    const passwordHash = `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`;
    const accepted = await pool.query(
      "SELECT * FROM app.auth_accept_invitation($1,$2,$3,$4,$5,$6)",
      [inviteHash, passwordHash, factorId, "authv1:" + "x".repeat(64), setupHash, randomUUID()],
    );
    expect(accepted.rows[0]).toMatchObject({ user_id: userId, factor_id: factorId });
    expect((await pool.query("SELECT active FROM users WHERE id=$1", [userId])).rows[0].active).toBe(false);
    expect((await pool.query("SELECT * FROM app.auth_mfa_setup_challenge($1)", [setupHash])).rows[0].factor_id).toBe(factorId);
    expect((await pool.query("SELECT * FROM app.auth_consume_mfa_enrollment_limits($1)", [setupHash])).rows[0].allowed).toBe(true);
    expect((await pool.query("SELECT app.auth_finish_mfa_enrollment($1,$2,100,$3) AS finished", [setupHash, factorId, randomUUID()])).rows[0].finished).toBe(true);
    expect((await pool.query("SELECT * FROM app.auth_consume_mfa_enrollment_limits($1)", [setupHash])).rows[0].allowed).toBe(true);
    expect((await pool.query("SELECT app.auth_finish_mfa_enrollment($1,$2,100,$3) AS finished", [setupHash, factorId, randomUUID()])).rows[0].finished).toBe(false);
    expect((await pool.query("SELECT active FROM users WHERE id=$1", [userId])).rows[0].active).toBe(true);
    expect((await pool.query("SELECT active FROM organization_memberships WHERE id=$1", [membershipId])).rows[0].active).toBe(true);

    const sessionHash = randomUUID().replaceAll("-", "").repeat(2);
    expect((await pool.query(
      "SELECT app.auth_issue_mfa_user_session($1,$2,$3,$4,101,$5,$6,$7,$8) AS session_id",
      [userId, orgId, membershipId, factorId, sessionHash, "i".repeat(64), "u".repeat(64), randomUUID()],
    )).rows[0].session_id).toBeTruthy();
    expect((await pool.query(
      "SELECT app.auth_issue_mfa_user_session($1,$2,$3,$4,101,$5,$6,$7,$8) AS session_id",
      [userId, orgId, membershipId, factorId, randomUUID().replaceAll("-", "").repeat(2), "i".repeat(64), "u".repeat(64), randomUUID()],
    )).rows[0].session_id).toBeNull();
    expect((await pool.query("SELECT * FROM app.auth_resolve_session_v2($1,$2)", [sessionHash, "u".repeat(64)])).rows[0].mfa_verified_at).toBeTruthy();
    const sessionId = (await pool.query("SELECT id FROM auth_sessions WHERE token_hash=$1", [sessionHash])).rows[0].id;
    expect((await pool.query("SELECT * FROM app.auth_consume_mfa_step_up_limits($1)", [sessionId])).rows[0].allowed).toBe(true);
    expect((await pool.query("SELECT app.auth_mark_step_up($1,$2,102,$3) AS marked", [sessionId, factorId, randomUUID()])).rows[0].marked).toBe(true);
    expect((await pool.query("SELECT * FROM app.auth_consume_mfa_step_up_limits($1)", [sessionId])).rows[0].allowed).toBe(true);
    expect((await pool.query("SELECT app.auth_mark_step_up($1,$2,102,$3) AS marked", [sessionId, factorId, randomUUID()])).rows[0].marked).toBe(false);
  });

  it("requires a different recovery administrator and fresh TOTP counter for co-owner recovery", async () => {
    const orgId = randomUUID();
    const targetId = randomUUID();
    const approverId = randomUUID();
    const targetMembership = randomUUID();
    const approverMembership = randomUUID();
    const roleId = randomUUID();
    const factorId = randomUUID();
    const targetFactorId = randomUUID();
    const sessionHash = randomUUID().replaceAll("-", "").repeat(2);
    const resetHash = randomUUID().replaceAll("-", "").repeat(2);
    await pool.query("INSERT INTO organizations(id,slug,display_name) VALUES($1,$2,'Co-owner Recovery')", [orgId, `co-owner-${orgId}`]);
    await pool.query(
      "INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,email_verified_at,mfa_required) VALUES($1,$2,'target-email','password-hash',now(),true),($3,$4,'approver-email','password-hash',now(),true)",
      [targetId, randomUUID().replaceAll("-", ""), approverId, randomUUID().replaceAll("-", "")],
    );
    await pool.query("INSERT INTO organization_memberships(id,organization_id,user_id) VALUES($1,$2,$3),($4,$2,$5)", [targetMembership, orgId, targetId, approverMembership, approverId]);
    await pool.query("INSERT INTO roles(id,organization_id,key,display_name) VALUES($1,$2,$3,'Recovery owner')", [roleId, orgId, `recovery-${roleId}`]);
    await pool.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,'organization.recovery.manage')", [orgId, roleId]);
    await pool.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$4,$5),($1,$3,$4,$5)", [orgId, targetMembership, approverMembership, roleId, approverId]);
    await pool.query("INSERT INTO auth_mfa_factors(id,user_id,factor_type,label,secret_ciphertext,status,last_accepted_counter,verified_at) VALUES($1,$2,'TOTP','Primary','encrypted-factor','ACTIVE',10,now()),($3,$4,'TOTP','Primary','encrypted-target-factor','ACTIVE',10,now())", [factorId, approverId, targetFactorId, targetId]);
    const sessionId = (await pool.query(
      "SELECT app.auth_issue_mfa_user_session($1,$2,$3,$4,11,$5,$6,$7,$8) AS id",
      [approverId, orgId, approverMembership, factorId, sessionHash, "i".repeat(64), "u".repeat(64), randomUUID()],
    )).rows[0].id;
    const targetEmailHash = (await pool.query("SELECT email_lookup_hash FROM users WHERE id=$1", [targetId])).rows[0].email_lookup_hash;
    await pool.query("SELECT app.auth_queue_password_reset($1,$2,'encrypted',$3,$4,$5)", [targetEmailHash, resetHash, randomUUID(), "i".repeat(64), randomUUID()]);
    const recovery = (await pool.query("SELECT id,status FROM auth_recovery_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [targetId])).rows[0];
    expect((await pool.query("SELECT recovery_policy FROM auth_one_time_tokens WHERE token_hash=$1", [resetHash])).rows[0].recovery_policy).toBe("TOTP");
    expect((await pool.query("SELECT app.auth_authorize_password_reset_totp($1,$2,11,$3) AS authorized", [resetHash, targetFactorId, randomUUID()])).rows[0].authorized).toBe(true);
    expect((await pool.query("SELECT app.auth_authorize_password_reset_totp($1,$2,11,$3) AS authorized", [resetHash, targetFactorId, randomUUID()])).rows[0].authorized).toBe(false);
    expect((await pool.query("SELECT * FROM app.auth_escalate_password_reset($1,$2)", [resetHash, randomUUID()])).rows[0].recovery_policy).toBe("CO_OWNER");
    expect((await pool.query("SELECT * FROM app.auth_consume_recovery_approval_limits($1,$2)", [sessionId, recovery.id])).rows[0].allowed).toBe(true);
    expect((await pool.query("SELECT app.auth_approve_recovery($1,$2,$3,12,$4) AS approved", [recovery.id, sessionId, factorId, randomUUID()])).rows[0].approved).toBe(true);
    expect((await pool.query("SELECT * FROM app.auth_consume_recovery_approval_limits($1,$2)", [sessionId, recovery.id])).rows[0].allowed).toBe(true);
    expect((await pool.query("SELECT app.auth_approve_recovery($1,$2,$3,12,$4) AS approved", [recovery.id, sessionId, factorId, randomUUID()])).rows[0].approved).toBe(false);
    const replacementHash = `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`;
    const replacementFactorId = randomUUID();
    expect((await pool.query("SELECT app.auth_finish_password_reset($1,$2,$3) AS finished", [resetHash, replacementHash, randomUUID()])).rows[0].finished).toBe(false);
    expect((await pool.query(
      "SELECT app.auth_finish_password_reset_with_mfa($1,$2,$3,20,$4) AS finished",
      [resetHash, replacementHash, replacementFactorId, randomUUID()],
    )).rows[0].finished).toBe(false);
    expect((await pool.query(
      "SELECT app.auth_prepare_recovery_mfa($1,$2,$3,$4) AS prepared",
      [resetHash, replacementFactorId, "authv1:" + "r".repeat(64), randomUUID()],
    )).rows[0].prepared).toBe(true);
    expect((await pool.query("SELECT * FROM app.auth_password_reset_challenge($1)", [resetHash])).rows[0].replacement_factor_id).toBe(replacementFactorId);
    expect((await pool.query("SELECT * FROM app.auth_consume_password_reset_limits($1)", [resetHash])).rows[0].allowed).toBe(true);
    expect((await pool.query(
      "SELECT app.auth_finish_password_reset_with_mfa($1,$2,$3,20,$4) AS finished",
      [resetHash, replacementHash, replacementFactorId, randomUUID()],
    )).rows[0].finished).toBe(true);
    const factors = await pool.query("SELECT id,status FROM auth_mfa_factors WHERE user_id=$1 ORDER BY id", [targetId]);
    expect(factors.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: targetFactorId, status: "REVOKED" }),
      expect.objectContaining({ id: replacementFactorId, status: "ACTIVE" }),
    ]));
  });

  it("enforces the sole-owner delay and replacement-factor enrollment", async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const membershipId = randomUUID();
    const roleId = randomUUID();
    const oldFactorId = randomUUID();
    const replacementFactorId = randomUUID();
    const emailHash = randomUUID().replaceAll("-", "");
    const resetHash = randomUUID().replaceAll("-", "").repeat(2);
    await pool.query("INSERT INTO organizations(id,slug,display_name) VALUES($1,$2,'Sole-owner Recovery')", [orgId, `sole-owner-${orgId}`]);
    await pool.query(
      "INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,email_verified_at,mfa_required) VALUES($1,$2,'sole-owner-email','password-hash',now(),true)",
      [userId, emailHash],
    );
    await pool.query("INSERT INTO organization_memberships(id,organization_id,user_id) VALUES($1,$2,$3)", [membershipId, orgId, userId]);
    await pool.query("INSERT INTO roles(id,organization_id,key,display_name) VALUES($1,$2,$3,'Sole owner')", [roleId, orgId, `sole-owner-${roleId}`]);
    await pool.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,'organization.recovery.manage')", [orgId, roleId]);
    await pool.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)", [orgId, membershipId, roleId, userId]);
    await pool.query(
      "INSERT INTO auth_mfa_factors(id,user_id,factor_type,label,secret_ciphertext,status,last_accepted_counter,verified_at) VALUES($1,$2,'TOTP','Primary','old-factor','ACTIVE',10,now())",
      [oldFactorId, userId],
    );
    await pool.query("SELECT app.auth_queue_password_reset($1,$2,'encrypted',$3,$4,$5)", [emailHash, resetHash, randomUUID(), "i".repeat(64), randomUUID()]);
    const escalated = (await pool.query("SELECT * FROM app.auth_escalate_password_reset($1,$2)", [resetHash, randomUUID()])).rows[0];
    expect(escalated.recovery_policy).toBe("DELAYED");
    expect((await pool.query(
      "SELECT app.auth_prepare_recovery_mfa($1,$2,$3,$4) AS prepared",
      [resetHash, replacementFactorId, "authv1:" + "d".repeat(64), randomUUID()],
    )).rows[0].prepared).toBe(false);

    await pool.query("UPDATE auth_one_time_tokens SET available_at=now()-interval '1 second' WHERE token_hash=$1", [resetHash]);
    expect((await pool.query(
      "SELECT app.auth_prepare_recovery_mfa($1,$2,$3,$4) AS prepared",
      [resetHash, replacementFactorId, "authv1:" + "d".repeat(64), randomUUID()],
    )).rows[0].prepared).toBe(true);
    const replacementHash = `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`;
    expect((await pool.query(
      "SELECT app.auth_finish_password_reset_with_mfa($1,$2,$3,20,$4) AS finished",
      [resetHash, replacementHash, replacementFactorId, randomUUID()],
    )).rows[0].finished).toBe(true);
  });

  it("keeps protected principal and token budgets fixed while source IPs rotate", async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const membershipId = randomUUID();
    const sessionId = randomUUID();
    const resetTokenId = randomUUID();
    const resetHash = randomUUID().replaceAll("-", "").repeat(2);
    const setupHash = randomUUID().replaceAll("-", "").repeat(2);
    const recoveryRequestId = randomUUID();
    await pool.query("INSERT INTO organizations(id,slug,display_name) VALUES($1,$2,'Rate-limit Test')", [orgId, `rate-limit-${orgId}`]);
    await pool.query(
      "INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,email_verified_at) VALUES($1,$2,'rate-limit-email','password-hash',now())",
      [userId, randomUUID().replaceAll("-", "")],
    );
    await pool.query("INSERT INTO organization_memberships(id,organization_id,user_id) VALUES($1,$2,$3)", [membershipId, orgId, userId]);
    await pool.query(
      "INSERT INTO auth_sessions(id,token_hash,user_id,organization_id,membership_id,auth_method,session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at) VALUES($1,$2,$3,$4,$5,'PASSWORD','REAL',repeat('u',64),7200,now()+interval '2 hours',now()+interval '24 hours')",
      [sessionId, randomUUID().replaceAll("-", "").repeat(2), userId, orgId, membershipId],
    );
    await pool.query(
      "INSERT INTO auth_one_time_tokens(id,token_hash,purpose,user_id,organization_id,expires_at,recovery_policy) VALUES($1,$2,'PASSWORD_RESET',$3,$4,now()+interval '1 hour','TOTP'),($5,$6,'MFA_SETUP',$3,$4,now()+interval '1 hour',NULL)",
      [resetTokenId, resetHash, userId, orgId, randomUUID(), setupHash],
    );
    await pool.query(
      "INSERT INTO auth_recovery_requests(id,token_id,user_id,organization_id,policy,expires_at) VALUES($1,$2,$3,$4,'TOTP',now()+interval '1 hour')",
      [recoveryRequestId, resetTokenId, userId, orgId],
    );

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const ipKey = randomUUID().replaceAll("-", "");
      expect((await pool.query("SELECT * FROM app.auth_consume_rate_limit('mfa-step-up-ip-hour',$1,20,3600)", [ipKey])).rows[0].allowed).toBe(true);
      expect((await pool.query("SELECT * FROM app.auth_consume_mfa_step_up_limits($1)", [sessionId])).rows[0].allowed).toBe(attempt <= 8);
    }
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const ipKey = randomUUID().replaceAll("-", "");
      expect((await pool.query("SELECT * FROM app.auth_consume_rate_limit('password-reset-confirm-ip-hour',$1,10,3600)", [ipKey])).rows[0].allowed).toBe(true);
      expect((await pool.query("SELECT * FROM app.auth_consume_password_reset_limits($1)", [resetHash])).rows[0].allowed).toBe(attempt <= 8);
    }
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const ipKey = randomUUID().replaceAll("-", "");
      expect((await pool.query("SELECT * FROM app.auth_consume_rate_limit('mfa-enrollment-ip-hour',$1,10,3600)", [ipKey])).rows[0].allowed).toBe(true);
      expect((await pool.query("SELECT * FROM app.auth_consume_mfa_enrollment_limits($1)", [setupHash])).rows[0].allowed).toBe(attempt <= 8);
    }
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const ipKey = randomUUID().replaceAll("-", "");
      expect((await pool.query("SELECT * FROM app.auth_consume_rate_limit('recovery-approval-ip-hour',$1,10,3600)", [ipKey])).rows[0].allowed).toBe(true);
      expect((await pool.query("SELECT * FROM app.auth_consume_recovery_approval_limits($1,$2)", [sessionId, recoveryRequestId])).rows[0].allowed).toBe(attempt <= 8);
    }
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const ipKey = randomUUID().replaceAll("-", "");
      expect((await pool.query("SELECT * FROM app.auth_consume_rate_limit('password-reset-escalation-ip-day',$1,5,86400)", [ipKey])).rows[0].allowed).toBe(true);
      expect((await pool.query("SELECT * FROM app.auth_consume_password_reset_escalation_limits($1)", [resetHash])).rows[0].allowed).toBe(attempt <= 3);
    }

    const concurrentUserId = randomUUID();
    const concurrentResetHash = randomUUID().replaceAll("-", "").repeat(2);
    await pool.query(
      "INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,email_verified_at) VALUES($1,$2,'concurrent-rate-email','password-hash',now())",
      [concurrentUserId, randomUUID().replaceAll("-", "")],
    );
    await pool.query(
      "INSERT INTO auth_one_time_tokens(token_hash,purpose,user_id,expires_at,recovery_policy) VALUES($1,'PASSWORD_RESET',$2,now()+interval '1 hour','EMAIL_ONLY')",
      [concurrentResetHash, concurrentUserId],
    );
    const concurrentDecisions = await Promise.all(Array.from({ length: 20 }, async () => (
      await pool.query("SELECT * FROM app.auth_consume_password_reset_limits($1)", [concurrentResetHash])
    ).rows[0].allowed as boolean));
    expect(concurrentDecisions.filter(Boolean)).toHaveLength(8);
  });

  it("claims queued authentication email without granting direct table access", async () => {
    const userId = randomUUID();
    const outboxId = randomUUID();
    const workerId = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,email_verified_at) VALUES($1,$2,'claim-test-email','password-hash',now())",
      [userId, randomUUID().replaceAll("-", "")],
    );
    await pool.query(
      `INSERT INTO auth_email_outbox(
         id,user_id,template_type,payload_ciphertext,status,attempts,available_at,request_id,created_at
       ) VALUES ($1,$2,'SECURITY_NEW_LOGIN','claim-test-payload','PENDING',0,now(),$3,'-infinity')`,
      [outboxId, userId, randomUUID()],
    );
    const claimed = await pool.query("SELECT * FROM app.auth_claim_email_delivery($1)", [workerId]);
    expect(claimed.rows[0]?.outbox_id).toBe(outboxId);
    expect((await pool.query("SELECT app.auth_complete_email_delivery($1,$2,'provider-message') AS completed", [claimed.rows[0].outbox_id, workerId])).rows[0].completed).toBe(true);
  });

  it("reclaims a crashed final delivery attempt with the stable outbox id", async () => {
    const outboxId = randomUUID();
    const firstWorker = randomUUID();
    const recoveryWorker = randomUUID();
    await pool.query(
      `INSERT INTO auth_email_outbox(
         id,user_id,organization_id,template_type,status,attempts,available_at,request_id,created_at
       ) VALUES (
         $1,'10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',
         'SECURITY_NEW_LOGIN','PENDING',7,now(),$2,now()-interval '1 day'
       )`,
      [outboxId, randomUUID()],
    );
    const finalAttempt = await pool.query("SELECT * FROM app.auth_claim_email_delivery($1)", [firstWorker]);
    expect(finalAttempt.rows[0]).toMatchObject({ outbox_id: outboxId, attempt: 8 });
    await pool.query(
      "UPDATE auth_email_outbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [outboxId],
    );
    const recovered = await pool.query("SELECT * FROM app.auth_claim_email_delivery($1)", [recoveryWorker]);
    expect(recovered.rows[0]).toMatchObject({ outbox_id: outboxId, attempt: 8 });
    expect((await pool.query(
      "SELECT app.auth_complete_email_delivery($1,$2,'same-idempotent-provider-message') AS completed",
      [outboxId, recoveryWorker],
    )).rows[0].completed).toBe(true);
  });
});

runRuntimeRoleTests("PostgreSQL runtime authentication boundary", () => {
  const runtimePool = new Pool({ connectionString: appDatabaseUrl });

  afterAll(async () => runtimePool.end());

  it("executes approved auth functions without direct auth-table access", async () => {
    const tokenHash = randomUUID().replaceAll("-", "").repeat(2);
    const issued = await runtimePool.query(
      "SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
      [tokenHash, null, randomUUID().replaceAll("-", "").repeat(2), "f".repeat(64), "a".repeat(64), randomUUID()],
    );
    expect(issued.rows[0]?.session_id).toBeTruthy();
    await expect(runtimePool.query("SELECT token_hash FROM auth_sessions LIMIT 1")).rejects.toThrow(/permission denied/);
    await expect(runtimePool.query("SELECT secret_ciphertext FROM auth_mfa_factors LIMIT 1")).rejects.toThrow(/permission denied/);
    await expect(runtimePool.query("SELECT payload_ciphertext FROM auth_email_outbox LIMIT 1")).rejects.toThrow(/permission denied/);
    await expect(runtimePool.query(
      "SELECT app.auth_issue_user_session($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), randomUUID(), randomUUID(), "x".repeat(64), "i".repeat(64), "u".repeat(64), randomUUID()],
    )).rejects.toThrow(/permission denied/);
    await expect(runtimePool.query("SELECT * FROM app.auth_claim_email_delivery($1)", [randomUUID()])).rejects.toThrow(/permission denied/);
    expect((await runtimePool.query(
      "SELECT app.auth_prepare_recovery_mfa($1,$2,$3,$4) AS prepared",
      ["x".repeat(64), randomUUID(), "authv1:" + "x".repeat(64), randomUUID()],
    )).rows[0].prepared).toBe(false);
    await expect(runtimePool.query("SELECT * FROM app.auth_consume_mfa_step_up_limits($1)", [issued.rows[0].session_id])).resolves.toBeTruthy();
    await expect(runtimePool.query("SELECT * FROM app.auth_consume_password_reset_limits($1)", ["p".repeat(64)])).resolves.toBeTruthy();
    await expect(runtimePool.query("SELECT * FROM app.auth_consume_password_reset_escalation_limits($1)", ["e".repeat(64)])).resolves.toBeTruthy();
    await expect(runtimePool.query("SELECT * FROM app.auth_consume_recovery_approval_limits($1,$2)", [issued.rows[0].session_id, randomUUID()])).resolves.toBeTruthy();
    await expect(runtimePool.query("SELECT * FROM app.auth_consume_mfa_enrollment_limits($1)", ["m".repeat(64)])).resolves.toBeTruthy();
    const resolved = await runtimePool.query("SELECT * FROM app.auth_resolve_session_v2($1, $2)", [tokenHash, "a".repeat(64)]);
    expect(resolved.rows[0]).toMatchObject({ session_mode: "DEMO" });
    await runtimePool.query("SELECT app.auth_revoke_session($1, $2)", [tokenHash, randomUUID()]);
    await expect(runtimePool.query("SELECT * FROM app.auth_email_delivery_readiness(15)")).resolves.toBeTruthy();
    await expect(runtimePool.query("SELECT app.auth_email_worker_heartbeat($1)", [randomUUID()])).rejects.toThrow(/permission denied/);
    await expect(runtimePool.query("SELECT worker_id FROM auth_email_worker_status LIMIT 1")).rejects.toThrow(/permission denied/);
  });
});

runWorkerRoleTests("PostgreSQL authentication email-worker boundary", () => {
  const workerPool = new Pool({ connectionString: authWorkerDatabaseUrl });
  const adminPool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => Promise.all([workerPool.end(), adminPool.end()]));

  it("can lease delivery work but cannot read auth tables or issue sessions", async () => {
    const workerId = randomUUID();
    await expect(workerPool.query("SELECT app.auth_email_worker_heartbeat($1)", [workerId])).resolves.toBeTruthy();
    for (let index = 0; index < 20; index += 1) {
      await workerPool.query("SELECT app.auth_email_worker_heartbeat($1)", [randomUUID()]);
    }
    await expect(workerPool.query("SELECT * FROM app.auth_claim_email_delivery($1)", [randomUUID()])).resolves.toBeTruthy();
    await expect(workerPool.query("SELECT payload_ciphertext FROM public.auth_email_outbox LIMIT 1")).rejects.toThrow(/permission denied/);
    await expect(workerPool.query("SELECT last_heartbeat_at FROM public.auth_email_worker_status LIMIT 1")).rejects.toThrow(/permission denied/);
    await expect(workerPool.query("SELECT * FROM app.auth_email_delivery_readiness(15)")).rejects.toThrow(/permission denied/);
    await expect(workerPool.query(
      "SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
      ["x".repeat(64), null, "c".repeat(64), "i".repeat(64), "u".repeat(64), randomUUID()],
    )).rejects.toThrow(/permission denied/);
    await expect(workerPool.query("SELECT * FROM app.auth_consume_password_reset_limits($1)", ["x".repeat(64)])).rejects.toThrow(/permission denied/);
    expect((await adminPool.query("SELECT count(*)::text AS count FROM auth_email_worker_status")).rows[0]?.count).toBe("1");
  });
});
