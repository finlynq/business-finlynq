import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
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

runDatabaseTests("signup and invitation identity precedence", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => pool.end());

  it("preserves an unused invitation until email proof, then cancels it atomically", async () => {
    const signupId = randomUUID();
    const userId = randomUUID();
    const organizationId = randomUUID();
    const signupTokenId = randomUUID();
    const signupTokenHash = randomUUID().replaceAll("-", "").repeat(2);
    const signupOutboxId = randomUUID();
    const emailHash = randomUUID().replaceAll("-", "").repeat(2);
    const invitedOrganizationId = randomUUID();
    const invitedMembershipId = randomUUID();
    const invitedRoleId = randomUUID();
    const invitationId = randomUUID();
    const invitationTokenId = randomUUID();
    const invitationTokenHash = randomUUID().replaceAll("-", "").repeat(2);
    const invitationOutboxId = randomUUID();

    await pool.query(
      "INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode) VALUES($1,$2,'Inviting business',true,false,'REAL')",
      [invitedOrganizationId, `inviting-${invitedOrganizationId}`],
    );
    await pool.query(
      `INSERT INTO users(
         id,email_lookup_hash,email_ciphertext,display_name_ciphertext,
         password_hash,active,is_demo,mfa_required
       ) VALUES($1,$2,$3,$4,'!invitation-pending!',false,false,true)`,
      [userId, emailHash, `idv1:${"e".repeat(80)}`, `idv1:${"n".repeat(80)}`],
    );
    await pool.query(
      "INSERT INTO roles(id,organization_id,key,display_name,system_template,active) VALUES($1,$2,'VIEWER_AUDITOR','Viewer',true,true)",
      [invitedRoleId, invitedOrganizationId],
    );
    await pool.query(
      "INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,false)",
      [invitedMembershipId, invitedOrganizationId, userId],
    );
    await pool.query(
      `INSERT INTO auth_one_time_tokens(
         id,token_hash,purpose,user_id,organization_id,expires_at
       ) VALUES($1,$2,'INVITATION',$3,$4,now()+interval '72 hours')`,
      [invitationTokenId, invitationTokenHash, userId, invitedOrganizationId],
    );
    await pool.query(
      `INSERT INTO auth_email_outbox(
         id,user_id,organization_id,template_type,payload_ciphertext,request_id
       ) VALUES($1,$2,$3,'INVITATION',$4,$5)`,
      [invitationOutboxId, userId, invitedOrganizationId, `authv1:${"p".repeat(80)}`, randomUUID()],
    );
    await pool.query(
      `INSERT INTO organization_invitations(
         id,organization_id,user_id,membership_id,role_id,token_id,
         status,invited_by_user_id,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$3,now()+interval '72 hours')`,
      [
        invitationId,
        invitedOrganizationId,
        userId,
        invitedMembershipId,
        invitedRoleId,
        invitationTokenId,
      ],
    );

    const begin = await pool.query(
      `SELECT app.auth_begin_organization_signup(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25
       ) AS queued`,
      [
        signupId,
        userId,
        organizationId,
        signupTokenId,
        emailHash,
        `idv1:${"s".repeat(80)}`,
        `idv1:${"d".repeat(80)}`,
        `signup-${organizationId.replaceAll("-", "").slice(0, 20)}`,
        "Verified signup business",
        "CA01",
        "Verified signup business Inc.",
        "CA",
        "ON",
        "CAD",
        "CAN_ASPE",
        2026,
        "AUTO_POST",
        "test-provider",
        wrappedDek,
        signupTokenHash,
        `authv1:${"q".repeat(80)}`,
        signupOutboxId,
        "i".repeat(64),
        randomUUID(),
        "2026-08-27",
      ],
    );
    expect(begin.rows[0]?.queued).toBe(true);
    expect((await pool.query(
      "SELECT consumed_at FROM auth_one_time_tokens WHERE id=$1",
      [invitationTokenId],
    )).rows[0]?.consumed_at).toBeNull();
    expect((await pool.query(
      "SELECT status FROM auth_email_outbox WHERE id=$1",
      [invitationOutboxId],
    )).rows[0]?.status).toBe("PENDING");
    expect((await pool.query(
      "SELECT display_name_ciphertext FROM users WHERE id=$1",
      [userId],
    )).rows[0]?.display_name_ciphertext).toBe(`idv1:${"n".repeat(80)}`);

    const passwordHash = `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`;
    const signupFactorId = randomUUID();
    const signupSetupHash = "u".repeat(64);
    const accepted = await pool.query(
      "SELECT * FROM app.auth_accept_organization_signup($1,$2,$3,$4,$5,$6)",
      [signupTokenHash, passwordHash, signupFactorId, `authv1:${"f".repeat(80)}`, signupSetupHash, randomUUID()],
    );
    expect(accepted.rowCount).toBe(1);
    expect((await pool.query(
      "SELECT display_name_ciphertext FROM users WHERE id=$1",
      [userId],
    )).rows[0]?.display_name_ciphertext).toBe(`idv1:${"d".repeat(80)}`);
    expect((await pool.query(
      `SELECT
         (SELECT consumed_at IS NOT NULL FROM auth_one_time_tokens WHERE id=$1) AS token_consumed,
         (SELECT status FROM auth_email_outbox WHERE id=$2) AS outbox_status,
         (SELECT status FROM organization_invitations WHERE id=$3) AS invitation_status,
         (SELECT active FROM organization_memberships WHERE id=$4) AS old_membership_active,
         (SELECT status FROM auth_organization_signups WHERE id=$5) AS signup_status`,
      [invitationTokenId, invitationOutboxId, invitationId, invitedMembershipId, signupId],
    )).rows[0]).toEqual({
      token_consumed: true,
      outbox_status: "DEAD",
      invitation_status: "SUPERSEDED",
      old_membership_active: false,
      signup_status: "ENROLLING",
    });

    await pool.query(
      "UPDATE organization_memberships SET active=true WHERE id=$1",
      [invitedMembershipId],
    );
    expect((await pool.query(
      "SELECT app.auth_finish_mfa_enrollment($1,$2,1,$3) AS finished",
      [signupSetupHash, signupFactorId, randomUUID()],
    )).rows[0]?.finished).toBe(false);
    expect((await pool.query(
      "SELECT active FROM users WHERE id=$1",
      [userId],
    )).rows[0]?.active).toBe(false);

    await pool.query(
      "UPDATE organization_memberships SET active=false WHERE id=$1",
      [invitedMembershipId],
    );
    expect((await pool.query(
      "SELECT app.auth_finish_mfa_enrollment($1,$2,1,$3) AS finished",
      [signupSetupHash, signupFactorId, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM organization_memberships WHERE user_id=$1 AND active",
      [userId],
    )).rows[0]?.count).toBe(1);
  });

  it("restarts an interrupted MFA enrollment without activating the owner early", async () => {
    const signupId = randomUUID();
    const userId = randomUUID();
    const organizationId = randomUUID();
    const emailHash = randomUUID().replaceAll("-", "").repeat(2);
    const organizationSlug = `retry-${organizationId.replaceAll("-", "").slice(0, 20)}`;
    const queueSignup = async (tokenId: string, tokenHash: string, outboxId: string) => pool.query(
      `SELECT app.auth_begin_organization_signup(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25
       ) AS queued`,
      [
        signupId,
        userId,
        organizationId,
        tokenId,
        emailHash,
        `idv1:${"e".repeat(80)}`,
        `idv1:${"n".repeat(80)}`,
        organizationSlug,
        "Enrollment retry business",
        "US01",
        "Enrollment retry business Inc.",
        "US",
        "WA",
        "USD",
        "US_GAAP_NONPUBLIC",
        2026,
        "REVIEW_REQUIRED",
        "test-provider",
        wrappedDek,
        tokenHash,
        `authv1:${"q".repeat(80)}`,
        outboxId,
        "r".repeat(64),
        randomUUID(),
        "2026-08-27",
      ],
    );

    const firstTokenId = randomUUID();
    const firstTokenHash = randomUUID().replaceAll("-", "").repeat(2);
    expect((await queueSignup(firstTokenId, firstTokenHash, randomUUID())).rows[0]?.queued).toBe(true);
    const firstFactorId = randomUUID();
    const firstSetupHash = randomUUID().replaceAll("-", "").repeat(2);
    const firstPasswordHash = `scrypt-v1$32768$8$1$${"a".repeat(24)}$${"b".repeat(88)}`;
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_organization_signup($1,$2,$3,$4,$5,$6)",
      [firstTokenHash, firstPasswordHash, firstFactorId, `authv1:${"f".repeat(80)}`, firstSetupHash, randomUUID()],
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT selected_user.active AS user_active, membership.active AS membership_active,
        factor.status AS factor_status, signup.status AS signup_status
       FROM users selected_user
       JOIN auth_organization_signups signup ON signup.user_id=selected_user.id
       JOIN organization_memberships membership
         ON membership.user_id=selected_user.id
        AND membership.organization_id=signup.organization_id
       JOIN auth_mfa_factors factor ON factor.id=$2
       WHERE selected_user.id=$1`,
      [userId, firstFactorId],
    )).rows[0]).toEqual({
      user_active: false,
      membership_active: false,
      factor_status: "PENDING",
      signup_status: "ENROLLING",
    });

    const secondTokenId = randomUUID();
    const secondTokenHash = randomUUID().replaceAll("-", "").repeat(2);
    expect((await queueSignup(secondTokenId, secondTokenHash, randomUUID())).rows[0]?.queued).toBe(true);
    expect((await pool.query(
      "SELECT consumed_at IS NOT NULL AS consumed FROM auth_one_time_tokens WHERE token_hash=$1",
      [firstSetupHash],
    )).rows[0]?.consumed).toBe(true);

    const secondFactorId = randomUUID();
    const secondSetupHash = randomUUID().replaceAll("-", "").repeat(2);
    const secondPasswordHash = `scrypt-v1$32768$8$1$${"c".repeat(24)}$${"d".repeat(88)}`;
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_organization_signup($1,$2,$3,$4,$5,$6)",
      [secondTokenHash, secondPasswordHash, secondFactorId, `authv1:${"g".repeat(80)}`, secondSetupHash, randomUUID()],
    )).rowCount).toBe(1);
    expect((await pool.query(
      "SELECT status FROM auth_mfa_factors WHERE id=$1",
      [firstFactorId],
    )).rows[0]?.status).toBe("REVOKED");

    expect((await pool.query(
      "SELECT app.auth_finish_mfa_enrollment($1,$2,1,$3) AS finished",
      [secondSetupHash, secondFactorId, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query(
      `SELECT selected_user.active AS user_active, membership.active AS membership_active,
        factor.status AS factor_status, signup.status AS signup_status
       FROM users selected_user
       JOIN auth_organization_signups signup ON signup.user_id=selected_user.id
       JOIN organization_memberships membership
         ON membership.user_id=selected_user.id
        AND membership.organization_id=signup.organization_id
       JOIN auth_mfa_factors factor ON factor.id=$2
       WHERE selected_user.id=$1`,
      [userId, secondFactorId],
    )).rows[0]).toEqual({
      user_active: true,
      membership_active: true,
      factor_status: "ACTIVE",
      signup_status: "ACTIVE",
    });
  });

  it("does not let an unverified signup retry break an accepted invitation enrollment", async () => {
    const signupId = randomUUID();
    const userId = randomUUID();
    const ownerOrganizationId = randomUUID();
    const invitedOrganizationId = randomUUID();
    const invitedMembershipId = randomUUID();
    const emailHash = randomUUID().replaceAll("-", "").repeat(2);
    const invitationTokenHash = randomUUID().replaceAll("-", "").repeat(2);
    const signupTokenHash = randomUUID().replaceAll("-", "").repeat(2);
    const organizationSlug = `race-${ownerOrganizationId.replaceAll("-", "").slice(0, 20)}`;

    await pool.query(
      "INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode) VALUES($1,$2,'Invitation winner',true,false,'REAL')",
      [invitedOrganizationId, `winner-${invitedOrganizationId}`],
    );
    await pool.query(
      `INSERT INTO users(
         id,email_lookup_hash,email_ciphertext,display_name_ciphertext,
         password_hash,active,is_demo,mfa_required
       ) VALUES($1,$2,$3,$4,'!invitation-pending!',false,false,true)`,
      [userId, emailHash, `idv1:${"e".repeat(80)}`, `idv1:${"n".repeat(80)}`],
    );
    await pool.query(
      "INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,false)",
      [invitedMembershipId, invitedOrganizationId, userId],
    );
    await pool.query(
      `INSERT INTO auth_one_time_tokens(
         token_hash,purpose,user_id,organization_id,expires_at
       ) VALUES($1,'INVITATION',$2,$3,now()+interval '72 hours')`,
      [invitationTokenHash, userId, invitedOrganizationId],
    );

    const queueSignup = async (tokenId: string, tokenHash: string, outboxId: string) => pool.query(
      `SELECT app.auth_begin_organization_signup(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25
       ) AS queued`,
      [
        signupId,
        userId,
        ownerOrganizationId,
        tokenId,
        emailHash,
        `idv1:${"s".repeat(80)}`,
        `idv1:${"d".repeat(80)}`,
        organizationSlug,
        "Losing signup flow",
        "CA01",
        "Losing signup flow Inc.",
        "CA",
        "ON",
        "CAD",
        "CAN_ASPE",
        2026,
        "AUTO_POST",
        "test-provider",
        wrappedDek,
        tokenHash,
        `authv1:${"q".repeat(80)}`,
        outboxId,
        "r".repeat(64),
        randomUUID(),
        "2026-08-27",
      ],
    );
    expect((await queueSignup(randomUUID(), signupTokenHash, randomUUID())).rows[0]?.queued).toBe(true);

    const invitationFactorId = randomUUID();
    const invitationSetupHash = randomUUID().replaceAll("-", "").repeat(2);
    const invitationPasswordHash = `scrypt-v1$32768$8$1$${"i".repeat(24)}$${"j".repeat(88)}`;
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_invitation($1,$2,$3,$4,$5,$6)",
      [
        invitationTokenHash,
        invitationPasswordHash,
        invitationFactorId,
        `authv1:${"f".repeat(80)}`,
        invitationSetupHash,
        randomUUID(),
      ],
    )).rowCount).toBe(1);

    const retry = await queueSignup(
      randomUUID(),
      randomUUID().replaceAll("-", "").repeat(2),
      randomUUID(),
    );
    expect(retry.rows[0]?.queued).toBe(false);
    expect((await pool.query(
      `SELECT
         (SELECT consumed_at IS NULL FROM auth_one_time_tokens WHERE token_hash=$1) AS setup_available,
         (SELECT status FROM auth_mfa_factors WHERE id=$2) AS factor_status`,
      [invitationSetupHash, invitationFactorId],
    )).rows[0]).toEqual({ setup_available: true, factor_status: "PENDING" });
    expect((await pool.query(
      "SELECT app.auth_finish_mfa_enrollment($1,$2,1,$3) AS finished",
      [invitationSetupHash, invitationFactorId, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query(
      "SELECT active FROM organization_memberships WHERE id=$1",
      [invitedMembershipId],
    )).rows[0]?.active).toBe(true);
  });
});
