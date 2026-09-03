import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0037_shared_public_demo.sql"),
  "utf8",
);

const issueSessionStart = migration.indexOf(
  "CREATE OR REPLACE FUNCTION app.auth_issue_demo_session(",
);
const issueSessionEnd = migration.indexOf(
  "REVOKE ALL ON FUNCTION app.auth_issue_demo_session",
  issueSessionStart,
);
const issueSessionSql = migration.slice(issueSessionStart, issueSessionEnd);

describe("shared public demo SQL", () => {
  it("issues every visitor into the fixed PUBLIC_DEMO organization without claims or slots", () => {
    expect(issueSessionStart).toBeGreaterThanOrEqual(0);
    expect(issueSessionEnd).toBeGreaterThan(issueSessionStart);
    expect(issueSessionSql).toContain("organization.organization_mode = 'PUBLIC_DEMO'");
    expect(issueSessionSql).toContain("NULL, NULL");
    expect(issueSessionSql).toContain("jsonb_build_object('sharedDemo', true)");
    expect(issueSessionSql).not.toContain("FROM demo_sandbox_slots");
    expect(issueSessionSql).not.toContain("FROM demo_daily_claims");
    expect(issueSessionSql).not.toContain("selected_daily_ip_claims");
  });

  it("allows concurrent shared sessions and retires the finite pool invariant", () => {
    expect(migration).toContain("DROP INDEX IF EXISTS auth_sessions_one_live_demo_per_org_unique");
    expect(migration).toContain("demo_generation IS NULL AND demo_claim_id IS NULL");
    expect(migration).toContain("CREATE TABLE shared_demo_reset_state");
    expect(migration).toContain("business-finlynq-shared-demo-reset");
    expect(migration).not.toContain("IF selected_daily_ip_claims >= 16");
  });

  it("keeps reset state owner-only and exposes only aggregate health to runtime", () => {
    expect(migration).toContain("shared_demo_reset_state_owner_only_policy");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.shared_demo_operations_state()");
    expect(migration).toContain("REVOKE ALL ON shared_demo_reset_state FROM business_finlynq_app");
    expect(migration).toContain("app.shared_demo_operations_state()\n      TO business_finlynq_app");
    expect(migration).not.toContain("app.reset_shared_demo_extensions(uuid, uuid)\n      TO business_finlynq_app");
  });
});
