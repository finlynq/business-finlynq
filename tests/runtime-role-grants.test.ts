import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(join(process.cwd(), "deploy", "postgres", "010-runtime-role.sh"), "utf8");
const authWorkerScript = readFileSync(
  join(process.cwd(), "deploy", "postgres", "015-auth-worker-role.sh"),
  "utf8",
);
const backupRoleScript = readFileSync(
  join(process.cwd(), "deploy", "postgres", "020-backup-role.sh"),
  "utf8",
);

describe("runtime role reconciliation contract", () => {
  it("removes blanket current and future CRUD before reviewed grants", () => {
    expect(script).toContain("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM business_finlynq_app");
    expect(script).toContain("REVOKE ALL ON TABLES FROM business_finlynq_app");
    expect(script).toContain("REVOKE ALL ON SEQUENCES FROM business_finlynq_app");
    expect(script).not.toMatch(/GRANT\s+SELECT\s*,\s*INSERT\s*,\s*UPDATE\s*,\s*DELETE\s+ON\s+ALL\s+TABLES/i);
    expect(script).not.toMatch(/GRANT\s+USAGE\s*,\s*SELECT\s+ON\s+ALL\s+SEQUENCES/i);
  });

  it("keeps destructive ledger-policy and party access outside the web role", () => {
    expect(script).toContain("No application table receives DELETE");
    expect(script).not.toMatch(/GRANT\s+DELETE/i);
    expect(script).toContain("'ledger_posting_policies'");
    expect(script).toContain("'parties', 'party_addresses'");
    expect(script).not.toContain("'platform_administrator_grants'");
    expect(script).not.toContain("'platform_administrator_grant_events'");
    for (const table of [
      "bank_connections", "bank_connection_credential_events", "bank_external_accounts", "bank_sync_runs",
      "bank_observations", "bank_observation_versions", "bank_balance_anchors",
      "bank_reconciliation_sessions", "bank_reconciliation_voids", "bank_match_allocations",
      "bank_match_allocation_voids", "bank_rules", "bank_rule_runs",
      "bank_draft_proposals",
    ]) expect(script).toContain(`'${table}'`);
  });

  it("revokes inherited function execution and restores only reviewed app APIs", () => {
    expect(script).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC");
    expect(script).toContain("app.auth_email_delivery_readiness(integer)");
    expect(script).toContain("app.auth_issue_demo_session(text,text,text,text,text,text)");
    expect(script).toContain("app.auth_mark_demo_step_up(uuid,text)");
    expect(script).toContain("app.auth_begin_organization_signup(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,accounting_profile,integer,manual_posting_mode,text,text,text,text,uuid,text,text,text)");
    expect(script).toContain("app.auth_consume_signup_accept_limits(text)");
    expect(script).toContain("app.auth_accept_organization_signup(text,text,uuid,text,text,text)");
    for (const signature of [
      "app.auth_skip_mfa_enrollment(text,text)",
      "app.auth_issue_password_user_session(uuid,uuid,uuid,text,text,text,text)",
      "app.auth_mfa_status_for_session(uuid)",
      "app.auth_begin_session_mfa_enrollment(uuid,uuid,text,text,text)",
      "app.auth_finish_session_mfa_enrollment(uuid,text,uuid,bigint,text,text)",
      "app.auth_password_for_session(uuid)",
      "app.auth_record_session_reauthentication_failure(uuid,text)",
      "app.auth_finish_password_reset_with_mfa(text,text,uuid,bigint,text)",
    ]) expect(script).toContain(signature);
    expect(script).toContain("app.assert_current_demo_session_lease()");
    expect(script).toContain("app.auth_lookup_login(text)");
    expect(script).toContain("app.auth_resolve_session(text,text)");
    expect(script).toContain("app.auth_platform_administrator_authorization(uuid,uuid)");
    expect(script).toContain("app.platform_administration_overview(uuid,uuid)");
    expect(script).toContain("app.organization_settings_read()");
    expect(script).toContain("app.organization_members_read()");
    expect(script).toContain("app.organization_update_settings(text,integer)");
    expect(script).toContain("app.organization_invite_member(uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,text)");
    expect(script).toContain("app.organization_resend_invitation(uuid,integer,uuid,text,uuid,text)");
    expect(script).toContain("app.organization_cancel_invitation(uuid,integer)");
    expect(script).toContain("app.organization_assign_member_role(uuid,uuid,integer)");
    expect(script).toContain("app.organization_set_member_active(uuid,integer,boolean)");
    expect(script).toContain("app.organization_revoke_member_sessions(uuid)");
    expect(script).toContain("app.accounting_add_tax_registration(uuid,uuid,text,text,integer,text,text,text,text,text,date,date)");
    expect(script).not.toContain("app.organization_admin_authorize(text,boolean)");
    expect(script).not.toContain("app.reset_demo_sandbox_extensions(uuid,uuid)");
    expect(script).not.toContain("'app.auth_issue_user_session(");
  });

  it("accepts a mounted password secret without placing it on the psql command line", () => {
    expect(script).toContain("APP_DATABASE_PASSWORD_FILE");
    expect(script).toContain("\\getenv app_password BUSINESS_FINLYNQ_RECONCILE_PASSWORD");
    expect(script).not.toContain("--set=app_password=");
  });

  it("scrubs both role-membership directions and verifies the runtime identity", () => {
    expect(script).toContain("REVOKE %I FROM business_finlynq_app");
    expect(script).toContain("REVOKE business_finlynq_app FROM %I");
    expect(script).toContain("FROM pg_auth_members");
    expect(script).toContain("WHERE member = selected_role OR roleid = selected_role");
    expect(script).toContain("runtime role must have no inbound or outbound role memberships");
    expect(script).toContain("NOINHERIT NOREPLICATION NOBYPASSRLS");
  });

  it("removes legacy database/schema authority before granting runtime connect and usage", () => {
    expect(script).toContain(
      'REVOKE ALL PRIVILEGES ON DATABASE :"db_name" FROM business_finlynq_app',
    );
    expect(script).toContain(
      "REVOKE ALL PRIVILEGES ON SCHEMA public FROM business_finlynq_app",
    );
    expect(script).toContain("REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC");
    expect(script).toContain(
      "REVOKE ALL PRIVILEGES ON SCHEMA app FROM business_finlynq_app",
    );
    expect(script).toContain("runtime database privileges are unsafe");
    expect(script).toContain("runtime public-schema privileges are unsafe");
    expect(script).toContain("runtime app-schema privileges are unsafe");
    expect(script).toContain("'TEMPORARY'");
  });

  it("applies the same membership scrub and assertion to the auth worker", () => {
    expect(authWorkerScript).toContain("REVOKE %I FROM business_finlynq_auth_worker");
    expect(authWorkerScript).toContain("REVOKE business_finlynq_auth_worker FROM %I");
    expect(authWorkerScript).toContain("FROM pg_auth_members");
    expect(authWorkerScript).toContain("WHERE member = selected_role OR roleid = selected_role");
    expect(authWorkerScript).toContain(
      "authentication worker role must have no inbound or outbound role memberships",
    );
  });

  it("removes legacy database/schema authority from the auth worker", () => {
    expect(authWorkerScript).toContain(
      "REVOKE ALL PRIVILEGES ON DATABASE %I FROM business_finlynq_auth_worker",
    );
    expect(authWorkerScript).toContain(
      "REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC",
    );
    expect(authWorkerScript).toContain(
      "REVOKE ALL PRIVILEGES ON SCHEMA public FROM business_finlynq_auth_worker",
    );
    expect(authWorkerScript).toContain(
      "REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC",
    );
    expect(authWorkerScript).toContain(
      "REVOKE ALL PRIVILEGES ON SCHEMA app FROM business_finlynq_auth_worker",
    );
    expect(authWorkerScript).toContain("authentication worker database privileges are unsafe");
    expect(authWorkerScript).toContain("authentication worker public-schema privileges are unsafe");
    expect(authWorkerScript).toContain("authentication worker app-schema privileges are unsafe");
    expect(authWorkerScript).toContain(
      "has_schema_privilege('business_finlynq_auth_worker', 'public', 'USAGE')",
    );
  });

  it("grants the backup verifier only its exact audit digest capability", () => {
    expect(backupRoleScript).toContain(
      "REVOKE EXECUTE ON FUNCTION public.digest(text, text) FROM PUBLIC",
    );
    expect(backupRoleScript).toContain(
      "GRANT EXECUTE ON FUNCTION public.digest(text, text) TO business_finlynq_backup",
    );
    expect(backupRoleScript).toContain(
      "WHERE to_regprocedure('public.digest(text,text)') IS NOT NULL",
    );
    expect(backupRoleScript).toContain("routine.oid IS DISTINCT FROM audit_digest");
    expect(backupRoleScript).toContain("to_regclass('public.audit_events') IS NOT NULL");
    expect(backupRoleScript).toContain("audit schema exists without the required digest function");
    expect(backupRoleScript).toContain("backup role is missing the audit digest capability");
    expect(backupRoleScript).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+ALL\s+(?:FUNCTIONS|ROUTINES)/i);
  });
});
