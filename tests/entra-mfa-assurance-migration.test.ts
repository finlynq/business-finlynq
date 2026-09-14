import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "migrations/drizzle/0052_entra_mfa_assurance.sql",
  "utf8",
);

describe("Entra MFA assurance migration", () => {
  it("accepts only the bounded application-verified assurance enum", () => {
    expect(migration).toContain(
      "selected_mfa_assurance NOT IN ('NONE', 'AMR_MFA', 'AUTH_CONTEXT')",
    );
    expect(migration).toContain("step_up_expires_at = selected_session.expires_at");
    expect(migration).toContain("selected_session.auth_method = 'OIDC'");
  });

  it("keeps unassured signup on local enrollment and audits assured activation", () => {
    expect(migration).toContain("IF selected_mfa_assurance = 'NONE' THEN");
    expect(migration).toContain("'ORGANIZATION_SIGNUP_ACTIVATED'");
    expect(migration).toContain("'mfaAssurance', selected_mfa_assurance");
    expect(migration).toContain("NULL::uuid");
  });

  it("removes direct app access to the legacy unassured overloads", () => {
    expect(migration).toContain("REVOKE EXECUTE ON FUNCTION app.auth_issue_oidc_user_session(");
    expect(migration).toContain("FROM business_finlynq_app");
  });
});
