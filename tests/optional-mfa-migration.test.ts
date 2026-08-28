import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0023_optional_authenticator_enrollment.sql"),
  "utf8",
);

const signatures = [
  "app.auth_skip_mfa_enrollment(text, text)",
  "app.auth_issue_password_user_session(uuid, uuid, uuid, text, text, text, text)",
  "app.auth_mfa_status_for_session(uuid)",
  "app.auth_begin_session_mfa_enrollment(uuid, uuid, text, text, text)",
  "app.auth_finish_session_mfa_enrollment(uuid, text, uuid, bigint, text, text)",
  "app.auth_password_for_session(uuid)",
  "app.auth_record_session_reauthentication_failure(uuid, text)",
  "app.auth_finish_password_reset_with_mfa(text, text, uuid, bigint, text)",
  "app.organization_set_member_active(uuid, integer, boolean)",
] as const;

describe("optional authenticator migration", () => {
  it("defines narrowly scoped security-definer APIs and denies public execution", () => {
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(signatures.length);
    expect(migration.match(/SET search_path = public, pg_temp/g)).toHaveLength(signatures.length);
    for (const signature of signatures) expect(migration).toContain(signature);
    expect(migration).toContain("FROM PUBLIC");
  });

  it("keeps password sessions below the MFA and step-up boundary", () => {
    expect(migration).toContain("AND NOT selected_user.mfa_required");
    expect(migration).toContain("AND factor.status = 'ACTIVE'");
    expect(migration).toContain("'PASSWORD', 'REAL'");
    expect(migration).toContain("now() + interval '24 hours', NULL, NULL");
    expect(migration).toContain("FOR UPDATE OF selected_user");
  });

  it("requires a live password-only session for reauthentication and later enrollment", () => {
    expect(migration).toContain("AND selected_session.auth_method = 'PASSWORD'");
    expect(migration).toContain("'MFA_ENROLLMENT_REAUTH', 'FAILURE'");
    expect(migration).toContain("'MFA_ENROLLMENT_STARTED', 'SUCCESS'");
    expect(migration).toContain("selected_session.revoked_at IS NULL");
    expect(migration).toContain("selected_session.idle_expires_at > now()");
  });

  it("revokes sibling sessions and atomically rotates the confirming session after MFA activation", () => {
    expect(migration).toContain("AND id <> selected_session_id");
    expect(migration).toContain("token_hash = selected_replacement_session_token_hash");
    expect(migration).toContain("mfa_verified_at = now()");
    expect(migration).toContain("step_up_expires_at = now() + interval '10 minutes'");
    expect(migration).toContain("last_accepted_counter = selected_totp_counter");
    expect(migration).toContain("reset_token.purpose = 'PASSWORD_RESET'");
    expect(migration).toContain("recovery.status IN ('PENDING', 'APPROVED')");
    expect(migration).toContain("last_error_code = 'INVALIDATED_BY_MFA_ENROLLMENT'");
  });

  it("keeps factorless protected recovery consistent with MFA login", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.auth_finish_password_reset_with_mfa");
    expect(migration).toContain("mfa_required = true");
    expect(migration).toContain("'PASSWORD_RESET_MFA_REPLACED', 'SUCCESS'");
    expect(migration).toContain("'mfaRequired', true");
  });

  it("reactivates only consistent MFA or password-only identities without weakening administrator controls", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.organization_set_member_active");
    expect(migration).toContain("app.organization_admin_authorize('organization.members.manage', true)");
    expect(migration).toContain("app.organization_member_is_last_owner");
    expect(migration).toContain("app.organization_member_is_last_recovery_admin");
    expect(migration).toContain("selected_membership.administration_version <> expected_version");
    expect(migration).toContain("selected_user.mfa_required IS TRUE");
    expect(migration).toContain("selected_user.mfa_required IS FALSE");
    expect(migration).toContain("selected_user.password_hash NOT LIKE 'scrypt-v1$32768$8$1$%'");
    expect(migration).toContain("factor.verified_at IS NOT NULL");
    expect(migration).toContain("factor.revoked_at IS NULL");
    expect(migration).toContain("'The member authentication state is inconsistent'");
    expect(migration).toContain("UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())");
    expect(migration).toContain("'organization.member-reactivated'");
  });
});
