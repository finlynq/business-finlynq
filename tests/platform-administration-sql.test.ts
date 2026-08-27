import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/drizzle/0018_platform_administrator_grants.sql", import.meta.url),
  "utf8",
);

describe("platform administrator SQL boundary", () => {
  it("keeps grants outside tenants and gates linkage on verified real MFA identity", () => {
    const tableDefinition = migration.slice(
      migration.indexOf("CREATE TABLE platform_administrator_grants"),
      migration.indexOf("CREATE TABLE platform_administrator_grant_events"),
    );
    expect(tableDefinition).not.toContain("organization_id");
    expect(migration).toContain("NOT selected_identity.is_demo");
    expect(migration).toContain("selected_identity.email_verified_at IS NOT NULL");
    expect(migration).toContain("factor.status = 'ACTIVE'");
    expect(migration).toContain("factor.revoked_at IS NULL");
    expect(migration).toContain("UPDATE OF user_id,status,verified_at,revoked_at");
    expect(migration).toContain("selected_session.session_mode = 'REAL'");
    expect(migration).toContain("linkage requires a matching verified real identity with active MFA");
    expect(migration).toContain("IDENTITY_ASSURANCE_CONFIRMED");
    expect(migration).toContain("'authenticationEventId',NEW.id");
  });

  it("makes audit history append-only and denies direct runtime table access", () => {
    expect(migration).toContain("Platform administrator grant events are append-only");
    expect(migration).toContain("Platform administrator grants cannot be deleted");
    expect(migration).toContain("REVOKE ALL ON platform_administrator_grants");
    expect(migration).toContain("app.auth_platform_administrator_authorization(uuid,uuid)");
    expect(migration).toContain("FROM business_finlynq_auth_worker");
  });

  it("exposes only authorized aggregate control-plane metadata", () => {
    const overview = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION app.platform_administration_overview"),
      migration.indexOf("REVOKE ALL ON platform_administrator_grants"),
    );
    expect(overview).toContain("app.auth_platform_administrator_authorization(");
    expect(overview).toContain("active_real_organization_count bigint");
    expect(overview).toContain("active_real_user_count bigint");
    expect(overview).toContain("active_real_session_count bigint");
    expect(overview).toContain("pending_platform_administrator_count bigint");
    expect(overview).not.toContain("email_ciphertext");
    expect(overview).not.toContain("display_name");
    expect(overview).not.toContain("journal");
    expect(migration).toContain("app.platform_administration_overview(uuid,uuid)");
    expect(migration).toContain("FROM business_finlynq_auth_worker");
  });
});
