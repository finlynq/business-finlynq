import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(join(
  process.cwd(),
  "migrations",
  "drizzle",
  "0050_entra_sso.sql",
), "utf8");

describe("OIDC session migration", () => {
  it("adds distinct session provenance without allowing OIDC demo sessions", () => {
    expect(migration).toContain("'PASSWORD_RESET', 'OIDC'");
    expect(migration).toContain("'OIDC', 'REAL'");
    expect(migration).toContain("'LOGIN_OIDC', 'SUCCESS'");
  });

  it("keeps issuance behind a security-definer function and the runtime execute grant", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.auth_issue_oidc_user_session(");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("REVOKE ALL ON FUNCTION app.auth_issue_oidc_user_session(");
    expect(migration).toContain("TO business_finlynq_app");
    expect(migration).toContain("selected_user.email_verified_at IS NOT NULL");
  });

  it("retains local MFA step-up for privileged actions with OIDC provenance", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.organization_admin_authorize(");
    expect(migration).toContain("NOT IN ('password+mfa', 'oidc+mfa')");
    expect(migration).toContain("selected_session.step_up_expires_at <= now()");
  });
});
