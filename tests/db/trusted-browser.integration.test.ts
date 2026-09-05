import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const ownerUrl = process.env.TEST_DATABASE_URL;
const runtimeUrl = process.env.TEST_APP_DATABASE_URL;
const runDatabaseTests = ownerUrl ? describe : describe.skip;

type Fixture = Readonly<{
  organizationId: string;
  userId: string;
  membershipId: string;
  factorId: string;
  sessionId: string;
}>;

const integrationRunId = randomUUID();

function digest(label: string): string {
  return createHash("sha256")
    .update(integrationRunId + "|" + label)
    .digest("hex");
}

runDatabaseTests("trusted-browser database boundaries", () => {
  const owner = new Pool({ connectionString: ownerUrl, max: 8 });
  const runtime = runtimeUrl ? new Pool({ connectionString: runtimeUrl, max: 4 }) : null;
  const root: Fixture = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    membershipId: randomUUID(),
    factorId: randomUUID(),
    sessionId: randomUUID(),
  };
  const outsider: Fixture = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    membershipId: randomUUID(),
    factorId: randomUUID(),
    sessionId: randomUUID(),
  };
  const rootRoleId = randomUUID();
  const secondaryRoleId = randomUUID();

  async function issueTrust(fixture: Fixture, label: string) {
    const factor = await owner.query<{ next_counter: string }>(
      "SELECT (coalesce(last_accepted_counter,-1)+1)::text AS next_counter FROM auth_mfa_factors WHERE id=$1",
      [fixture.factorId],
    );
    const tokenHash = digest("trusted-token|" + label);
    const userAgentHash = digest("trusted-agent|" + label);
    const result = await owner.query<{
      session_id: string;
      trusted_browser_id: string;
      trusted_browser_expires_at: Date;
    }>(
      "SELECT * FROM app.auth_issue_mfa_user_session_trusted($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        fixture.userId,
        fixture.organizationId,
        fixture.membershipId,
        fixture.factorId,
        Number(factor.rows[0]?.next_counter),
        digest("trusted-session|" + label),
        tokenHash,
        digest("trusted-ip|" + label),
        userAgentHash,
        "Chrome on Linux",
        "trusted-enroll|" + label,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Trusted-browser enrollment failed for " + label);
    return {
      sessionId: row.session_id,
      trustedBrowserId: row.trusted_browser_id,
      expiresAt: row.trusted_browser_expires_at,
      tokenHash,
      userAgentHash,
    };
  }

  async function setContext(client: PoolClient, fixture: Fixture, requestId: string) {
    await client.query("SELECT set_config('app.organization_id',$1,true)", [fixture.organizationId]);
    await client.query("SELECT set_config('app.actor_id',$1,true)", [fixture.userId]);
    await client.query("SELECT set_config('app.session_id',$1,true)", [fixture.sessionId]);
    await client.query("SELECT set_config('app.session_mode','real',true)");
    await client.query("SELECT set_config('app.auth_method','password+mfa',true)");
    await client.query("SELECT set_config('app.request_id',$1,true)", [requestId]);
    await client.query("SELECT set_config('app.source_surface','UI',true)");
    await client.query("SELECT set_config('app.reason','Trusted browser policy integration validation',true)");
  }

  async function updatePolicy(
    fixture: Fixture,
    enabled: boolean,
    durationDays: 7 | 30 | 90,
    expectedVersion: number,
    requestId: string,
  ): Promise<number> {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await setContext(client, fixture, requestId);
      const result = await client.query<{ version: number }>(
        "SELECT app.organization_update_trusted_browser_policy($1,$2,$3) AS version",
        [enabled, durationDays, expectedVersion],
      );
      await client.query("COMMIT");
      return result.rows[0]?.version ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    await owner.query(
      "INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,trusted_browser_enabled,trusted_browser_duration_days) VALUES($1,$3,'Trusted browser tenant',true,false,'REAL',true,30),($2,$4,'Trusted browser outsider',true,false,'REAL',true,30)",
      [
        root.organizationId,
        outsider.organizationId,
        "trusted-browser-" + root.organizationId.slice(0, 8),
        "trusted-browser-" + outsider.organizationId.slice(0, 8),
      ],
    );
    await owner.query(
      "INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active,is_demo,mfa_required,email_verified_at) VALUES($1,$3,'integration-ciphertext','integration-password',true,false,true,now()),($2,$4,'integration-ciphertext','integration-password',true,false,true,now())",
      [
        root.userId,
        outsider.userId,
        digest("trusted-email|" + root.userId),
        digest("trusted-email|" + outsider.userId),
      ],
    );
    await owner.query(
      "INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,true),($4,$5,$6,true)",
      [
        root.membershipId,
        root.organizationId,
        root.userId,
        outsider.membershipId,
        outsider.organizationId,
        outsider.userId,
      ],
    );
    await owner.query(
      "INSERT INTO roles(id,organization_id,key,display_name,system_template,active) VALUES($1,$3,'OWNER','Owner',true,true),($2,$3,'SECONDARY_REVIEWER','Secondary reviewer',false,true)",
      [rootRoleId, secondaryRoleId, root.organizationId],
    );
    await owner.query(
      "INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,'organization.settings.manage')",
      [root.organizationId, rootRoleId],
    );
    await owner.query(
      "INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)",
      [root.organizationId, root.membershipId, rootRoleId, root.userId],
    );
    await owner.query(
      "INSERT INTO auth_mfa_factors(id,user_id,factor_type,label,secret_ciphertext,status,last_accepted_counter,verified_at) VALUES($1,$2,'TOTP','Primary','encrypted-factor-root','ACTIVE',10,now()),($3,$4,'TOTP','Primary','encrypted-factor-outsider','ACTIVE',10,now())",
      [root.factorId, root.userId, outsider.factorId, outsider.userId],
    );
    await owner.query(
      "INSERT INTO auth_sessions(id,token_hash,user_id,organization_id,membership_id,auth_method,session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at,mfa_verified_at,step_up_expires_at) VALUES($1,$3,$5,$7,$8,'PASSWORD','REAL',$9,7200,now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '10 minutes'),($2,$4,$6,$10,$11,'PASSWORD','REAL',$12,7200,now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '10 minutes')",
      [
        root.sessionId,
        outsider.sessionId,
        digest("trusted-context|" + root.sessionId),
        digest("trusted-context|" + outsider.sessionId),
        root.userId,
        outsider.userId,
        root.organizationId,
        root.membershipId,
        digest("trusted-context-agent-root"),
        outsider.organizationId,
        outsider.membershipId,
        digest("trusted-context-agent-outsider"),
      ],
    );
  });

  afterAll(async () => {
    await Promise.all([owner.end(), runtime?.end()]);
  });

  it("allows exactly one concurrent rotation and gives the trusted session no MFA or step-up assurance", async () => {
    const enrolled = await issueTrust(root, "concurrency");
    expect((await owner.query(
      "SELECT mfa_verified_at IS NOT NULL AS mfa,step_up_expires_at>now() AS step_up FROM auth_sessions WHERE id=$1",
      [enrolled.sessionId],
    )).rows[0]).toEqual({ mfa: true, step_up: true });

    const replacements = [
      {
        token: digest("trusted-replacement-a"),
        session: digest("trusted-reuse-session-a"),
        request: "trusted-concurrent-a",
      },
      {
        token: digest("trusted-replacement-b"),
        session: digest("trusted-reuse-session-b"),
        request: "trusted-concurrent-b",
      },
    ] as const;
    const clients = await Promise.all([owner.connect(), owner.connect()]);
    let outcomes;
    try {
      outcomes = await Promise.all(clients.map((client, index) =>
        client.query(
          "SELECT * FROM app.auth_issue_trusted_browser_user_session($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            root.userId,
            root.organizationId,
            root.membershipId,
            enrolled.tokenHash,
            replacements[index].token,
            replacements[index].session,
            digest("trusted-concurrent-ip-" + index),
            enrolled.userAgentHash,
            replacements[index].request,
          ],
        ),
      ));
    } finally {
      clients.forEach((client) => client.release());
    }
    expect(outcomes.flatMap((outcome) => outcome.rows)).toHaveLength(1);

    const record = (await owner.query(
      "SELECT token_hash,version,last_used_at FROM auth_trusted_browsers WHERE id=$1",
      [enrolled.trustedBrowserId],
    )).rows[0];
    expect(replacements.map((item) => item.token)).toContain(record?.token_hash);
    expect(record).toMatchObject({ version: 2, last_used_at: expect.any(Date) });
    expect((await owner.query(
      "SELECT auth_method,mfa_verified_at,step_up_expires_at FROM auth_sessions WHERE token_hash=ANY($1::text[])",
      [replacements.map((item) => item.session)],
    )).rows).toEqual([
      { auth_method: "PASSWORD", mfa_verified_at: null, step_up_expires_at: null },
    ]);

    const replay = await owner.query(
      "SELECT * FROM app.auth_issue_trusted_browser_user_session($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        root.userId,
        root.organizationId,
        root.membershipId,
        enrolled.tokenHash,
        digest("trusted-replay-replacement"),
        digest("trusted-replay-session"),
        digest("trusted-replay-ip"),
        enrolled.userAgentHash,
        "trusted-replay",
      ],
    );
    expect(replay.rows).toHaveLength(0);

    const crossTenant = await owner.query(
      "SELECT * FROM app.auth_issue_trusted_browser_user_session($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        outsider.userId,
        outsider.organizationId,
        outsider.membershipId,
        record?.token_hash,
        digest("trusted-cross-replacement"),
        digest("trusted-cross-session"),
        digest("trusted-cross-ip"),
        enrolled.userAgentHash,
        "trusted-cross-tenant",
      ],
    );
    expect(crossTenant.rows).toHaveLength(0);
    expect((await owner.query(
      "SELECT revoked_at FROM auth_trusted_browsers WHERE id=$1",
      [enrolled.trustedBrowserId],
    )).rows[0]?.revoked_at).toBeNull();

    const copied = await owner.query(
      "SELECT * FROM app.auth_issue_trusted_browser_user_session($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        root.userId,
        root.organizationId,
        root.membershipId,
        record?.token_hash,
        digest("trusted-copied-replacement"),
        digest("trusted-copied-session"),
        digest("trusted-copied-ip"),
        digest("different-user-agent"),
        "trusted-copied-browser",
      ],
    );
    expect(copied.rows).toHaveLength(0);
    expect((await owner.query(
      "SELECT revoked_reason FROM auth_trusted_browsers WHERE id=$1",
      [enrolled.trustedBrowserId],
    )).rows[0]?.revoked_reason).toBe("BROWSER_BINDING_CHANGED");

    if (runtime) {
      await expect(
        runtime.query("SELECT token_hash FROM auth_trusted_browsers LIMIT 1"),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("scopes management to the session user and organization and requires admin permission plus fresh step-up", async () => {
    const rootTrust = await issueTrust(root, "management-root");
    const outsiderTrust = await issueTrust(outsider, "management-outsider");
    const visible = await owner.query<{ id: string }>(
      "SELECT id FROM app.auth_trusted_browsers_for_session($1,$2)",
      [root.sessionId, "trusted-list"],
    );
    expect(visible.rows.map((row) => row.id)).toContain(rootTrust.trustedBrowserId);
    expect(visible.rows.map((row) => row.id)).not.toContain(outsiderTrust.trustedBrowserId);

    expect((await owner.query<{ revoked: boolean }>(
      "SELECT app.auth_revoke_trusted_browser($1,$2,$3) AS revoked",
      [root.sessionId, outsiderTrust.trustedBrowserId, "trusted-cross-revoke"],
    )).rows[0]?.revoked).toBe(false);
    expect((await owner.query(
      "SELECT revoked_at FROM auth_trusted_browsers WHERE id=$1",
      [outsiderTrust.trustedBrowserId],
    )).rows[0]?.revoked_at).toBeNull();

    const currentVersion = Number((await owner.query(
      "SELECT settings_version FROM organizations WHERE id=$1",
      [root.organizationId],
    )).rows[0]?.settings_version);
    const disabledVersion = await updatePolicy(
      root,
      false,
      30,
      currentVersion,
      "trusted-policy-disable",
    );
    expect(disabledVersion).toBe(currentVersion + 1);
    expect((await owner.query(
      "SELECT trusted_browser_enabled,trusted_browser_duration_days FROM organizations WHERE id=$1",
      [root.organizationId],
    )).rows[0]).toEqual({
      trusted_browser_enabled: false,
      trusted_browser_duration_days: 30,
    });
    expect((await owner.query(
      "SELECT revoked_reason FROM auth_trusted_browsers WHERE id=$1",
      [rootTrust.trustedBrowserId],
    )).rows[0]?.revoked_reason).toBe("POLICY_DISABLED");

    await expect(
      updatePolicy(outsider, false, 30, 1, "trusted-policy-no-permission"),
    ).rejects.toMatchObject({ code: "42501" });

    const enabledVersion = await updatePolicy(
      root,
      true,
      7,
      disabledVersion,
      "trusted-policy-enable",
    );
    expect(enabledVersion).toBe(disabledVersion + 1);
    expect((await owner.query(
      "SELECT count(*)::int AS count FROM auth_security_events WHERE organization_id=$1 AND event_type='TRUSTED_BROWSER_POLICY_UPDATED' AND request_id IN ('trusted-policy-disable','trusted-policy-enable')",
      [root.organizationId],
    )).rows[0]?.count).toBe(2);
  });

  it("invalidates trust after password, MFA, role, membership, admin, and logout-all changes", async () => {
    const passwordTrust = await issueTrust(root, "password-change");
    const passwordEpoch = Number((await owner.query(
      "SELECT auth_security_epoch FROM users WHERE id=$1",
      [root.userId],
    )).rows[0]?.auth_security_epoch);
    await owner.query(
      "UPDATE users SET password_hash='integration-password-rotated' WHERE id=$1",
      [root.userId],
    );
    expect((await owner.query(
      "SELECT revoked_reason FROM auth_trusted_browsers WHERE id=$1",
      [passwordTrust.trustedBrowserId],
    )).rows[0]?.revoked_reason).toBe("PASSWORD_CHANGED");
    expect(Number((await owner.query(
      "SELECT auth_security_epoch FROM users WHERE id=$1",
      [root.userId],
    )).rows[0]?.auth_security_epoch)).toBe(passwordEpoch + 1);

    const mfaTrust = await issueTrust(root, "mfa-change");
    const mfaEpoch = Number((await owner.query(
      "SELECT auth_security_epoch FROM users WHERE id=$1",
      [root.userId],
    )).rows[0]?.auth_security_epoch);
    await owner.query(
      "UPDATE auth_mfa_factors SET secret_ciphertext='encrypted-factor-root-rotated' WHERE id=$1",
      [root.factorId],
    );
    expect((await owner.query(
      "SELECT revoked_reason FROM auth_trusted_browsers WHERE id=$1",
      [mfaTrust.trustedBrowserId],
    )).rows[0]?.revoked_reason).toBe("MFA_CHANGED");
    expect(Number((await owner.query(
      "SELECT auth_security_epoch FROM users WHERE id=$1",
      [root.userId],
    )).rows[0]?.auth_security_epoch)).toBe(mfaEpoch + 1);

    const roleTrust = await issueTrust(root, "role-change");
    await owner.query(
      "DELETE FROM membership_roles WHERE organization_id=$1 AND membership_id=$2",
      [root.organizationId, root.membershipId],
    );
    expect((await owner.query(
      "SELECT revoked_reason FROM auth_trusted_browsers WHERE id=$1",
      [roleTrust.trustedBrowserId],
    )).rows[0]?.revoked_reason).toBe("ROLE_CHANGED");
    await owner.query(
      "INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)",
      [root.organizationId, root.membershipId, secondaryRoleId, root.userId],
    );

    const membershipTrust = await issueTrust(root, "membership-change");
    await owner.query(
      "UPDATE organization_memberships SET active=false WHERE id=$1",
      [root.membershipId],
    );
    expect((await owner.query(
      "SELECT revoked_reason FROM auth_trusted_browsers WHERE id=$1",
      [membershipTrust.trustedBrowserId],
    )).rows[0]?.revoked_reason).toBe("MEMBERSHIP_CHANGED");
    await owner.query(
      "UPDATE organization_memberships SET active=true WHERE id=$1",
      [root.membershipId],
    );

    const adminTrust = await issueTrust(root, "admin-revocation");
    await owner.query(
      "SELECT app.auth_revoke_membership_trusted_browsers($1,$2,'ADMIN_SESSION_REVOCATION',$3)",
      [root.organizationId, root.membershipId, "trusted-admin-revocation"],
    );
    expect((await owner.query(
      "SELECT revoked_reason FROM auth_trusted_browsers WHERE id=$1",
      [adminTrust.trustedBrowserId],
    )).rows[0]?.revoked_reason).toBe("ADMIN_SESSION_REVOCATION");

    const logoutTrust = await issueTrust(root, "logout-all");
    const logout = await owner.query<{ revoked_count: string }>(
      "SELECT app.auth_logout_all_sessions($1,$2)::text AS revoked_count",
      [logoutTrust.sessionId, "trusted-logout-all"],
    );
    expect(Number(logout.rows[0]?.revoked_count)).toBeGreaterThan(0);
    expect((await owner.query(
      "SELECT revoked_reason FROM auth_trusted_browsers WHERE id=$1",
      [logoutTrust.trustedBrowserId],
    )).rows[0]?.revoked_reason).toBe("LOGOUT_ALL");
    expect((await owner.query(
      "SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE id=$1",
      [logoutTrust.sessionId],
    )).rows[0]?.revoked).toBe(true);
  });

  it("keeps existing auth function signatures available", async () => {
    expect((await owner.query(
      "SELECT to_regprocedure('app.auth_lookup_login_v2(text)')::text AS lookup_v2,to_regprocedure('app.auth_issue_mfa_user_session(uuid,uuid,uuid,uuid,bigint,text,text,text,text)')::text AS issue_mfa,to_regprocedure('app.auth_resolve_session_v3(text,text)')::text AS resolve_v3",
    )).rows[0]).toEqual({
      lookup_v2: "app.auth_lookup_login_v2(text)",
      issue_mfa: "app.auth_issue_mfa_user_session(uuid,uuid,uuid,uuid,bigint,text,text,text,text)",
      resolve_v3: "app.auth_resolve_session_v3(text,text)",
    });
  });
});
