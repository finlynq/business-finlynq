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
  });

  it("revokes inherited function execution and restores only reviewed app APIs", () => {
    expect(script).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC");
    expect(script).toContain("app.auth_email_delivery_readiness(integer)");
    expect(script).toContain("app.auth_issue_demo_session(text,text,text,text,text,text)");
    expect(script).toContain("app.auth_mark_demo_step_up(uuid,text)");
    expect(script).toContain("app.assert_current_demo_session_lease()");
    expect(script).toContain("app.auth_lookup_login(text)");
    expect(script).toContain("app.auth_resolve_session(text,text)");
    expect(script).not.toContain("'app.auth_issue_user_session(");
  });

  it("accepts a mounted password secret without placing it on the psql command line", () => {
    expect(script).toContain("APP_DATABASE_PASSWORD_FILE");
    expect(script).toContain("\\getenv app_password BUSINESS_FINLYNQ_RECONCILE_PASSWORD");
    expect(script).not.toContain("--set=app_password=");
  });
});
