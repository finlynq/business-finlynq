import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0014_organization_member_administration.sql"),
  "utf8",
);
const coexistenceMigration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0016_signup_invitation_coexistence.sql"),
  "utf8",
);
const demoReset = readFileSync(
  join(process.cwd(), "src", "modules", "onboarding", "demo-bootstrap.ts"),
  "utf8",
);
const runtimeGrants = readFileSync(
  join(process.cwd(), "deploy", "postgres", "010-runtime-role.sh"),
  "utf8",
);

describe("organization administration database boundary", () => {
  it("adds explicit settings/member permissions and a fixed organization-admin role", () => {
    expect(migration).toContain("'organization.settings.read'");
    expect(migration).toContain("'organization.settings.manage'");
    expect(migration).toContain("'organization.members.read'");
    expect(migration).toContain("'organization.members.manage'");
    expect(migration).toContain("'ORGANIZATION_ADMIN'");
    expect(migration).toContain("system_template");
  });

  it("keeps identity writes behind scoped security-definer functions with real MFA and demo lease checks", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.organization_admin_authorize");
    expect(migration).toContain("selected_session.step_up_expires_at");
    expect(migration).toContain("current_setting('app.auth_method', true), '') <> 'password+mfa'");
    expect(migration).toContain("PERFORM app.assert_current_demo_session_lease()");
    expect(migration).toContain("REVOKE ALL ON organization_invitations FROM business_finlynq_app");
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE).*organization_invitations/i);
  });

  it("enforces retained identity history and last-owner/recovery safeguards", () => {
    expect(migration).toContain("The last active owner cannot be suspended");
    expect(migration).toContain("The last active recovery administrator cannot be suspended");
    expect(migration).toContain("Administrators cannot change their own fixed role");
    expect(migration).toContain("current_role_has_owner");
    expect(migration).toContain("current_role_has_recovery");
    expect(migration).toContain("Recovery-administration permission is required for this member status change");
    expect(migration).toContain("Recovery-administration permission is required to revoke these sessions");
    expect(migration).toContain("UPDATE auth_sessions SET revoked_at");
    expect(migration).not.toContain("organization_delete_member");
    expect(migration).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(migration).toContain("'organization-administration|' || selected_organization_id::text");
  });

  it("canonicalizes historical multi-role memberships and enforces one visible fixed role", () => {
    expect(migration).toContain("WITH ranked_assignment AS (");
    expect(migration).toContain("ranked.keep_rank > 1");
    expect(migration).toContain("CREATE UNIQUE INDEX membership_roles_one_fixed_role_unique");
    expect(migration).toContain("current_role_count = 1");
    expect(migration).not.toContain("current_role roles%ROWTYPE");
  });

  it("can reissue a cancelled invitation without deleting its retained identity", () => {
    expect(migration).toContain("selected_invitation.status NOT IN ('PENDING', 'CANCELLED')");
    expect(migration).toContain("status = 'PENDING'");
    expect(migration).toContain("cancelled_at = NULL");
    expect(migration).toContain("consumed_at = coalesce(consumed_at, now())");
  });

  it("backfills the latest pre-administration invitation without losing interrupted MFA", () => {
    expect(migration).toContain("WITH legacy_invitation AS (");
    expect(migration).toContain("DISTINCT ON (membership.organization_id, membership.id)");
    expect(migration).toContain("THEN 'ACCEPTED' ELSE 'PENDING' END");
    expect(migration).toContain("legacy.invited_by_user_id");
    expect(migration).toContain("legacy.created_at, coalesce(legacy.consumed_at, legacy.created_at)");
    expect(migration).toContain("legacy.email_verified AND legacy.has_active_mfa");
  });

  it("recovers only an inactive invitation enrollment and serializes acceptance with reissue", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.auth_accept_invitation");
    expect(migration).toContain("selected_identity.password_hash LIKE 'scrypt-v1$32768$8$1$%'");
    expect(migration).toContain("password_hash = '!invitation-pending!'");
    expect(migration).toContain("password_changed_at = NULL");
    expect(migration).toContain("email_verified_at = NULL");
    expect(migration).toContain("An enrolled identity cannot be reset by invitation administration");
    expect(migration).toContain("'ORGANIZATION_INVITATION_REISSUED'");
    expect(migration).toContain("last_error_code = 'SUPERSEDED_BY_INVITATION'");
  });

  it("shares the deterministic account identity lock but never lets an invitation repurpose an existing identity", () => {
    expect(migration).toContain("'business-finlynq|account-user|' || selected_email_lookup_hash");
    expect(migration).toContain("IF existing_identity.id IS NOT NULL THEN");
    expect(migration).toContain("Invitation administration never repurposes any identity");
    expect(migration).toContain("organization_memberships_one_active_user_unique");
    expect(migration).toContain("CREATE TRIGGER organization_signup_cancels_unused_invitation");
    expect(migration).toContain("OLD.status = 'PENDING' AND NEW.status = 'ENROLLING'");
    expect(migration).toContain("signup.status IN ('ENROLLING', 'ACTIVE')");
  });

  it("makes verified-signup precedence irreversible across organizations", () => {
    expect(migration).toContain("status IN ('PENDING', 'ACCEPTED', 'CANCELLED', 'SUPERSEDED')");
    expect(migration).toContain("status = 'SUPERSEDED'");
    expect(migration).toContain("member_invitation.status <> 'ACCEPTED'");
    expect(migration).toContain("The identity already has active access to another organization");
    expect(migration).toContain("organization_memberships_one_active_user_unique");
  });

  it("makes demo invitations local and includes their identities in the nightly reset extension", () => {
    expect(migration).toContain("Demo invitations must remain synthetic and local");
    expect(coexistenceMigration).toContain("Demo sandbox member limit of 32 reached");
    expect(coexistenceMigration).toMatch(/selected_organization\.is_demo[\s\S]*?count\(\*\)[\s\S]*?organization_memberships[\s\S]*?>= 32/);
    expect(migration).toContain("'organization_invitations'");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.reset_demo_sandbox_extensions");
    expect(migration).toContain("settings_version = 1");
    expect(migration).toContain("selected_user.id = ANY(extra_user_ids)");
  });

  it("keeps replica mode scoped to business purges and runs identity cleanup after triggers return to origin", () => {
    const replica = demoReset.indexOf("SET LOCAL session_replication_role = replica");
    const origin = demoReset.indexOf("SET LOCAL session_replication_role = origin", replica);
    const extension = demoReset.indexOf("SELECT app.reset_demo_sandbox_extensions($1, $2)", origin);
    expect(replica).toBeGreaterThan(0);
    expect(origin).toBeGreaterThan(replica);
    expect(extension).toBeGreaterThan(origin);
    expect(migration).not.toContain("DELETE FROM auth_security_events");
    expect(migration).toMatch(/IF NOT selected_organization\.is_demo THEN\s+INSERT INTO auth_security_events/);
    expect(migration).toContain("DELETE FROM organization_memberships");
    expect(migration).toContain("DELETE FROM users selected_user");
    expect(runtimeGrants).not.toContain("app.reset_demo_sandbox_extensions(uuid,uuid)");
  });
});

function functionDefinition(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION app.${name}(`);
  expect(start, `${name} definition start`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `${name} definition end`).toBeGreaterThan(start);
  return sql.slice(start, end + 4);
}

describe("signup and invitation coexistence forward migration", () => {
  it("reuses only an untouched pending or expired signup identity without rewriting ciphertext", () => {
    const invite = functionDefinition(coexistenceMigration, "organization_invite_member");
    expect(invite).toContain("'business-finlynq|account-user|' || selected_email_lookup_hash");
    expect(invite).toContain("existing_identity.password_hash <> '!organization-signup-pending!'");
    expect(invite).toContain("signup.status IN ('PENDING', 'EXPIRED')");
    expect(invite).toContain("signup.accepted_at IS NULL");
    expect(invite).toContain("signup.completed_at IS NULL");
    expect(invite).toContain("factor.status IN ('PENDING', 'ACTIVE')");
    expect(invite).toContain("effective_user_id := existing_identity.id");
    expect(invite).not.toMatch(/UPDATE users SET\s+email_ciphertext = selected_email_ciphertext/);
  });

  it("serializes both verified acceptance paths and keeps their loser terminal", () => {
    const acceptInvitation = functionDefinition(coexistenceMigration, "auth_accept_invitation");
    const beginSignup = functionDefinition(coexistenceMigration, "auth_begin_organization_signup");
    expect(acceptInvitation).toContain("'!organization-signup-pending!'");
    expect(acceptInvitation).toContain("status = 'SUPERSEDED'");
    expect(acceptInvitation).toContain("last_error_code = 'SUPERSEDED_BY_INVITATION'");
    expect(beginSignup).toContain("foreign_membership_conflict");
    expect(beginSignup).toContain("invitation.status NOT IN ('PENDING', 'CANCELLED')");
    expect(beginSignup).toContain("invitation.status <> 'SUPERSEDED'");
  });

  it("checks recovery authority only after locking each target invitation", () => {
    for (const name of ["organization_resend_invitation", "organization_cancel_invitation"]) {
      const definition = functionDefinition(coexistenceMigration, name);
      const lock = definition.indexOf("FOR UPDATE;");
      const recovery = definition.indexOf("Recovery-administration permission is required for this invitation");
      expect(lock).toBeGreaterThan(0);
      expect(recovery).toBeGreaterThan(lock);
      expect(definition).toContain("permission_key = 'organization.recovery.manage'");
    }
  });

  it("re-applies explicit runtime grants without exposing internal administration helpers", () => {
    const grantBlock = coexistenceMigration.slice(coexistenceMigration.lastIndexOf("DO $$"));
    expect(coexistenceMigration).toContain("REVOKE ALL ON FUNCTION app.organization_invite_member(");
    expect(grantBlock).toContain("GRANT EXECUTE ON FUNCTION");
    expect(grantBlock).toContain("app.organization_invite_member(");
    expect(grantBlock).toContain("app.auth_accept_invitation(");
    expect(grantBlock).toContain("app.auth_begin_organization_signup(");
  });
});
