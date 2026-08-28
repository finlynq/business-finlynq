import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;
const runRuntimeRoleTests = databaseUrl && appDatabaseUrl ? describe : describe.skip;

type SignupFixture = Readonly<{
  signupId: string;
  userId: string;
  organizationId: string;
  tokenId: string;
  outboxId: string;
  tokenHash: string;
  slug: string;
}>;

function signupFixture(): SignupFixture {
  const organizationId = randomUUID();
  return {
    signupId: randomUUID(),
    userId: randomUUID(),
    organizationId,
    tokenId: randomUUID(),
    outboxId: randomUUID(),
    tokenHash: randomUUID().replaceAll("-", "").repeat(2),
    slug: `signup-${organizationId.replaceAll("-", "").slice(0, 20)}`,
  };
}

const wrappedDek = JSON.stringify({
  format: "business-finlynq-wrapped-key-v1",
  provider: "test-provider",
  keyVersion: 1,
  iv: "a".repeat(16),
  ciphertext: "b".repeat(44),
  authTag: "c".repeat(24),
});

async function beginSignup(pool: Pool, fixture: SignupFixture, overrides: Readonly<{
  emailHash?: string;
  slug?: string;
  country?: "CA" | "US";
  region?: string;
  postingMode?: "AUTO_POST" | "REVIEW_REQUIRED";
}> = {}) {
  const country = overrides.country ?? "CA";
  return pool.query(
    `SELECT app.auth_begin_organization_signup(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
       $18,$19,$20,$21,$22,$23,$24,$25
     ) AS queued`,
    [
      fixture.signupId,
      fixture.userId,
      fixture.organizationId,
      fixture.tokenId,
      overrides.emailHash ?? randomUUID().replaceAll("-", "").repeat(2),
      `idv1:${"e".repeat(80)}`,
      `idv1:${"n".repeat(80)}`,
      overrides.slug ?? fixture.slug,
      "Integration Test Books",
      country === "CA" ? "CA01" : "US01",
      "Integration Test Books Inc.",
      country,
      overrides.region ?? (country === "CA" ? "ON" : "WA"),
      country === "CA" ? "CAD" : "USD",
      country === "CA" ? "CAN_ASPE" : "US_GAAP_NONPUBLIC",
      2026,
      overrides.postingMode ?? "AUTO_POST",
      "test-provider",
      wrappedDek,
      fixture.tokenHash,
      `authv1:${"p".repeat(80)}`,
      fixture.outboxId,
      "i".repeat(64),
      randomUUID(),
      "2026-08-27",
    ],
  );
}

async function addPasswordOnlyViewer(pool: Pool, fixture: SignupFixture) {
  const userId = randomUUID();
  const membershipId = randomUUID();
  const emailHash = randomUUID().replaceAll("-", "").repeat(2);
  const passwordHash = `scrypt-v1$32768$8$1$${"v".repeat(24)}$${"w".repeat(88)}`;
  const role = await pool.query<{ id: string }>(
    "SELECT id FROM roles WHERE organization_id=$1 AND key='VIEWER_AUDITOR'",
    [fixture.organizationId],
  );
  await pool.query(
    `INSERT INTO users(
       id,email_lookup_hash,email_ciphertext,display_name_ciphertext,
       password_hash,active,is_demo,mfa_required,email_verified_at
     ) VALUES($1,$2,$3,$4,$5,true,false,false,now())`,
    [userId, emailHash, `idv1:${"e".repeat(80)}`, `idv1:${"n".repeat(80)}`, passwordHash],
  );
  await pool.query(
    `INSERT INTO organization_memberships(id,organization_id,user_id,active)
     VALUES($1,$2,$3,true)`,
    [membershipId, fixture.organizationId, userId],
  );
  await pool.query(
    `INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by)
     VALUES($1,$2,$3,$4)`,
    [fixture.organizationId, membershipId, role.rows[0]!.id, fixture.userId],
  );
  const sessionTokenHash = randomUUID().replaceAll("-", "").repeat(2);
  const sessionId = (await pool.query(
    "SELECT app.auth_issue_password_user_session($1,$2,$3,$4,$5,$6,$7) AS session_id",
    [userId, fixture.organizationId, membershipId, sessionTokenHash,
      "i".repeat(64), "u".repeat(64), randomUUID()],
  )).rows[0]?.session_id as string | undefined;
  expect(sessionId).toBeTruthy();
  return { userId, membershipId, emailHash, passwordHash, sessionId: sessionId!, sessionTokenHash };
}

runDatabaseTests("PostgreSQL self-service owner signup", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => pool.end());

  it("provisions no business before email verification, then creates one complete inactive-owner foundation", async () => {
    const fixture = signupFixture();
    const emailHash = randomUUID().replaceAll("-", "").repeat(2);
    const begin = await beginSignup(pool, fixture, { emailHash });
    expect(begin.rows[0]?.queued).toBe(true);
    expect((await pool.query("SELECT active,email_verified_at FROM users WHERE id=$1", [fixture.userId])).rows[0])
      .toMatchObject({ active: false, email_verified_at: null });
    expect((await pool.query("SELECT count(*)::int AS count FROM organizations WHERE id=$1", [fixture.organizationId])).rows[0]?.count).toBe(0);
    expect((await pool.query("SELECT status,template_type FROM auth_email_outbox WHERE id=$1", [fixture.outboxId])).rows[0])
      .toMatchObject({ status: "PENDING", template_type: "ORGANIZATION_SIGNUP" });

    const factorId = randomUUID();
    const setupHash = randomUUID().replaceAll("-", "").repeat(2);
    const passwordHash = `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`;
    const accepted = await pool.query(
      "SELECT * FROM app.auth_accept_organization_signup($1,$2,$3,$4,$5,$6)",
      [fixture.tokenHash, passwordHash, factorId, `authv1:${"f".repeat(80)}`, setupHash, randomUUID()],
    );
    expect(accepted.rows[0]).toMatchObject({
      user_id: fixture.userId,
      organization_name: "Integration Test Books",
      factor_id: factorId,
    });

    const foundation = await pool.query(
      `SELECT
        (SELECT organization_mode FROM organizations WHERE id=$1) AS mode,
        (SELECT count(*)::int FROM organization_key_versions WHERE organization_id=$1 AND active) AS keys,
        (SELECT count(*)::int FROM roles WHERE organization_id=$1) AS roles,
        (SELECT count(*)::int FROM legal_entities WHERE organization_id=$1) AS entities,
        (SELECT count(*)::int FROM ledgers WHERE organization_id=$1) AS ledgers,
        (SELECT count(*)::int FROM fiscal_periods WHERE organization_id=$1) AS periods,
        (SELECT count(*)::int FROM gl_accounts WHERE organization_id=$1) AS accounts,
        (SELECT count(*)::int FROM account_combinations WHERE organization_id=$1) AS combinations,
        (SELECT count(*)::int FROM segment_definitions WHERE organization_id=$1) AS segments,
        (SELECT manual_mode::text FROM ledger_posting_policies WHERE organization_id=$1) AS posting_mode,
        (SELECT active FROM organization_memberships WHERE organization_id=$1 AND user_id=$2) AS membership_active,
        (SELECT status FROM auth_organization_signups WHERE id=$3) AS signup_status`,
      [fixture.organizationId, fixture.userId, fixture.signupId],
    );
    expect(foundation.rows[0]).toEqual({
      mode: "REAL",
      keys: 1,
      roles: 6,
      entities: 1,
      ledgers: 1,
      periods: 12,
      accounts: 13,
      combinations: 13,
      segments: 10,
      posting_mode: "AUTO_POST",
      membership_active: false,
      signup_status: "ENROLLING",
    });
    const userBeforeMfa = (await pool.query(
      "SELECT active,email_verified_at IS NOT NULL AS verified FROM users WHERE id=$1",
      [fixture.userId],
    )).rows[0];
    expect(userBeforeMfa).toEqual({ active: false, verified: true });
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_organization_signup($1,$2,$3,$4,$5,$6)",
      [fixture.tokenHash, passwordHash, randomUUID(), `authv1:${"r".repeat(80)}`, "z".repeat(64), randomUUID()],
    )).rowCount).toBe(0);

    expect((await pool.query(
      "SELECT app.auth_finish_mfa_enrollment($1,$2,1,$3) AS finished",
      [setupHash, factorId, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query(
      `SELECT selected_user.active AS user_active, membership.active AS membership_active,
        signup.status AS signup_status, signup.completed_at IS NOT NULL AS completed
       FROM users selected_user
       JOIN organization_memberships membership ON membership.user_id=selected_user.id
       JOIN auth_organization_signups signup ON signup.user_id=selected_user.id
       WHERE selected_user.id=$1`,
      [fixture.userId],
    )).rows[0]).toEqual({
      user_active: true,
      membership_active: true,
      signup_status: "ACTIVE",
      completed: true,
    });

    const repeated = signupFixture();
    const retry = await beginSignup(pool, { ...repeated, userId: fixture.userId }, { emailHash });
    expect(retry.rows[0]?.queued).toBe(false);
  });

  it("activates password-only signup, issues a non-step-up session, and supports later MFA enrollment", async () => {
    const fixture = signupFixture();
    const emailHash = randomUUID().replaceAll("-", "").repeat(2);
    expect((await beginSignup(pool, fixture, { emailHash })).rows[0]?.queued).toBe(true);
    const factorId = randomUUID();
    const setupHash = randomUUID().replaceAll("-", "").repeat(2);
    const passwordHash = `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`;
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_organization_signup($1,$2,$3,$4,$5,$6)",
      [fixture.tokenHash, passwordHash, factorId, `authv1:${"f".repeat(80)}`, setupHash, randomUUID()],
    )).rows[0]).toMatchObject({ user_id: fixture.userId, factor_id: factorId });

    expect((await pool.query(
      "SELECT app.auth_skip_mfa_enrollment($1,$2) AS skipped",
      [setupHash, randomUUID()],
    )).rows[0]?.skipped).toBe(true);
    expect((await pool.query(
      "SELECT app.auth_skip_mfa_enrollment($1,$2) AS skipped",
      [setupHash, randomUUID()],
    )).rows[0]?.skipped).toBe(false);
    const activated = (await pool.query(
      `SELECT selected_user.active, selected_user.mfa_required,
        membership.id AS membership_id, membership.active AS membership_active,
        signup.status AS signup_status, factor.status AS factor_status
       FROM users selected_user
       JOIN organization_memberships membership ON membership.user_id=selected_user.id
       JOIN auth_organization_signups signup ON signup.user_id=selected_user.id
       JOIN auth_mfa_factors factor ON factor.id=$2
       WHERE selected_user.id=$1`,
      [fixture.userId, factorId],
    )).rows[0];
    expect(activated).toMatchObject({
      active: true,
      mfa_required: false,
      membership_active: true,
      signup_status: "ACTIVE",
      factor_status: "REVOKED",
    });

    const passwordSessionHash = randomUUID().replaceAll("-", "").repeat(2);
    const issuedPasswordSession = (await pool.query(
      "SELECT app.auth_issue_password_user_session($1,$2,$3,$4,$5,$6,$7) AS session_id",
      [fixture.userId, fixture.organizationId, activated.membership_id,
        passwordSessionHash, "i".repeat(64), "u".repeat(64), randomUUID()],
    )).rows[0]?.session_id;
    expect(issuedPasswordSession).toBeTruthy();
    expect((await pool.query(
      "SELECT mfa_verified_at,step_up_expires_at FROM auth_sessions WHERE id=$1",
      [issuedPasswordSession],
    )).rows[0]).toEqual({ mfa_verified_at: null, step_up_expires_at: null });
    expect((await pool.query(
      "SELECT * FROM app.auth_password_for_session($1)",
      [issuedPasswordSession],
    )).rows[0]).toMatchObject({ user_id: fixture.userId, password_hash: passwordHash });
    expect((await pool.query(
      "SELECT app.auth_record_session_reauthentication_failure($1,$2) AS recorded",
      [issuedPasswordSession, randomUUID()],
    )).rows[0]?.recorded).toBe(true);
    expect((await pool.query(
      "SELECT * FROM app.auth_mfa_status_for_session($1)",
      [issuedPasswordSession],
    )).rows[0]).toEqual({
      mfa_required: false,
      active_factor: false,
      pending_enrollment: false,
    });

    const secondPasswordSessionHash = randomUUID().replaceAll("-", "").repeat(2);
    const secondPasswordSession = (await pool.query(
      "SELECT app.auth_issue_password_user_session($1,$2,$3,$4,$5,$6,$7) AS session_id",
      [fixture.userId, fixture.organizationId, activated.membership_id,
        secondPasswordSessionHash, "i".repeat(64), "v".repeat(64), randomUUID()],
    )).rows[0]?.session_id;
    expect(secondPasswordSession).toBeTruthy();

    const staleResetHash = randomUUID().replaceAll("-", "").repeat(2);
    await pool.query(
      "SELECT app.auth_queue_password_reset($1,$2,$3,$4,$5,$6)",
      [emailHash, staleResetHash, `authv1:${"r".repeat(80)}`, randomUUID(), "i".repeat(64), randomUUID()],
    );
    const staleReset = (await pool.query(
      `SELECT token.id,token.recovery_policy,recovery.status
       FROM auth_one_time_tokens token
       LEFT JOIN auth_recovery_requests recovery ON recovery.token_id=token.id
       WHERE token.token_hash=$1`,
      [staleResetHash],
    )).rows[0];
    expect(staleReset).toMatchObject({ recovery_policy: "DELAYED", status: "PENDING" });

    const enrolledFactorId = randomUUID();
    const laterSetupHash = randomUUID().replaceAll("-", "").repeat(2);
    const rotatedPasswordSessionHash = randomUUID().replaceAll("-", "").repeat(2);
    expect((await pool.query(
      "SELECT app.auth_begin_session_mfa_enrollment($1,$2,$3,$4,$5) AS started",
      [issuedPasswordSession, enrolledFactorId, `authv1:${"n".repeat(80)}`,
        laterSetupHash, randomUUID()],
    )).rows[0]?.started).toBe(true);
    expect((await pool.query(
      "SELECT * FROM app.auth_mfa_setup_challenge($1)",
      [laterSetupHash],
    )).rows[0]).toMatchObject({
      user_id: fixture.userId,
      organization_id: fixture.organizationId,
      factor_id: enrolledFactorId,
    });
    expect((await pool.query(
      "SELECT * FROM app.auth_mfa_status_for_session($1)",
      [issuedPasswordSession],
    )).rows[0]?.pending_enrollment).toBe(true);
    expect((await pool.query(
      "SELECT app.auth_finish_session_mfa_enrollment($1,$2,$3,50,$4,$5) AS finished",
      [issuedPasswordSession, laterSetupHash, enrolledFactorId,
        rotatedPasswordSessionHash, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query(
      "SELECT app.auth_finish_session_mfa_enrollment($1,$2,$3,50,$4,$5) AS finished",
      [issuedPasswordSession, laterSetupHash, enrolledFactorId,
        randomUUID().replaceAll("-", "").repeat(2), randomUUID()],
    )).rows[0]?.finished).toBe(false);
    expect((await pool.query(
      "SELECT mfa_required FROM users WHERE id=$1",
      [fixture.userId],
    )).rows[0]?.mfa_required).toBe(true);
    expect((await pool.query(
      `SELECT token_hash=$2 AS token_rotated,
        mfa_verified_at IS NOT NULL AS verified,
        step_up_expires_at > now() AS stepped_up
       FROM auth_sessions WHERE id=$1`,
      [issuedPasswordSession, rotatedPasswordSessionHash],
    )).rows[0]).toEqual({ token_rotated: true, verified: true, stepped_up: true });
    expect((await pool.query(
      "SELECT * FROM app.auth_resolve_session_v2($1,$2)",
      [passwordSessionHash, "u".repeat(64)],
    )).rowCount).toBe(0);
    expect((await pool.query(
      "SELECT session_id,mfa_verified_at IS NOT NULL AS verified,step_up_expires_at > now() AS stepped_up FROM app.auth_resolve_session_v2($1,$2)",
      [rotatedPasswordSessionHash, "u".repeat(64)],
    )).rows[0]).toEqual({
      session_id: issuedPasswordSession,
      verified: true,
      stepped_up: true,
    });
    expect((await pool.query(
      `SELECT token.consumed_at IS NOT NULL AS token_consumed,
        recovery.status AS recovery_status
       FROM auth_one_time_tokens token
       JOIN auth_recovery_requests recovery ON recovery.token_id=token.id
       WHERE token.id=$1`,
      [staleReset.id],
    )).rows[0]).toEqual({ token_consumed: true, recovery_status: "DENIED" });
    expect((await pool.query(
      "SELECT * FROM app.auth_password_reset_challenge($1)",
      [staleResetHash],
    )).rowCount).toBe(0);
    expect((await pool.query(
      "SELECT mfa_verified_at IS NOT NULL AS verified,step_up_expires_at > now() AS stepped_up FROM auth_sessions WHERE id=$1",
      [issuedPasswordSession],
    )).rows[0]).toEqual({ verified: true, stepped_up: true });
    expect((await pool.query(
      "SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE id=$1",
      [secondPasswordSession],
    )).rows[0]?.revoked).toBe(true);
    expect((await pool.query(
      "SELECT * FROM app.auth_mfa_status_for_session($1)",
      [issuedPasswordSession],
    )).rows[0]).toEqual({
      mfa_required: true,
      active_factor: true,
      pending_enrollment: false,
    });

    expect((await pool.query(
      "SELECT app.auth_issue_password_user_session($1,$2,$3,$4,$5,$6,$7) AS session_id",
      [fixture.userId, fixture.organizationId, activated.membership_id,
        randomUUID().replaceAll("-", "").repeat(2), "i".repeat(64), "u".repeat(64), randomUUID()],
    )).rows[0]?.session_id).toBeNull();
    const mfaSessionHash = randomUUID().replaceAll("-", "").repeat(2);
    const mfaSessionId = (await pool.query(
      "SELECT app.auth_issue_mfa_user_session($1,$2,$3,$4,51,$5,$6,$7,$8) AS session_id",
      [fixture.userId, fixture.organizationId, activated.membership_id,
        enrolledFactorId, mfaSessionHash, "i".repeat(64), "u".repeat(64), randomUUID()],
    )).rows[0]?.session_id;
    expect(mfaSessionId).toBeTruthy();
    expect((await pool.query(
      "SELECT app.auth_mark_step_up($1,$2,52,$3) AS marked",
      [mfaSessionId, enrolledFactorId, randomUUID()],
    )).rows[0]?.marked).toBe(true);
    expect((await pool.query(
      "SELECT app.auth_mark_step_up($1,$2,52,$3) AS marked",
      [mfaSessionId, enrolledFactorId, randomUUID()],
    )).rows[0]?.marked).toBe(false);
  });

  it("invalidates factorless reset authority on MFA upgrade and restores MFA-required recovery login", async () => {
    const fixture = signupFixture();
    expect((await beginSignup(pool, fixture)).rows[0]?.queued).toBe(true);
    const initialFactorId = randomUUID();
    const initialSetupHash = randomUUID().replaceAll("-", "").repeat(2);
    const ownerPasswordHash = `scrypt-v1$32768$8$1$${"o".repeat(24)}$${"p".repeat(88)}`;
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_organization_signup($1,$2,$3,$4,$5,$6)",
      [fixture.tokenHash, ownerPasswordHash, initialFactorId,
        `authv1:${"f".repeat(80)}`, initialSetupHash, randomUUID()],
    )).rowCount).toBe(1);
    expect((await pool.query(
      "SELECT app.auth_skip_mfa_enrollment($1,$2) AS skipped",
      [initialSetupHash, randomUUID()],
    )).rows[0]?.skipped).toBe(true);

    const upgradingViewer = await addPasswordOnlyViewer(pool, fixture);
    const staleResetHash = randomUUID().replaceAll("-", "").repeat(2);
    await pool.query(
      "SELECT app.auth_queue_password_reset($1,$2,$3,$4,$5,$6)",
      [upgradingViewer.emailHash, staleResetHash, `authv1:${"r".repeat(80)}`,
        randomUUID(), "i".repeat(64), randomUUID()],
    );
    expect((await pool.query(
      "SELECT recovery_policy FROM auth_one_time_tokens WHERE token_hash=$1",
      [staleResetHash],
    )).rows[0]?.recovery_policy).toBe("EMAIL_ONLY");
    const staleRecoveryFactorId = randomUUID();
    expect((await pool.query(
      "SELECT app.auth_prepare_recovery_mfa($1,$2,$3,$4) AS prepared",
      [staleResetHash, staleRecoveryFactorId, `authv1:${"r".repeat(80)}`, randomUUID()],
    )).rows[0]?.prepared).toBe(true);

    const enrolledFactorId = randomUUID();
    const sessionSetupHash = randomUUID().replaceAll("-", "").repeat(2);
    expect((await pool.query(
      "SELECT app.auth_begin_session_mfa_enrollment($1,$2,$3,$4,$5) AS started",
      [upgradingViewer.sessionId, enrolledFactorId, `authv1:${"m".repeat(80)}`,
        sessionSetupHash, randomUUID()],
    )).rows[0]?.started).toBe(true);
    const rotatedTokenHash = randomUUID().replaceAll("-", "").repeat(2);
    expect((await pool.query(
      "SELECT app.auth_finish_session_mfa_enrollment($1,$2,$3,60,$4,$5) AS finished",
      [upgradingViewer.sessionId, sessionSetupHash, enrolledFactorId,
        rotatedTokenHash, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query(
      `SELECT token.consumed_at IS NOT NULL AS reset_consumed,
        factor.status AS stale_factor_status
       FROM auth_one_time_tokens token
       JOIN auth_mfa_factors factor ON factor.id=$2
       WHERE token.token_hash=$1`,
      [staleResetHash, staleRecoveryFactorId],
    )).rows[0]).toEqual({ reset_consumed: true, stale_factor_status: "REVOKED" });
    expect((await pool.query(
      "SELECT * FROM app.auth_password_reset_challenge($1)",
      [staleResetHash],
    )).rowCount).toBe(0);
    expect((await pool.query(
      "SELECT app.auth_finish_password_reset_with_mfa($1,$2,$3,61,$4) AS finished",
      [staleResetHash, upgradingViewer.passwordHash, staleRecoveryFactorId, randomUUID()],
    )).rows[0]?.finished).toBe(false);

    const recoveringViewer = await addPasswordOnlyViewer(pool, fixture);
    const recoveryResetHash = randomUUID().replaceAll("-", "").repeat(2);
    await pool.query(
      "SELECT app.auth_queue_password_reset($1,$2,$3,$4,$5,$6)",
      [recoveringViewer.emailHash, recoveryResetHash, `authv1:${"q".repeat(80)}`,
        randomUUID(), "i".repeat(64), randomUUID()],
    );
    const recoveryFactorId = randomUUID();
    expect((await pool.query(
      "SELECT app.auth_prepare_recovery_mfa($1,$2,$3,$4) AS prepared",
      [recoveryResetHash, recoveryFactorId, `authv1:${"z".repeat(80)}`, randomUUID()],
    )).rows[0]?.prepared).toBe(true);
    const replacementPasswordHash = `scrypt-v1$32768$8$1$${"x".repeat(24)}$${"y".repeat(88)}`;
    expect((await pool.query(
      "SELECT app.auth_finish_password_reset_with_mfa($1,$2,$3,70,$4) AS finished",
      [recoveryResetHash, replacementPasswordHash, recoveryFactorId, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query(
      `SELECT selected_user.mfa_required,selected_user.password_hash,
        factor.status AS factor_status,
        session.revoked_at IS NOT NULL AS old_session_revoked
       FROM users selected_user
       JOIN auth_mfa_factors factor ON factor.id=$2
       JOIN auth_sessions session ON session.id=$3
       WHERE selected_user.id=$1`,
      [recoveringViewer.userId, recoveryFactorId, recoveringViewer.sessionId],
    )).rows[0]).toEqual({
      mfa_required: true,
      password_hash: replacementPasswordHash,
      factor_status: "ACTIVE",
      old_session_revoked: true,
    });
    expect((await pool.query(
      "SELECT app.auth_issue_password_user_session($1,$2,$3,$4,$5,$6,$7) AS session_id",
      [recoveringViewer.userId, fixture.organizationId, recoveringViewer.membershipId,
        randomUUID().replaceAll("-", "").repeat(2), "i".repeat(64),
        "u".repeat(64), randomUUID()],
    )).rows[0]?.session_id).toBeNull();
    const recoveredMfaSession = (await pool.query(
      "SELECT app.auth_issue_mfa_user_session($1,$2,$3,$4,71,$5,$6,$7,$8) AS session_id",
      [recoveringViewer.userId, fixture.organizationId, recoveringViewer.membershipId,
        recoveryFactorId, randomUUID().replaceAll("-", "").repeat(2),
        "i".repeat(64), "u".repeat(64), randomUUID()],
    )).rows[0]?.session_id;
    expect(recoveredMfaSession).toBeTruthy();
    expect((await pool.query(
      "SELECT app.auth_mark_step_up($1,$2,72,$3) AS marked",
      [recoveredMfaSession, recoveryFactorId, randomUUID()],
    )).rows[0]?.marked).toBe(true);
  });

  it("rolls back the entire foundation when a final organization constraint fails", async () => {
    const fixture = signupFixture();
    await pool.query(
      "INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode) VALUES($1,$2,'Existing',true,false,'REAL')",
      [randomUUID(), fixture.slug],
    );
    expect((await beginSignup(pool, fixture)).rows[0]?.queued).toBe(true);
    const passwordHash = `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`;
    await expect(pool.query(
      "SELECT * FROM app.auth_accept_organization_signup($1,$2,$3,$4,$5,$6)",
      [fixture.tokenHash, passwordHash, randomUUID(), `authv1:${"f".repeat(80)}`, "s".repeat(64), randomUUID()],
    )).rejects.toThrow(/duplicate key/);
    expect((await pool.query("SELECT count(*)::int AS count FROM organizations WHERE id=$1", [fixture.organizationId])).rows[0]?.count).toBe(0);
    expect((await pool.query("SELECT consumed_at FROM auth_one_time_tokens WHERE id=$1", [fixture.tokenId])).rows[0]?.consumed_at).toBeNull();
    expect((await pool.query("SELECT status FROM auth_organization_signups WHERE id=$1", [fixture.signupId])).rows[0]?.status).toBe("PENDING");
  });
});
runRuntimeRoleTests("PostgreSQL signup runtime boundary", () => {
  const runtimePool = new Pool({ connectionString: appDatabaseUrl });
  afterAll(async () => runtimePool.end());

  it("exposes only the reviewed signup functions, never pending signup rows", async () => {
    await expect(runtimePool.query(
      "SELECT * FROM app.auth_consume_signup_accept_limits($1)",
      ["x".repeat(64)],
    )).resolves.toBeTruthy();
    await expect(runtimePool.query(
      "SELECT wrapped_dek FROM auth_organization_signups LIMIT 1",
    )).rejects.toThrow(/permission denied/);
    for (const table of ["users", "auth_sessions", "auth_mfa_factors", "auth_one_time_tokens"]) {
      await expect(runtimePool.query(`SELECT * FROM ${table} LIMIT 1`)).rejects.toThrow(/permission denied/);
    }
    await expect(runtimePool.query(
      "SELECT app.auth_skip_mfa_enrollment($1,$2) AS skipped",
      ["x".repeat(64), randomUUID()],
    )).resolves.toBeTruthy();
    await expect(runtimePool.query(
      "SELECT * FROM app.auth_mfa_status_for_session($1)",
      [randomUUID()],
    )).resolves.toBeTruthy();
    await expect(runtimePool.query(
      "SELECT * FROM app.auth_password_for_session($1)",
      [randomUUID()],
    )).resolves.toBeTruthy();
    await expect(runtimePool.query(
      "SELECT app.auth_issue_password_user_session($1,$2,$3,$4,$5,$6,$7) AS session_id",
      [randomUUID(), randomUUID(), randomUUID(), "t".repeat(64), "i".repeat(64), "u".repeat(64), randomUUID()],
    )).resolves.toBeTruthy();
    await expect(runtimePool.query(
      "SELECT app.auth_begin_session_mfa_enrollment($1,$2,$3,$4,$5) AS started",
      [randomUUID(), randomUUID(), `authv1:${"f".repeat(80)}`, "s".repeat(64), randomUUID()],
    )).resolves.toBeTruthy();
    await expect(runtimePool.query(
      "SELECT app.auth_finish_session_mfa_enrollment($1,$2,$3,$4,$5,$6) AS finished",
      [randomUUID(), "s".repeat(64), randomUUID(), 1, "t".repeat(64), randomUUID()],
    )).resolves.toBeTruthy();
    await expect(runtimePool.query(
      "SELECT app.auth_record_session_reauthentication_failure($1,$2) AS recorded",
      [randomUUID(), randomUUID()],
    )).resolves.toBeTruthy();
    await expect(runtimePool.query(
      "SELECT app.auth_finish_password_reset_with_mfa($1,$2,$3,$4,$5) AS finished",
      ["r".repeat(64), `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`,
        randomUUID(), 1, randomUUID()],
    )).resolves.toBeTruthy();
  });
});
