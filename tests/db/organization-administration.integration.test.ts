import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;

runDatabaseTests("organization administration concurrency", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const ids = {
    organization: randomUUID(),
    ownerRole: randomUUID(),
    adminRole: randomUUID(),
    ownerA: randomUUID(),
    ownerB: randomUUID(),
    adminA: randomUUID(),
    adminB: randomUUID(),
    ownerMembershipA: randomUUID(),
    ownerMembershipB: randomUUID(),
    adminMembershipA: randomUUID(),
    adminMembershipB: randomUUID(),
    adminSessionA: randomUUID(),
    adminSessionB: randomUUID(),
  };

  async function invokeSuspension(
    client: PoolClient,
    actorId: string,
    sessionId: string,
    targetMembershipId: string,
    requestId: string,
  ) {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.organization_id', $1, true)", [ids.organization]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
      await client.query("SELECT set_config('app.session_id', $1, true)", [sessionId]);
      await client.query("SELECT set_config('app.session_mode', 'real', true)");
      await client.query("SELECT set_config('app.auth_method', 'password+mfa', true)");
      await client.query("SELECT set_config('app.request_id', $1, true)", [requestId]);
      await client.query("SELECT set_config('app.source_surface', 'UI', true)");
      await client.query("SELECT set_config('app.reason', 'Concurrent owner safeguard test', true)");
      const result = await client.query<{ version: number }>(
        "SELECT app.organization_set_member_active($1, 1, false) AS version",
        [targetMembershipId],
      );
      await client.query("COMMIT");
      return result.rows[0]?.version;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  async function invokeAdministration<Row extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
    requestId: string,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [ids.organization]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [ids.adminA]);
      await client.query("SELECT set_config('app.session_id', $1, true)", [ids.adminSessionA]);
      await client.query("SELECT set_config('app.session_mode', 'real', true)");
      await client.query("SELECT set_config('app.auth_method', 'password+mfa', true)");
      await client.query("SELECT set_config('app.request_id', $1, true)", [requestId]);
      await client.query("SELECT set_config('app.source_surface', 'UI', true)");
      await client.query("SELECT set_config('app.reason', 'Invitation enrollment recovery test', true)");
      const result = await client.query<Row>(sql, [...values]);
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
    await pool.query(
      `INSERT INTO organizations(id, slug, display_name, active, is_demo, organization_mode)
       VALUES ($1, $2, 'Concurrent access test', true, false, 'REAL')`,
      [ids.organization, `admin-race-${ids.organization.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO roles(id, organization_id, key, display_name, system_template, active)
       VALUES
         ($1, $3, 'OWNER', 'Owner', true, true),
         ($2, $3, 'ORGANIZATION_ADMIN', 'Organization administrator', true, true)`,
      [ids.ownerRole, ids.adminRole, ids.organization],
    );
    for (const userId of [ids.ownerA, ids.ownerB, ids.adminA, ids.adminB]) {
      await pool.query(
        `INSERT INTO users(
           id, email_lookup_hash, email_ciphertext, password_hash, active,
           is_demo, mfa_required, email_verified_at
         ) VALUES ($1, $2, 'integration-ciphertext', 'integration-password',
           true, false, true, now())`,
        [userId, `admin-race-${userId}`],
      );
    }
    await pool.query(
      `INSERT INTO organization_memberships(id, organization_id, user_id, active)
       VALUES
         ($1, $5, $6, true), ($2, $5, $7, true),
         ($3, $5, $8, true), ($4, $5, $9, true)`,
      [
        ids.ownerMembershipA, ids.ownerMembershipB,
        ids.adminMembershipA, ids.adminMembershipB,
        ids.organization, ids.ownerA, ids.ownerB, ids.adminA, ids.adminB,
      ],
    );
    await pool.query(
      `INSERT INTO role_permissions(organization_id, role_id, permission_key)
       SELECT $1, $2, permission.key FROM permissions permission
       ON CONFLICT DO NOTHING`,
      [ids.organization, ids.ownerRole],
    );
    await pool.query(
      `INSERT INTO role_permissions(organization_id, role_id, permission_key)
       VALUES
         ($1, $2, 'organization.settings.read'),
         ($1, $2, 'organization.members.read'),
         ($1, $2, 'organization.members.manage'),
         ($1, $2, 'organization.roles.manage'),
         ($1, $2, 'organization.recovery.manage')
       ON CONFLICT DO NOTHING`,
      [ids.organization, ids.adminRole],
    );
    await pool.query(
      `INSERT INTO membership_roles(organization_id, membership_id, role_id, assigned_by)
       VALUES
         ($1, $2, $6, $8), ($1, $3, $6, $8),
         ($1, $4, $7, $8), ($1, $5, $7, $9)`,
      [
        ids.organization, ids.ownerMembershipA, ids.ownerMembershipB,
        ids.adminMembershipA, ids.adminMembershipB,
        ids.ownerRole, ids.adminRole, ids.adminA, ids.adminB,
      ],
    );
    await pool.query(
      `INSERT INTO auth_sessions(
         id, token_hash, user_id, organization_id, membership_id,
         auth_method, session_mode, idle_timeout_seconds,
         idle_expires_at, expires_at, mfa_verified_at, step_up_expires_at
       ) VALUES
         ($1, $3, $5, $7, $8, 'PASSWORD', 'REAL', 7200,
           now() + interval '2 hours', now() + interval '1 day', now(), now() + interval '10 minutes'),
         ($2, $4, $6, $7, $9, 'PASSWORD', 'REAL', 7200,
           now() + interval '2 hours', now() + interval '1 day', now(), now() + interval '10 minutes')`,
      [
        ids.adminSessionA, ids.adminSessionB,
        `admin-race-session-${ids.adminSessionA}`, `admin-race-session-${ids.adminSessionB}`,
        ids.adminA, ids.adminB, ids.organization,
        ids.adminMembershipA, ids.adminMembershipB,
      ],
    );
  });

  afterAll(async () => pool.end());

  it("serializes different owner suspensions so one owner always remains active", async () => {
    const [clientA, clientB] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const outcomes = await Promise.allSettled([
        invokeSuspension(clientA, ids.adminA, ids.adminSessionA, ids.ownerMembershipA, `owner-race-a-${ids.organization}`),
        invokeSuspension(clientB, ids.adminB, ids.adminSessionB, ids.ownerMembershipB, `owner-race-b-${ids.organization}`),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
        reason: expect.objectContaining({ message: expect.stringMatching(/last active owner/i) }),
      });
      const owners = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM organization_memberships membership
         JOIN membership_roles assignment
           ON assignment.organization_id = membership.organization_id
          AND assignment.membership_id = membership.id
         JOIN roles role
           ON role.organization_id = assignment.organization_id
          AND role.id = assignment.role_id
         WHERE membership.organization_id = $1
           AND membership.active AND role.key = 'OWNER'`,
        [ids.organization],
      );
      expect(owners.rows[0]?.count).toBe(1);
    } finally {
      clientA.release();
      clientB.release();
      await pool.query(
        `DELETE FROM role_permissions
         WHERE organization_id=$1 AND role_id=$2
           AND permission_key='organization.recovery.manage'`,
        [ids.organization, ids.adminRole],
      );
    }
  });

  it("keeps owner status and sessions behind recovery administration", async () => {
    const suspendedOwner = await pool.query<{ id: string }>(
      `SELECT membership.id
       FROM organization_memberships membership
       JOIN membership_roles assignment
         ON assignment.organization_id=membership.organization_id
        AND assignment.membership_id=membership.id
       WHERE membership.organization_id=$1
         AND assignment.role_id=$2 AND NOT membership.active
       LIMIT 1`,
      [ids.organization, ids.ownerRole],
    );
    const activeOwner = await pool.query<{ id: string }>(
      `SELECT membership.id
       FROM organization_memberships membership
       JOIN membership_roles assignment
         ON assignment.organization_id=membership.organization_id
        AND assignment.membership_id=membership.id
       WHERE membership.organization_id=$1
         AND assignment.role_id=$2 AND membership.active
       LIMIT 1`,
      [ids.organization, ids.ownerRole],
    );
    await expect(invokeAdministration(
      "SELECT app.organization_revoke_member_sessions($1)",
      [activeOwner.rows[0]!.id],
      randomUUID(),
    )).rejects.toMatchObject({ code: "42501" });
    await expect(invokeAdministration(
      "SELECT app.organization_set_member_active($1,2,true)",
      [suspendedOwner.rows[0]!.id],
      randomUUID(),
    )).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects hidden second-role assignments behind the fixed-role surface", async () => {
    await expect(pool.query(
      `INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by)
       VALUES($1,$2,$3,$4)`,
      [ids.organization, ids.adminMembershipA, ids.ownerRole, ids.adminB],
    )).rejects.toMatchObject({ code: "23505" });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM membership_roles
       WHERE organization_id=$1 AND membership_id=$2`,
      [ids.organization, ids.adminMembershipA],
    )).rows[0]?.count).toBe(1);
  });

  it("reissues a lost invitation MFA setup without retaining the accepted password", async () => {
    const userId = randomUUID();
    const membershipId = randomUUID();
    const invitationId = randomUUID();
    const invitationTokenId = randomUUID();
    const invitationHash = randomUUID().replaceAll("-", "").repeat(2);
    const firstFactorId = randomUUID();
    const firstSetupHash = randomUUID().replaceAll("-", "").repeat(2);
    const passwordHash = `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`;
    await pool.query(
      `INSERT INTO users(
         id,email_lookup_hash,email_ciphertext,display_name_ciphertext,
         password_hash,active,is_demo,mfa_required
       ) VALUES($1,$2,$3,$4,'!invitation-pending!',false,false,true)`,
      [
        userId,
        randomUUID().replaceAll("-", "").repeat(2),
        `idv1:${"e".repeat(80)}`,
        `idv1:${"n".repeat(80)}`,
      ],
    );
    await pool.query(
      "INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,false)",
      [membershipId, ids.organization, userId],
    );
    await pool.query(
      `INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by)
       VALUES($1,$2,$3,$4)`,
      [ids.organization, membershipId, ids.adminRole, ids.adminA],
    );
    await pool.query(
      `INSERT INTO auth_one_time_tokens(
         id,token_hash,purpose,user_id,organization_id,expires_at
       ) VALUES($1,$2,'INVITATION',$3,$4,now()+interval '72 hours')`,
      [invitationTokenId, invitationHash, userId, ids.organization],
    );
    await pool.query(
      `INSERT INTO organization_invitations(
         id,organization_id,user_id,membership_id,role_id,token_id,
         status,invited_by_user_id,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,now()+interval '72 hours')`,
      [
        invitationId,
        ids.organization,
        userId,
        membershipId,
        ids.adminRole,
        invitationTokenId,
        ids.adminA,
      ],
    );
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_invitation($1,$2,$3,$4,$5,$6)",
      [
        invitationHash,
        passwordHash,
        firstFactorId,
        `authv1:${"f".repeat(80)}`,
        firstSetupHash,
        randomUUID(),
      ],
    )).rowCount).toBe(1);

    const replacementTokenId = randomUUID();
    const replacementHash = randomUUID().replaceAll("-", "").repeat(2);
    const replacementOutboxId = randomUUID();
    const reissued = await invokeAdministration<{ version: number }>(
      "SELECT version FROM app.organization_resend_invitation($1,1,$2,$3,$4,$5)",
      [
        invitationId,
        replacementTokenId,
        replacementHash,
        replacementOutboxId,
        `authv1:${"p".repeat(80)}`,
      ],
      randomUUID(),
    );
    expect(reissued.rows[0]?.version).toBe(2);
    expect((await pool.query(
      `SELECT selected_user.password_hash, selected_user.email_verified_at,
        factor.status AS old_factor_status, setup.consumed_at AS old_setup_consumed
       FROM users selected_user
       JOIN auth_mfa_factors factor ON factor.id=$2
       JOIN auth_one_time_tokens setup
         ON setup.user_id=selected_user.id AND setup.token_hash=$3
       WHERE selected_user.id=$1`,
      [userId, firstFactorId, firstSetupHash],
    )).rows[0]).toMatchObject({
      password_hash: "!invitation-pending!",
      email_verified_at: null,
      old_factor_status: "REVOKED",
      old_setup_consumed: expect.any(Date),
    });

    const replacementFactorId = randomUUID();
    const replacementSetupHash = randomUUID().replaceAll("-", "").repeat(2);
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_invitation($1,$2,$3,$4,$5,$6)",
      [
        replacementHash,
        passwordHash,
        replacementFactorId,
        `authv1:${"g".repeat(80)}`,
        replacementSetupHash,
        randomUUID(),
      ],
    )).rowCount).toBe(1);
    expect((await pool.query(
      "SELECT app.auth_finish_mfa_enrollment($1,$2,1,$3) AS finished",
      [replacementSetupHash, replacementFactorId, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query(
      `SELECT selected_user.active AS user_active,
        membership.active AS membership_active,
        invitation.status AS invitation_status
       FROM users selected_user
       JOIN organization_memberships membership ON membership.user_id=selected_user.id
       JOIN organization_invitations invitation ON invitation.membership_id=membership.id
       WHERE selected_user.id=$1`,
      [userId],
    )).rows[0]).toEqual({
      user_active: true,
      membership_active: true,
      invitation_status: "ACCEPTED",
    });
  });

  it("enforces the sandbox member ceiling inside the serialized database mutation", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const issued = await client.query<{
        session_id: string;
        user_id: string;
        organization_id: string;
      }>(
        "SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
        [
          randomUUID().replaceAll("-", "").repeat(2),
          null,
          randomUUID().replaceAll("-", "").repeat(2),
          randomUUID().replaceAll("-", "").repeat(2),
          randomUUID().replaceAll("-", "").repeat(2),
          randomUUID(),
        ],
      );
      expect(issued.rowCount).toBe(1);
      const principal = issued.rows[0]!;
      await client.query("SELECT set_config('app.organization_id', $1, true)", [principal.organization_id]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [principal.user_id]);
      await client.query("SELECT set_config('app.session_id', $1, true)", [principal.session_id]);
      await client.query("SELECT set_config('app.session_mode', 'demo', true)");
      await client.query("SELECT set_config('app.auth_method', 'demo-link', true)");
      await client.query("SELECT set_config('app.request_id', $1, true)", [randomUUID()]);
      await client.query("SELECT set_config('app.source_surface', 'UI', true)");
      await client.query("SELECT set_config('app.reason', 'Sandbox member capacity test', true)");
      const role = await client.query<{ id: string }>(
        `SELECT id FROM roles WHERE organization_id=$1
           AND key='VIEWER_AUDITOR' AND active AND system_template`,
        [principal.organization_id],
      );
      for (let index = 0; index < 31; index += 1) {
        const userId = randomUUID();
        const membershipId = randomUUID();
        await client.query(
          `INSERT INTO users(
             id,email_lookup_hash,email_ciphertext,display_name_ciphertext,
             password_hash,active,is_demo,mfa_required,email_verified_at
           ) VALUES($1,$2,$3,$4,'!demo-invitation-disabled!',true,true,false,now())`,
          [
            userId,
            randomUUID().replaceAll("-", "").repeat(2),
            `idv1:${"e".repeat(80)}`,
            `idv1:${"n".repeat(80)}`,
          ],
        );
        await client.query(
          `INSERT INTO organization_memberships(id,organization_id,user_id,active)
           VALUES($1,$2,$3,false)`,
          [membershipId, principal.organization_id, userId],
        );
        await client.query(
          `INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by)
           VALUES($1,$2,$3,$4)`,
          [principal.organization_id, membershipId, role.rows[0]!.id, principal.user_id],
        );
      }
      expect((await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM organization_memberships
         WHERE organization_id=$1`,
        [principal.organization_id],
      )).rows[0]?.count).toBe(32);

      await client.query("SAVEPOINT demo_member_cap");
      await expect(client.query(
        `SELECT * FROM app.organization_invite_member(
           $1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL
         )`,
        [
          role.rows[0]!.id,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID().replaceAll("-", "").repeat(2),
          `idv1:${"x".repeat(80)}`,
          `idv1:${"y".repeat(80)}`,
        ],
      )).rejects.toThrow(/member limit of 32/i);
      await client.query("ROLLBACK TO SAVEPOINT demo_member_cap");
      expect((await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM organization_memberships
         WHERE organization_id=$1`,
        [principal.organization_id],
      )).rows[0]?.count).toBe(32);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
