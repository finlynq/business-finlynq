import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const canonical = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0013_self_service_owner_signup.sql"),
  "utf8",
);
const compatibility = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0015_signup_compatibility_forward.sql"),
  "utf8",
);

function functionDefinition(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION app.${name}(`);
  expect(start, `${name} definition start`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `${name} definition end`).toBeGreaterThan(start);
  return sql.slice(start, end + 4);
}

function semanticSql(sql: string): string {
  return sql
    .replace(/^\s*--.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("forward-only signup compatibility migration", () => {
  it("backfills the immutable ciphertext binding columns before restoring NOT NULL", () => {
    expect(compatibility).toContain("ADD COLUMN IF NOT EXISTS identity_encryption_user_id uuid");
    expect(compatibility).toContain("ADD COLUMN IF NOT EXISTS requested_email_ciphertext text");
    expect(compatibility).toContain("ADD COLUMN IF NOT EXISTS requested_display_name_ciphertext text");
    expect(compatibility).toContain("signup.identity_encryption_user_id, signup.user_id");
    expect(compatibility).toContain("selected_user.display_name_ciphertext");
    expect(compatibility).toContain("ALTER COLUMN identity_encryption_user_id SET NOT NULL");
    expect(compatibility.indexOf("UPDATE auth_organization_signups signup SET"))
      .toBeLessThan(compatibility.indexOf("ALTER COLUMN identity_encryption_user_id SET NOT NULL"));
  });

  it("keeps every post-publication signup function synchronized with canonical 0013", () => {
    for (const name of [
      "auth_begin_organization_signup",
      "auth_accept_organization_signup",
      "auth_finish_mfa_enrollment",
    ]) {
      expect(semanticSql(functionDefinition(compatibility, name)))
        .toBe(semanticSql(functionDefinition(canonical, name)));
    }
  });

  it("keeps the compatibility functions security-definer and explicitly scoped", () => {
    expect(compatibility.match(/SECURITY DEFINER/g)).toHaveLength(3);
    expect(compatibility.match(/SET search_path = public, pg_temp/g)).toHaveLength(3);
    expect(compatibility).toContain("'business-finlynq|account-user|' || selected_email_hash");
    expect(compatibility).toContain("REVOKE EXECUTE ON FUNCTION");
    expect(compatibility).toContain("FROM PUBLIC");
  });
});
