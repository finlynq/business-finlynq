import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0048_trusted_browser_mfa.sql"),
  "utf8",
);
const reconciler = readFileSync(
  join(process.cwd(), "deploy", "postgres", "010-runtime-role.sh"),
  "utf8",
);

describe("trusted-browser MFA migration", () => {
  it("stores only a constrained token digest behind owner-only FORCE RLS", () => {
    expect(migration).toContain('CREATE TABLE "auth_trusted_browsers"');
    expect(migration).toContain('"token_hash" text NOT NULL');
    expect(migration).not.toMatch(/raw_token|token_ciphertext|cookie_value/);
    expect(migration).toContain("auth_trusted_browsers_token_hash_check");
    expect(migration).toContain("^[0-9a-f]{64}$");
    expect(migration).toContain("auth_trusted_browsers_owner_only_policy");
    expect(migration).toContain("ALTER TABLE auth_trusted_browsers FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON auth_trusted_browsers FROM PUBLIC");
  });

  it("binds trust to the password-selected user, tenant, membership, browser, and security epoch", () => {
    expect(migration).toContain("selected_browser.user_id IS DISTINCT FROM selected_user_id");
    expect(migration).toContain("selected_browser.organization_id IS DISTINCT FROM selected_organization_id");
    expect(migration).toContain("selected_browser.membership_id IS DISTINCT FROM selected_membership_id");
    expect(migration).toContain("selected_browser.user_agent_hash <> selected_user_agent_hash");
    expect(migration).toContain("selected_browser.security_epoch <> selected_security_epoch");
    expect(migration).toContain("organization.trusted_browser_enabled");
    expect(migration).toContain("candidate.token_hash = selected_trusted_browser_token_hash");
  });

  it("serializes and rotates every successful use before issuing a session", () => {
    const lock = migration.indexOf("WHERE candidate.token_hash = selected_trusted_browser_token_hash\n  FOR UPDATE");
    const rotation = migration.indexOf("token_hash = selected_replacement_trusted_browser_token_hash");
    const session = migration.indexOf("selected_session_token_hash, selected_user_id", rotation);
    expect(lock).toBeGreaterThan(0);
    expect(rotation).toBeGreaterThan(lock);
    expect(session).toBeGreaterThan(rotation);
    expect(migration).toContain("AND token_hash = selected_trusted_browser_token_hash");
    expect(migration).toContain("'tokenRotated', true");
  });

  it("keeps trusted login below the MFA and step-up boundary", () => {
    expect(migration).toContain("'PASSWORD', 'REAL'");
    expect(migration).toContain("now() + interval '24 hours', NULL, NULL");
    expect(migration).toContain("'loginMfaSkipped', true");
    expect(migration).toContain("'mfaVerifiedAt', NULL");
    expect(migration).toContain("'stepUpExpiresAt', NULL");
  });

  it("invalidates trust for password, MFA, membership, role, admin, and logout-all changes", () => {
    expect(migration).toContain("users_auth_security_epoch_guard");
    expect(migration).toContain("NEW.password_hash IS DISTINCT FROM OLD.password_hash");
    expect(migration).toContain("auth_mfa_factors_trusted_browser_invalidation");
    expect(migration).toContain("organization_memberships_trusted_browser_invalidation");
    expect(migration).toContain("membership_roles_trusted_browser_invalidation");
    expect(migration).toContain("'ADMIN_SESSION_REVOCATION'");
    expect(migration).toContain("app.auth_logout_all_sessions");
    expect(migration).toContain("'LOGOUT_ALL'");
  });

  it("records create, use, expiry, revocation, and policy events in the immutable auth log", () => {
    for (const event of [
      "TRUSTED_BROWSER_CREATED",
      "TRUSTED_BROWSER_USED",
      "TRUSTED_BROWSER_EXPIRED",
      "TRUSTED_BROWSER_REVOKED",
      "TRUSTED_BROWSER_POLICY_UPDATED",
    ]) expect(migration).toContain(event);
    expect(migration).toContain("INSERT INTO auth_security_events");
    expect(migration).toContain("organization.trusted-browser-policy-updated");
    expect(migration).toContain("INSERT INTO public.audit_outbox_pair_contract");
    expect(migration).toContain("business-audit-outbox-v1");
  });

  it("preserves old auth APIs and allowlists only the new reviewed functions", () => {
    expect(migration).not.toContain("DROP FUNCTION app.auth_lookup_login_v2");
    expect(migration).not.toContain("DROP FUNCTION app.auth_issue_mfa_user_session");
    for (const signature of [
      "app.auth_lookup_login_v3(text)",
      "app.auth_issue_mfa_user_session_trusted(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text)",
      "app.auth_issue_trusted_browser_user_session(uuid,uuid,uuid,text,text,text,text,text,text)",
      "app.auth_trusted_browsers_for_session(uuid,text)",
      "app.auth_revoke_trusted_browser(uuid,uuid,text)",
      "app.auth_revoke_all_trusted_browsers(uuid,text)",
      "app.auth_logout_all_sessions(uuid,text)",
      "app.organization_settings_read_v2()",
      "app.organization_update_trusted_browser_policy(boolean,integer,integer)",
      "app.organization_revoke_member_sessions_and_trust(uuid)",
    ]) expect(reconciler).toContain(signature);
  });
});
