import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(join(process.cwd(), "deploy", "postgres", "010-runtime-role.sh"), "utf8");

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
  });

  it("revokes inherited function execution and restores only reviewed app APIs", () => {
    expect(script).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC");
    expect(script).toContain("app.auth_email_delivery_readiness(integer)");
    expect(script).toContain("app.auth_issue_demo_session(text,text,text,text,text,text)");
    expect(script).toContain("app.auth_mark_demo_step_up(uuid,text)");
    expect(script).toContain("app.auth_begin_organization_signup(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,accounting_profile,integer,manual_posting_mode,text,text,text,text,uuid,text,text,text)");
    expect(script).toContain("app.auth_consume_signup_accept_limits(text)");
    expect(script).toContain("app.auth_accept_organization_signup(text,text,uuid,text,text,text)");
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
    expect(script).not.toContain("app.organization_admin_authorize(text,boolean)");
    expect(script).not.toContain("app.reset_demo_sandbox_extensions(uuid,uuid)");
    expect(script).not.toContain("'app.auth_issue_user_session(");
  });

  it("accepts a mounted password secret without placing it on the psql command line", () => {
    expect(script).toContain("APP_DATABASE_PASSWORD_FILE");
    expect(script).toContain("\\getenv app_password BUSINESS_FINLYNQ_RECONCILE_PASSWORD");
    expect(script).not.toContain("--set=app_password=");
  });
});
