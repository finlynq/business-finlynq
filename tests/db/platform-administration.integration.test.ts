import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;
const authWorkerDatabaseUrl = process.env.TEST_AUTH_WORKER_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;
const runRuntimeRoleTests = databaseUrl && appDatabaseUrl ? describe : describe.skip;
const runAuthWorkerRoleTests = databaseUrl && authWorkerDatabaseUrl ? describe : describe.skip;

runDatabaseTests("PostgreSQL platform administrator assurance", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => pool.end());

  it("links only after verified real MFA enrollment and suspends when assurance is lost", async () => {
    const grantId = randomUUID();
    const userId = randomUUID();
    const organizationId = randomUUID();
    const membershipId = randomUUID();
    const factorId = randomUUID();
    const sessionId = randomUUID();
    const emailHash = randomUUID().replaceAll("-", "").repeat(2);

    await pool.query(
      `INSERT INTO platform_administrator_grants(
         id,email_lookup_hash,email_ciphertext,granted_by,grant_reason,grant_request_id
       ) VALUES($1,$2,$3,'operator:integration-test',
         'Exercise pending identity assurance transitions',$4)`,
      [grantId, emailHash, `idv1:${"e".repeat(80)}`, randomUUID()],
    );
    expect((await pool.query(
      "SELECT linked_user_id FROM platform_administrator_grants WHERE id=$1",
      [grantId],
    )).rows[0]?.linked_user_id).toBeNull();

    await pool.query(
      `INSERT INTO users(
         id,email_lookup_hash,email_ciphertext,password_hash,
         active,is_demo,mfa_required,email_verified_at
       ) VALUES($1,$2,$3,'integration-password',false,false,true,NULL)`,
      [userId, emailHash, `idv1:${"u".repeat(80)}`],
    );
    await pool.query("UPDATE users SET active=true,email_verified_at=now() WHERE id=$1", [userId]);
    expect((await pool.query(
      "SELECT linked_user_id FROM platform_administrator_grants WHERE id=$1",
      [grantId],
    )).rows[0]?.linked_user_id).toBeNull();
    await expect(pool.query(
      `UPDATE platform_administrator_grants SET
         linked_user_id=$2,linked_at=now(),version=version+1,
         updated_at=updated_at+interval '1 second'
       WHERE id=$1`,
      [grantId, userId],
    )).rejects.toThrow(/matching verified real identity with active MFA/);

    await pool.query(
      `INSERT INTO auth_mfa_factors(
         id,user_id,factor_type,label,secret_ciphertext,status,verified_at
       ) VALUES($1,$2,'TOTP','Primary','integration-secret','ACTIVE',now())`,
      [factorId, userId],
    );
    expect((await pool.query(
      "SELECT linked_user_id FROM platform_administrator_grants WHERE id=$1",
      [grantId],
    )).rows[0]?.linked_user_id).toBe(userId);

    await pool.query(
      `INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode)
       VALUES($1,$2,'Platform admin tenant',true,false,'REAL')`,
      [organizationId, `platform-admin-${organizationId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO organization_memberships(id,organization_id,user_id,active)
       VALUES($1,$2,$3,true)`,
      [membershipId, organizationId, userId],
    );
    await pool.query(
      `INSERT INTO auth_sessions(
         id,token_hash,user_id,organization_id,membership_id,auth_method,
         session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at,
         mfa_verified_at,step_up_expires_at
       ) VALUES($1,$2,$3,$4,$5,'PASSWORD','REAL',repeat('u',64),7200,
         now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '10 minutes')`,
      [sessionId, randomUUID().replaceAll("-", "").repeat(2), userId, organizationId, membershipId],
    );
    expect((await pool.query(
      "SELECT * FROM app.auth_platform_administrator_authorization($1,$2)",
      [sessionId, userId],
    )).rows[0]).toMatchObject({ grant_id: grantId, role_key: "PLATFORM_ADMINISTRATOR" });
    const overview = (await pool.query(
      "SELECT * FROM app.platform_administration_overview($1,$2)",
      [sessionId, userId],
    )).rows[0];
    expect(overview).toMatchObject({
      pending_platform_administrator_count: expect.stringMatching(/^\d+$/),
      linked_platform_administrator_count: expect.stringMatching(/^\d+$/),
      active_real_organization_count: expect.stringMatching(/^\d+$/),
      active_real_user_count: expect.stringMatching(/^\d+$/),
      active_real_session_count: expect.stringMatching(/^\d+$/),
    });
    expect(overview).not.toHaveProperty("grant_id");
    expect(overview).not.toHaveProperty("email_ciphertext");

    const assuranceRequestId = randomUUID();
    await pool.query(
      `INSERT INTO auth_security_events(
         user_id,organization_id,event_type,outcome,request_id
       ) VALUES($1,$2,'MFA_ENROLLED','SUCCESS',$3)`,
      [userId, organizationId, assuranceRequestId],
    );
    expect((await pool.query(
      `SELECT request_id,metadata->>'authenticationEventType' AS source_type
       FROM platform_administrator_grant_events
       WHERE grant_id=$1 AND event_type='IDENTITY_ASSURANCE_CONFIRMED'`,
      [grantId],
    )).rows[0]).toEqual({ request_id: assuranceRequestId, source_type: "MFA_ENROLLED" });

    const changedEmailHash = randomUUID().replaceAll("-", "").repeat(2);
    await pool.query("UPDATE users SET email_lookup_hash=$2 WHERE id=$1", [userId, changedEmailHash]);
    expect((await pool.query(
      "SELECT linked_user_id FROM platform_administrator_grants WHERE id=$1",
      [grantId],
    )).rows[0]?.linked_user_id).toBeNull();
    await pool.query("UPDATE users SET email_lookup_hash=$2 WHERE id=$1", [userId, emailHash]);
    expect((await pool.query(
      "SELECT linked_user_id FROM platform_administrator_grants WHERE id=$1",
      [grantId],
    )).rows[0]?.linked_user_id).toBe(userId);

    await pool.query(
      "UPDATE auth_mfa_factors SET revoked_at=now() WHERE id=$1",
      [factorId],
    );
    expect((await pool.query(
      "SELECT linked_user_id FROM platform_administrator_grants WHERE id=$1",
      [grantId],
    )).rows[0]?.linked_user_id).toBeNull();
    expect((await pool.query(
      "SELECT * FROM app.auth_platform_administrator_authorization($1,$2)",
      [sessionId, userId],
    )).rowCount).toBe(0);
    expect((await pool.query(
      "SELECT * FROM app.platform_administration_overview($1,$2)",
      [sessionId, userId],
    )).rowCount).toBe(0);
    await pool.query("UPDATE auth_mfa_factors SET status='REVOKED' WHERE id=$1", [factorId]);
    await pool.query(
      `UPDATE platform_administrator_grants SET
         status='REVOKED',revoked_by='operator:integration-test',
         revocation_reason='Integration test explicit administrator revocation',
         revoked_at=now(),version=version+1,
         updated_at=updated_at+interval '1 second'
       WHERE id=$1`,
      [grantId],
    );
    await expect(pool.query(
      `UPDATE platform_administrator_grants SET
         version=version+1,updated_at=updated_at+interval '1 second'
       WHERE id=$1`,
      [grantId],
    )).rejects.toThrow(/revoked platform administrator grant cannot be changed/);

    const events = await pool.query(
      `SELECT event_type FROM platform_administrator_grant_events
       WHERE grant_id=$1`,
      [grantId],
    );
    expect(events.rows.map((row) => row.event_type).sort()).toEqual([
      "GRANT_CREATED",
      "GRANT_REVOKED",
      "IDENTITY_ASSURANCE_CONFIRMED",
      "IDENTITY_LINKED",
      "IDENTITY_LINKED",
      "IDENTITY_UNLINKED",
      "IDENTITY_UNLINKED",
    ].sort());
    await expect(pool.query(
      "UPDATE platform_administrator_grant_events SET reason='Mutation is prohibited' WHERE grant_id=$1",
      [grantId],
    )).rejects.toThrow(/append-only/);
    await expect(pool.query(
      "DELETE FROM platform_administrator_grants WHERE id=$1",
      [grantId],
    )).rejects.toThrow(/cannot be deleted/);
  });

  it("never links a demo identity even when its row resembles an enrolled account", async () => {
    const grantId = randomUUID();
    const userId = randomUUID();
    const emailHash = randomUUID().replaceAll("-", "").repeat(2);
    await pool.query(
      `INSERT INTO platform_administrator_grants(
         id,email_lookup_hash,email_ciphertext,granted_by,grant_reason,grant_request_id
       ) VALUES($1,$2,$3,'operator:integration-test',
         'Prove demo identities cannot receive platform access',$4)`,
      [grantId, emailHash, `idv1:${"d".repeat(80)}`, randomUUID()],
    );
    await pool.query(
      `INSERT INTO users(
         id,email_lookup_hash,email_ciphertext,password_hash,
         active,is_demo,mfa_required,email_verified_at
       ) VALUES($1,$2,$3,'demo-password',true,true,true,now())`,
      [userId, emailHash, `idv1:${"x".repeat(80)}`],
    );
    await pool.query(
      `INSERT INTO auth_mfa_factors(
         id,user_id,factor_type,label,secret_ciphertext,status,verified_at
       ) VALUES($1,$2,'TOTP','Synthetic','demo-secret','ACTIVE',now())`,
      [randomUUID(), userId],
    );
    expect((await pool.query(
      "SELECT linked_user_id FROM platform_administrator_grants WHERE id=$1",
      [grantId],
    )).rows[0]?.linked_user_id).toBeNull();
  });
});

runRuntimeRoleTests("PostgreSQL platform administrator runtime boundary", () => {
  const runtimePool = new Pool({ connectionString: appDatabaseUrl });
  afterAll(async () => runtimePool.end());

  it("exposes assurance-only authorization without direct grant or audit access", async () => {
    await expect(runtimePool.query(
      "SELECT id FROM public.platform_administrator_grants LIMIT 1",
    )).rejects.toThrow(/permission denied/);
    await expect(runtimePool.query(
      "SELECT event_type FROM public.platform_administrator_grant_events LIMIT 1",
    )).rejects.toThrow(/permission denied/);
    await expect(runtimePool.query(
      "SELECT * FROM app.auth_platform_administrator_authorization($1,$2)",
      [randomUUID(), randomUUID()],
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(runtimePool.query(
      "SELECT * FROM app.platform_administration_overview($1,$2)",
      [randomUUID(), randomUUID()],
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(runtimePool.query(
      "SELECT app.sync_platform_administrator_grant_for_identity($1)",
      [randomUUID()],
    )).rejects.toThrow(/permission denied/);
  });
});

runAuthWorkerRoleTests("PostgreSQL platform administrator auth-worker boundary", () => {
  const workerPool = new Pool({ connectionString: authWorkerDatabaseUrl });
  afterAll(async () => workerPool.end());

  it("cannot read grants, audit history, or authorization results", async () => {
    await expect(workerPool.query(
      "SELECT id FROM public.platform_administrator_grants LIMIT 1",
    )).rejects.toThrow(/permission denied/);
    await expect(workerPool.query(
      "SELECT event_type FROM public.platform_administrator_grant_events LIMIT 1",
    )).rejects.toThrow(/permission denied/);
    await expect(workerPool.query(
      "SELECT * FROM app.auth_platform_administrator_authorization($1,$2)",
      [randomUUID(), randomUUID()],
    )).rejects.toThrow(/permission denied/);
    await expect(workerPool.query(
      "SELECT * FROM app.platform_administration_overview($1,$2)",
      [randomUUID(), randomUUID()],
    )).rejects.toThrow(/permission denied/);
  });
});
