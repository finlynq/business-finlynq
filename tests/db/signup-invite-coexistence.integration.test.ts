import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;

const wrappedDek = JSON.stringify({
  format: "business-finlynq-wrapped-key-v1",
  provider: "test-provider",
  keyVersion: 1,
  iv: "a".repeat(16),
  ciphertext: "b".repeat(44),
  authTag: "c".repeat(24),
});

function hashValue() {
  return randomUUID().replaceAll("-", "").repeat(2);
}

function identityCiphertext(fill: string) {
  return `idv1:${fill.repeat(80)}`;
}

function authCiphertext(fill: string) {
  return `authv1:${fill.repeat(80)}`;
}

function passwordHash(fill: string) {
  return `scrypt-v1$32768$8$1$${fill.repeat(24)}$${fill.repeat(88)}`;
}

type SignupReservation = {
  signupId: string;
  userId: string;
  organizationId: string;
  tokenId: string;
  tokenHash: string;
  outboxId: string;
  emailHash: string;
  emailCiphertext: string;
  displayNameCiphertext: string;
};

type Invitation = {
  invitationId: string;
  membershipId: string;
  tokenId: string;
  tokenHash: string;
  outboxId: string;
};

type SignupDelivery = Pick<SignupReservation, "tokenId" | "tokenHash" | "outboxId">;

type AdministrationPrincipal = {
  organizationId: string;
  userId: string;
  sessionId: string;
};

runDatabaseTests("pending signup and administrator invitation coexistence", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const administrator = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    membershipId: randomUUID(),
    roleId: randomUUID(),
    invitedRoleId: randomUUID(),
    sessionId: randomUUID(),
  };
  const recoveryOwner = {
    organizationId: administrator.organizationId,
    userId: randomUUID(),
    membershipId: randomUUID(),
    roleId: randomUUID(),
    sessionId: randomUUID(),
  };

  function newSignupReservation(): SignupReservation {
    return {
      signupId: randomUUID(),
      userId: randomUUID(),
      organizationId: randomUUID(),
      tokenId: randomUUID(),
      tokenHash: hashValue(),
      outboxId: randomUUID(),
      emailHash: hashValue(),
      emailCiphertext: identityCiphertext("s"),
      displayNameCiphertext: identityCiphertext("n"),
    };
  }

  async function requestSignup(
    reservation: SignupReservation,
    delivery: SignupDelivery,
  ): Promise<boolean> {
    const result = await pool.query<{ queued: boolean }>(
      `SELECT app.auth_begin_organization_signup(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25
       ) AS queued`,
      [
        reservation.signupId,
        reservation.userId,
        reservation.organizationId,
        delivery.tokenId,
        reservation.emailHash,
        reservation.emailCiphertext,
        reservation.displayNameCiphertext,
        `coexist-${reservation.organizationId.replaceAll("-", "").slice(0, 20)}`,
        "Reserved owner business",
        `C${reservation.organizationId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
        "Reserved owner business Inc.",
        "CA",
        "ON",
        "CAD",
        "CAN_ASPE",
        2026,
        "REVIEW_REQUIRED",
        "test-provider",
        wrappedDek,
        delivery.tokenHash,
        authCiphertext("q"),
        delivery.outboxId,
        hashValue(),
        randomUUID(),
        "2026-08-27",
      ],
    );
    return result.rows[0]?.queued ?? false;
  }

  async function beginSignup(): Promise<SignupReservation> {
    const reservation = newSignupReservation();
    expect(await requestSignup(reservation, reservation)).toBe(true);
    return reservation;
  }

  async function refreshSignup(reservation: SignupReservation): Promise<SignupDelivery> {
    const delivery = {
      tokenId: randomUUID(),
      tokenHash: hashValue(),
      outboxId: randomUUID(),
    };
    expect(await requestSignup(reservation, delivery)).toBe(true);
    return delivery;
  }

  async function invokeAdministration<Row extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
    principal: AdministrationPrincipal = administrator,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [principal.organizationId]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [principal.userId]);
      await client.query("SELECT set_config('app.session_id', $1, true)", [principal.sessionId]);
      await client.query("SELECT set_config('app.session_mode', 'real', true)");
      await client.query("SELECT set_config('app.auth_method', 'password+mfa', true)");
      await client.query("SELECT set_config('app.request_id', $1, true)", [randomUUID()]);
      await client.query("SELECT set_config('app.source_surface', 'UI', true)");
      await client.query("SELECT set_config('app.reason', 'Signup invitation precedence test', true)");
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

  async function inviteReservation(
    reservation: SignupReservation,
    roleId = administrator.invitedRoleId,
    principal: AdministrationPrincipal = administrator,
  ): Promise<Invitation> {
    const invitation: Invitation = {
      invitationId: randomUUID(),
      membershipId: randomUUID(),
      tokenId: randomUUID(),
      tokenHash: hashValue(),
      outboxId: randomUUID(),
    };
    const result = await invokeAdministration<{ invitation_id: string }>(
      `SELECT invitation_id FROM app.organization_invite_member(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
       )`,
      [
        roleId,
        reservation.userId,
        invitation.membershipId,
        invitation.invitationId,
        reservation.emailHash,
        identityCiphertext("i"),
        identityCiphertext("d"),
        invitation.tokenId,
        invitation.tokenHash,
        invitation.outboxId,
        authCiphertext("p"),
      ],
      principal,
    );
    expect(result.rows[0]?.invitation_id).toBe(invitation.invitationId);
    return invitation;
  }

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode)
       VALUES($1,$2,'Invitation administration',true,false,'REAL')`,
      [administrator.organizationId, `coexist-admin-${administrator.organizationId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO roles(id,organization_id,key,display_name,system_template,active)
       VALUES
         ($1,$3,'ORGANIZATION_ADMIN','Organization administrator',true,true),
         ($2,$3,'VIEWER_AUDITOR','Viewer auditor',true,true),
         ($4,$3,'OWNER','Owner',true,true)`,
      [
        administrator.roleId,
        administrator.invitedRoleId,
        administrator.organizationId,
        recoveryOwner.roleId,
      ],
    );
    await pool.query(
      `INSERT INTO role_permissions(organization_id,role_id,permission_key)
       VALUES
         ($1,$2,'organization.members.manage'),
         ($1,$2,'organization.roles.manage')
       ON CONFLICT DO NOTHING`,
      [administrator.organizationId, administrator.roleId],
    );
    await pool.query(
      `INSERT INTO role_permissions(organization_id,role_id,permission_key)
       VALUES
         ($1,$2,'organization.members.manage'),
         ($1,$2,'organization.roles.manage'),
         ($1,$2,'organization.recovery.manage')
       ON CONFLICT DO NOTHING`,
      [administrator.organizationId, recoveryOwner.roleId],
    );
    await pool.query(
      `INSERT INTO users(
         id,email_lookup_hash,email_ciphertext,display_name_ciphertext,
         password_hash,active,is_demo,mfa_required,email_verified_at
       ) VALUES($1,$2,$3,$4,'integration-password',true,false,true,now())`,
      [
        administrator.userId,
        hashValue(),
        identityCiphertext("a"),
        identityCiphertext("m"),
      ],
    );
    await pool.query(
      `INSERT INTO organization_memberships(id,organization_id,user_id,active)
       VALUES($1,$2,$3,true)`,
      [administrator.membershipId, administrator.organizationId, administrator.userId],
    );
    await pool.query(
      `INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by)
       VALUES($1,$2,$3,$4)`,
      [
        administrator.organizationId,
        administrator.membershipId,
        administrator.roleId,
        administrator.userId,
      ],
    );
    await pool.query(
      `INSERT INTO auth_sessions(
         id,token_hash,user_id,organization_id,membership_id,
         auth_method,session_mode,idle_timeout_seconds,
         idle_expires_at,expires_at,mfa_verified_at,step_up_expires_at
       ) VALUES(
         $1,$2,$3,$4,$5,'PASSWORD','REAL',7200,
         now()+interval '2 hours',now()+interval '1 day',now(),now()+interval '1 hour'
       )`,
      [
        administrator.sessionId,
        hashValue(),
        administrator.userId,
        administrator.organizationId,
        administrator.membershipId,
      ],
    );
    await pool.query(
      `INSERT INTO users(
         id,email_lookup_hash,email_ciphertext,display_name_ciphertext,
         password_hash,active,is_demo,mfa_required,email_verified_at
       ) VALUES($1,$2,$3,$4,'integration-password',true,false,true,now())`,
      [
        recoveryOwner.userId,
        hashValue(),
        identityCiphertext("o"),
        identityCiphertext("r"),
      ],
    );
    await pool.query(
      `INSERT INTO organization_memberships(id,organization_id,user_id,active)
       VALUES($1,$2,$3,true)`,
      [recoveryOwner.membershipId, recoveryOwner.organizationId, recoveryOwner.userId],
    );
    await pool.query(
      `INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by)
       VALUES($1,$2,$3,$4)`,
      [
        recoveryOwner.organizationId,
        recoveryOwner.membershipId,
        recoveryOwner.roleId,
        recoveryOwner.userId,
      ],
    );
    await pool.query(
      `INSERT INTO auth_sessions(
         id,token_hash,user_id,organization_id,membership_id,
         auth_method,session_mode,idle_timeout_seconds,
         idle_expires_at,expires_at,mfa_verified_at,step_up_expires_at
       ) VALUES(
         $1,$2,$3,$4,$5,'PASSWORD','REAL',7200,
         now()+interval '2 hours',now()+interval '1 day',now(),now()+interval '1 hour'
       )`,
      [
        recoveryOwner.sessionId,
        hashValue(),
        recoveryOwner.userId,
        recoveryOwner.organizationId,
        recoveryOwner.membershipId,
      ],
    );
  });

  afterAll(async () => pool.end());

  it("lets invitation verification win without rewriting signup-owned ciphertext", async () => {
    const reservation = await beginSignup();
    const invitation = await inviteReservation(reservation);
    const siblingOrganizationId = randomUUID();
    const siblingMembershipId = randomUUID();
    const siblingRoleId = randomUUID();
    const siblingInvitationId = randomUUID();
    const siblingTokenId = randomUUID();
    const siblingTokenHash = hashValue();
    const siblingOutboxId = randomUUID();
    await pool.query(
      `INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode)
       VALUES($1,$2,'Sibling invitation',true,false,'REAL')`,
      [siblingOrganizationId, `sibling-${siblingOrganizationId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO roles(id,organization_id,key,display_name,system_template,active)
       VALUES($1,$2,'VIEWER_AUDITOR','Viewer auditor',true,true)`,
      [siblingRoleId, siblingOrganizationId],
    );
    await pool.query(
      `INSERT INTO organization_memberships(id,organization_id,user_id,active)
       VALUES($1,$2,$3,false)`,
      [siblingMembershipId, siblingOrganizationId, reservation.userId],
    );
    await pool.query(
      `INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by)
       VALUES($1,$2,$3,$4)`,
      [siblingOrganizationId, siblingMembershipId, siblingRoleId, administrator.userId],
    );
    await pool.query(
      `INSERT INTO auth_one_time_tokens(
         id,token_hash,purpose,user_id,organization_id,expires_at
       ) VALUES($1,$2,'INVITATION',$3,$4,now()+interval '72 hours')`,
      [siblingTokenId, siblingTokenHash, reservation.userId, siblingOrganizationId],
    );
    await pool.query(
      `INSERT INTO auth_email_outbox(
         id,user_id,organization_id,template_type,payload_ciphertext,request_id
       ) VALUES($1,$2,$3,'INVITATION',$4,$5)`,
      [siblingOutboxId, reservation.userId, siblingOrganizationId, authCiphertext("s"), randomUUID()],
    );
    await pool.query(
      `INSERT INTO organization_invitations(
         id,organization_id,user_id,membership_id,role_id,token_id,
         status,invited_by_user_id,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,now()+interval '72 hours')`,
      [
        siblingInvitationId,
        siblingOrganizationId,
        reservation.userId,
        siblingMembershipId,
        siblingRoleId,
        siblingTokenId,
        administrator.userId,
      ],
    );
    const refreshedSignup = await refreshSignup(reservation);
    expect((await pool.query(
      `SELECT
         (SELECT consumed_at IS NOT NULL FROM auth_one_time_tokens WHERE id=$1) AS old_signup_consumed,
         (SELECT consumed_at IS NULL FROM auth_one_time_tokens WHERE id=$2) AS refreshed_signup_available,
         (SELECT consumed_at IS NULL FROM auth_one_time_tokens WHERE id=$3) AS invitation_available,
         (SELECT status FROM organization_invitations WHERE id=$4) AS invitation_status`,
      [
        reservation.tokenId,
        refreshedSignup.tokenId,
        invitation.tokenId,
        invitation.invitationId,
      ],
    )).rows[0]).toEqual({
      old_signup_consumed: true,
      refreshed_signup_available: true,
      invitation_available: true,
      invitation_status: "PENDING",
    });
    expect((await pool.query(
      `SELECT email_ciphertext,display_name_ciphertext,password_hash
       FROM users WHERE id=$1`,
      [reservation.userId],
    )).rows[0]).toEqual({
      email_ciphertext: reservation.emailCiphertext,
      display_name_ciphertext: reservation.displayNameCiphertext,
      password_hash: "!organization-signup-pending!",
    });

    const factorId = randomUUID();
    const setupTokenHash = hashValue();
    const accepted = await pool.query(
      "SELECT * FROM app.auth_accept_invitation($1,$2,$3,$4,$5,$6)",
      [
        invitation.tokenHash,
        passwordHash("i"),
        factorId,
        authCiphertext("f"),
        setupTokenHash,
        randomUUID(),
      ],
    );
    expect(accepted.rowCount).toBe(1);
    expect(accepted.rows[0]?.email_ciphertext).toBe(reservation.emailCiphertext);
    expect((await pool.query(
      `SELECT
         (SELECT status FROM auth_organization_signups WHERE id=$1) AS signup_status,
         (SELECT consumed_at IS NOT NULL FROM auth_one_time_tokens WHERE id=$2) AS signup_token_consumed,
         (SELECT status FROM auth_email_outbox WHERE id=$3) AS signup_outbox_status,
         (SELECT status FROM organization_invitations WHERE id=$4) AS invitation_status,
         (SELECT status FROM organization_invitations WHERE id=$5) AS sibling_status,
         (SELECT consumed_at IS NOT NULL FROM auth_one_time_tokens WHERE id=$6) AS sibling_token_consumed,
         (SELECT status FROM auth_email_outbox WHERE id=$7) AS sibling_outbox_status`,
      [
        reservation.signupId,
        refreshedSignup.tokenId,
        refreshedSignup.outboxId,
        invitation.invitationId,
        siblingInvitationId,
        siblingTokenId,
        siblingOutboxId,
      ],
    )).rows[0]).toEqual({
      signup_status: "SUPERSEDED",
      signup_token_consumed: true,
      signup_outbox_status: "DEAD",
      invitation_status: "PENDING",
      sibling_status: "SUPERSEDED",
      sibling_token_consumed: true,
      sibling_outbox_status: "DEAD",
    });

    expect((await pool.query(
      "SELECT app.auth_finish_mfa_enrollment($1,$2,1,$3) AS finished",
      [setupTokenHash, factorId, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query(
      `SELECT membership.active,invitation.status
       FROM organization_memberships membership
       JOIN organization_invitations invitation
         ON invitation.membership_id=membership.id
       WHERE membership.id=$1`,
      [invitation.membershipId],
    )).rows[0]).toEqual({ active: true, status: "ACCEPTED" });
  });

  it("refreshes a signup-first reservation after its unused invitation expires", async () => {
    const reservation = await beginSignup();
    const invitation = await inviteReservation(reservation);
    await pool.query(
      `UPDATE organization_invitations
       SET created_at=now()-interval '4 days',expires_at=now()-interval '1 hour'
       WHERE id=$1`,
      [invitation.invitationId],
    );
    await pool.query(
      `UPDATE auth_one_time_tokens
       SET created_at=now()-interval '4 days',expires_at=now()-interval '1 hour'
       WHERE id=$1`,
      [invitation.tokenId],
    );
    const refreshed = await refreshSignup(reservation);
    expect((await pool.query(
      `SELECT
         (SELECT consumed_at IS NULL FROM auth_one_time_tokens WHERE id=$1) AS signup_available,
         (SELECT status FROM organization_invitations WHERE id=$2) AS invitation_status,
         (SELECT expires_at < now() FROM organization_invitations WHERE id=$2) AS invitation_expired`,
      [refreshed.tokenId, invitation.invitationId],
    )).rows[0]).toEqual({
      signup_available: true,
      invitation_status: "PENDING",
      invitation_expired: true,
    });
  });

  it("refreshes an invitation-first signup after the unused invitation is cancelled", async () => {
    const reservation = newSignupReservation();
    const invitation = await inviteReservation(reservation);
    expect(await requestSignup(reservation, reservation)).toBe(true);
    expect((await invokeAdministration<{ version: number }>(
      "SELECT app.organization_cancel_invitation($1,1) AS version",
      [invitation.invitationId],
    )).rows[0]?.version).toBe(2);
    const refreshed = await refreshSignup(reservation);
    expect((await pool.query(
      `SELECT
         (SELECT status FROM organization_invitations WHERE id=$1) AS invitation_status,
         (SELECT consumed_at IS NULL FROM auth_one_time_tokens WHERE id=$2) AS signup_available`,
      [invitation.invitationId, refreshed.tokenId],
    )).rows[0]).toEqual({ invitation_status: "CANCELLED", signup_available: true });
  });

  it("keeps OWNER invitation resend and cancellation behind recovery authority", async () => {
    const reservation = await beginSignup();
    const invitation = await inviteReservation(
      reservation,
      recoveryOwner.roleId,
      recoveryOwner,
    );
    const resendValues = [
      invitation.invitationId,
      1,
      randomUUID(),
      hashValue(),
      randomUUID(),
      authCiphertext("w"),
    ] as const;
    await expect(invokeAdministration(
      "SELECT * FROM app.organization_resend_invitation($1,$2,$3,$4,$5,$6)",
      resendValues,
    )).rejects.toMatchObject({ code: "42501" });
    await expect(invokeAdministration(
      "SELECT app.organization_cancel_invitation($1,1)",
      [invitation.invitationId],
    )).rejects.toMatchObject({ code: "42501" });

    expect((await invokeAdministration<{ version: number }>(
      "SELECT version FROM app.organization_resend_invitation($1,$2,$3,$4,$5,$6)",
      resendValues,
      recoveryOwner,
    )).rows[0]?.version).toBe(2);
    expect((await invokeAdministration<{ version: number }>(
      "SELECT app.organization_cancel_invitation($1,2) AS version",
      [invitation.invitationId],
      recoveryOwner,
    )).rows[0]?.version).toBe(3);
  });

  it("lets owner verification win and terminally supersede the invitation", async () => {
    const reservation = await beginSignup();
    const invitation = await inviteReservation(reservation);
    const factorId = randomUUID();
    const setupTokenHash = hashValue();
    const accepted = await pool.query(
      "SELECT * FROM app.auth_accept_organization_signup($1,$2,$3,$4,$5,$6)",
      [
        reservation.tokenHash,
        passwordHash("o"),
        factorId,
        authCiphertext("g"),
        setupTokenHash,
        randomUUID(),
      ],
    );
    expect(accepted.rowCount).toBe(1);
    expect((await pool.query(
      `SELECT
         (SELECT status FROM auth_organization_signups WHERE id=$1) AS signup_status,
         (SELECT status FROM organization_invitations WHERE id=$2) AS invitation_status,
         (SELECT consumed_at IS NOT NULL FROM auth_one_time_tokens WHERE id=$3) AS invitation_token_consumed,
         (SELECT status FROM auth_email_outbox WHERE id=$4) AS invitation_outbox_status,
         (SELECT active FROM organization_memberships WHERE id=$5) AS invitation_membership_active`,
      [
        reservation.signupId,
        invitation.invitationId,
        invitation.tokenId,
        invitation.outboxId,
        invitation.membershipId,
      ],
    )).rows[0]).toEqual({
      signup_status: "ENROLLING",
      invitation_status: "SUPERSEDED",
      invitation_token_consumed: true,
      invitation_outbox_status: "DEAD",
      invitation_membership_active: false,
    });
    expect((await pool.query(
      "SELECT app.auth_finish_mfa_enrollment($1,$2,1,$3) AS finished",
      [setupTokenHash, factorId, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM organization_memberships
       WHERE user_id=$1 AND active`,
      [reservation.userId],
    )).rows[0]?.count).toBe(1);
  });

  it("serializes invitation creation against owner verification", async () => {
    const reservation = await beginSignup();
    const factorId = randomUUID();
    const setupTokenHash = hashValue();
    const [invitationOutcome, signupOutcome] = await Promise.allSettled([
      inviteReservation(reservation),
      pool.query(
        "SELECT * FROM app.auth_accept_organization_signup($1,$2,$3,$4,$5,$6)",
        [
          reservation.tokenHash,
          passwordHash("r"),
          factorId,
          authCiphertext("r"),
          setupTokenHash,
          randomUUID(),
        ],
      ),
    ]);
    expect(signupOutcome.status).toBe("fulfilled");
    if (signupOutcome.status === "fulfilled") {
      expect(signupOutcome.value.rowCount).toBe(1);
    }
    if (invitationOutcome.status === "rejected") {
      expect(invitationOutcome.reason).toMatchObject({ code: "23505" });
    }
    const state = await pool.query<{ signup_status: string; pending_invitations: number }>(
      `SELECT signup.status AS signup_status,
         count(invitation.id) FILTER (WHERE invitation.status='PENDING')::int AS pending_invitations
       FROM auth_organization_signups signup
       LEFT JOIN organization_invitations invitation ON invitation.user_id=signup.user_id
       WHERE signup.id=$1
       GROUP BY signup.status`,
      [reservation.signupId],
    );
    expect(state.rows[0]).toEqual({ signup_status: "ENROLLING", pending_invitations: 0 });
  });

  it("allows exactly one verified acceptance path to win a direct race", async () => {
    const reservation = await beginSignup();
    const invitation = await inviteReservation(reservation);
    const invitationFactorId = randomUUID();
    const invitationSetupHash = hashValue();
    const signupFactorId = randomUUID();
    const signupSetupHash = hashValue();

    // Both proof links have already been delivered before the user can race them.
    // Keeping the delivery rows terminal makes any surviving capability explicit.
    await pool.query(
      `UPDATE auth_email_outbox
       SET status='SENT',sent_at=now()
       WHERE id = ANY($1::uuid[])`,
      [[reservation.outboxId, invitation.outboxId]],
    );

    const [invitationOutcome, signupOutcome] = await Promise.allSettled([
      pool.query(
        "SELECT * FROM app.auth_accept_invitation($1,$2,$3,$4,$5,$6)",
        [
          invitation.tokenHash,
          passwordHash("v"),
          invitationFactorId,
          authCiphertext("v"),
          invitationSetupHash,
          randomUUID(),
        ],
      ),
      pool.query(
        "SELECT * FROM app.auth_accept_organization_signup($1,$2,$3,$4,$5,$6)",
        [
          reservation.tokenHash,
          passwordHash("u"),
          signupFactorId,
          authCiphertext("u"),
          signupSetupHash,
          randomUUID(),
        ],
      ),
    ]);

    expect(invitationOutcome.status).toBe("fulfilled");
    expect(signupOutcome.status).toBe("fulfilled");
    if (invitationOutcome.status !== "fulfilled" || signupOutcome.status !== "fulfilled") {
      throw new Error("Both serialized acceptance calls must complete without an exception");
    }
    const invitationWon = invitationOutcome.value.rowCount === 1;
    const signupWon = signupOutcome.value.rowCount === 1;
    expect(Number(invitationWon) + Number(signupWon)).toBe(1);

    const winnerFactorId = invitationWon ? invitationFactorId : signupFactorId;
    const winnerSetupHash = invitationWon ? invitationSetupHash : signupSetupHash;
    const raceState = (await pool.query<{
      signup_status: string;
      invitation_status: string;
      available_original_tokens: number;
      pending_or_active_factors: number;
      available_setup_tokens: number;
      nonterminal_deliveries: number;
    }>(
      `SELECT
         (SELECT status FROM auth_organization_signups WHERE id=$1) AS signup_status,
         (SELECT status FROM organization_invitations WHERE id=$2) AS invitation_status,
         (SELECT count(*)::int FROM auth_one_time_tokens
          WHERE id = ANY($3::uuid[]) AND consumed_at IS NULL) AS available_original_tokens,
         (SELECT count(*)::int FROM auth_mfa_factors
          WHERE user_id=$4 AND status IN ('PENDING','ACTIVE')) AS pending_or_active_factors,
         (SELECT count(*)::int FROM auth_one_time_tokens
          WHERE user_id=$4 AND purpose='MFA_SETUP'
            AND consumed_at IS NULL AND expires_at > now()) AS available_setup_tokens,
         (SELECT count(*)::int FROM auth_email_outbox
          WHERE id = ANY($5::uuid[]) AND status IN ('PENDING','SENDING')) AS nonterminal_deliveries`,
      [
        reservation.signupId,
        invitation.invitationId,
        [reservation.tokenId, invitation.tokenId],
        reservation.userId,
        [reservation.outboxId, invitation.outboxId],
      ],
    )).rows[0];
    expect(raceState).toEqual({
      signup_status: invitationWon ? "SUPERSEDED" : "ENROLLING",
      invitation_status: invitationWon ? "PENDING" : "SUPERSEDED",
      available_original_tokens: 0,
      pending_or_active_factors: 1,
      available_setup_tokens: 1,
      nonterminal_deliveries: 0,
    });

    expect((await pool.query(
      "SELECT app.auth_finish_mfa_enrollment($1,$2,1,$3) AS finished",
      [winnerSetupHash, winnerFactorId, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query<{
      active_memberships: number;
      active_factors: number;
      pending_factors: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM organization_memberships
          WHERE user_id=$1 AND active) AS active_memberships,
         (SELECT count(*)::int FROM auth_mfa_factors
          WHERE user_id=$1 AND status='ACTIVE') AS active_factors,
         (SELECT count(*)::int FROM auth_mfa_factors
          WHERE user_id=$1 AND status='PENDING') AS pending_factors`,
      [reservation.userId],
    )).rows[0]).toEqual({
      active_memberships: 1,
      active_factors: 1,
      pending_factors: 0,
    });
  });

  it("rejects reservations that are no longer strictly pending and unused", async () => {
    const verified = await beginSignup();
    await pool.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [verified.userId]);
    await expect(inviteReservation(verified)).rejects.toMatchObject({ code: "23505" });

    const enrolled = await beginSignup();
    await pool.query(
      `INSERT INTO auth_mfa_factors(
         id,user_id,factor_type,label,secret_ciphertext,status
       ) VALUES($1,$2,'TOTP','Pending factor',$3,'PENDING')`,
      [randomUUID(), enrolled.userId, authCiphertext("m")],
    );
    await expect(inviteReservation(enrolled)).rejects.toMatchObject({ code: "23505" });

    const member = await beginSignup();
    const otherOrganizationId = randomUUID();
    await pool.query(
      `INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode)
       VALUES($1,$2,'Existing membership',true,false,'REAL')`,
      [otherOrganizationId, `member-${otherOrganizationId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO organization_memberships(organization_id,user_id,active)
       VALUES($1,$2,true)`,
      [otherOrganizationId, member.userId],
    );
    await expect(inviteReservation(member)).rejects.toMatchObject({ code: "23505" });

    const enrolling = await beginSignup();
    await pool.query(
      `UPDATE auth_organization_signups
       SET status='ENROLLING',accepted_at=now() WHERE id=$1`,
      [enrolling.signupId],
    );
    await expect(inviteReservation(enrolling)).rejects.toMatchObject({ code: "23505" });

    const staleDelivery = await beginSignup();
    await pool.query(
      `UPDATE auth_one_time_tokens SET
         consumed_at=now(),created_at=now()-interval '2 days',
         expires_at=now()-interval '1 day'
       WHERE id=$1`,
      [staleDelivery.tokenId],
    );
    await pool.query(
      `UPDATE auth_organization_signups SET
         created_at=now()-interval '2 days',expires_at=now()-interval '1 day'
       WHERE id=$1`,
      [staleDelivery.signupId],
    );
    const staleInvitation = await inviteReservation(staleDelivery);
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_invitation($1,$2,$3,$4,$5,$6)",
      [
        staleInvitation.tokenHash,
        passwordHash("x"),
        randomUUID(),
        authCiphertext("x"),
        hashValue(),
        randomUUID(),
      ],
    )).rowCount).toBe(1);
    expect((await pool.query(
      "SELECT status FROM auth_organization_signups WHERE id=$1",
      [staleDelivery.signupId],
    )).rows[0]?.status).toBe("SUPERSEDED");

    const explicitlyExpired = await beginSignup();
    await pool.query(
      "UPDATE auth_organization_signups SET status='EXPIRED' WHERE id=$1",
      [explicitlyExpired.signupId],
    );
    const expiredInvitation = await inviteReservation(explicitlyExpired);
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_invitation($1,$2,$3,$4,$5,$6)",
      [
        expiredInvitation.tokenHash,
        passwordHash("z"),
        randomUUID(),
        authCiphertext("z"),
        hashValue(),
        randomUUID(),
      ],
    )).rowCount).toBe(1);
    expect((await pool.query(
      "SELECT status FROM auth_organization_signups WHERE id=$1",
      [explicitlyExpired.signupId],
    )).rows[0]?.status).toBe("SUPERSEDED");
  });
});
