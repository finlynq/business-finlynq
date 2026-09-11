import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(join(
  process.cwd(),
  "migrations",
  "drizzle",
  "0051_entra_signup.sql",
), "utf8");

describe("Microsoft owner signup migration", () => {
  it("binds the immutable issuer, tenant, and object identifier without email matching", () => {
    expect(migration).toContain('CREATE TABLE "auth_oidc_identities"');
    expect(migration).toContain('"auth_oidc_identities_source_unique"');
    expect(migration).toContain('"auth_oidc_identities_user_unique"');
    expect(migration).toContain("identity.issuer = selected_issuer");
    expect(migration).toContain("identity.external_tenant_id = selected_external_tenant_id");
    expect(migration).toContain("identity.external_principal_id = selected_external_principal_id");
    expect(migration).toContain("signup.oidc_external_principal_id = selected_external_principal_id");
    expect(migration).not.toMatch(/identity\.email|selected_email.*oidc|oidc.*email_lookup_hash/i);
  });

  it("keeps identity rows owner-only and exposes only bounded security-definer APIs", () => {
    expect(migration).toContain("ALTER TABLE auth_oidc_identities FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON auth_oidc_identities FROM PUBLIC");
    for (const name of [
      "auth_configure_organization_signup_oidc",
      "auth_accept_local_organization_signup",
      "auth_resolve_oidc_identity",
      "auth_accept_oidc_organization_signup",
    ]) {
      expect(migration).toContain(`FUNCTION app.${name}(`);
    }
    expect(migration.match(/SECURITY DEFINER/g)?.length).toBe(4);
  });

  it("prevents a verification URL edit from downgrading an Entra-bound signup", () => {
    expect(migration).toContain("app.auth_accept_local_organization_signup(");
    expect(migration).toContain("AND signup.oidc_issuer IS NULL");
    expect(migration).toContain("AND signup.oidc_external_tenant_id IS NULL");
    expect(migration).toContain("AND signup.oidc_external_principal_id IS NULL");
    expect(migration).toContain("AND signup.oidc_credential_hash IS NULL");
  });

  it("supports Microsoft-only and dual-mode credentials without storing a Microsoft password", () => {
    expect(migration).toContain("selected_password_enabled boolean");
    expect(migration).toContain("password_hash = '!oidc-only!'");
    expect(migration).toContain("'passwordEnabled', selected_password_enabled");
    expect(migration).toContain("'OIDC_IDENTITY_LINKED', 'SUCCESS'");
  });
});
