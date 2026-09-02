import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "migrations",
    "drizzle",
    "0033_self_service_signup_write_activation.sql",
  ),
  "utf8",
);

describe("self-service signup write activation migration", () => {
  it("activates only completed owner signups through the durable tenant fence", () => {
    expect(migration).toContain("signup.status = 'ACTIVE'");
    expect(migration).toContain("signup.completed_at IS NOT NULL");
    expect(migration).toContain("role.key = 'OWNER'");
    expect(migration).toContain("membership.active");
    expect(migration).toContain("organization.organization_mode <> 'REAL'");
    expect(migration).toContain("business-finlynq:organization-write-activation:");
    expect(migration).toContain("FOR UPDATE OF signup");
    expect(migration).toContain("FOR UPDATE;");
  });

  it("retains the audited emergency-disable boundary", () => {
    expect(migration).toContain("audit.action = 'organization.writes-disabled'");
    expect(migration).toContain("'organization.writes-enabled'");
    expect(migration).toContain("'activationPolicy', 'SELF_SERVICE_SIGNUP'");
    expect(migration).toContain("app.append_tenant_business_audit(");
    expect(migration).toContain("system:self-service-signup");
    expect(migration).toContain("verified-owner-signup");
  });

  it("covers future transitions and existing eligible signups without exposing a runtime function", () => {
    expect(migration).toContain("OLD.status = 'ENROLLING' AND NEW.status = 'ACTIVE'");
    expect(migration).toContain("CREATE TRIGGER organization_signup_activates_writes");
    expect(migration).toContain("Forward-only reconciliation for already-completed");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION app.enable_completed_self_service_signup_writes(uuid)",
    );
    expect(migration).toContain("FROM business_finlynq_app");
    expect(migration).toContain("FROM business_finlynq_auth_worker");
    expect(migration).toContain("FROM business_finlynq_backup");
  });
});
