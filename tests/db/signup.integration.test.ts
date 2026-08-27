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
      roles: 5,
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
  });
});
