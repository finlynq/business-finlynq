import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0012_daily_demo_claims.sql"),
  "utf8",
);

const issueSessionStart = migration.indexOf(
  "CREATE FUNCTION app.auth_issue_demo_session(",
);
const issueSessionEnd = migration.indexOf(
  "REVOKE ALL ON FUNCTION app.auth_issue_demo_session",
  issueSessionStart,
);
const issueSessionSql = migration.slice(issueSessionStart, issueSessionEnd);

describe("daily demo claim SQL", () => {
  it("qualifies columns that collide with table-return output variables", () => {
    expect(issueSessionStart).toBeGreaterThanOrEqual(0);
    expect(issueSessionEnd).toBeGreaterThan(issueSessionStart);

    expect(issueSessionSql).toContain(
      "UPDATE auth_sessions AS active_demo_session",
    );
    expect(issueSessionSql).toContain(
      "WHERE active_demo_session.organization_id = selected_claim.organization_id",
    );
    expect(issueSessionSql).toContain(
      "coalesce(active_demo_session.revoked_at, now())",
    );

    expect(issueSessionSql).toContain(
      "UPDATE demo_sandbox_slots AS claimed_slot",
    );
    expect(issueSessionSql).toContain(
      "AND claimed_slot.organization_id = selected_claim.organization_id",
    );
    expect(issueSessionSql).toContain(
      "coalesce(claimed_slot.last_claimed_at, now())",
    );

    expect(issueSessionSql).not.toMatch(
      /WHERE\s+organization_id\s*=\s*selected_claim\.organization_id/,
    );
    expect(issueSessionSql).not.toMatch(
      /\bAND\s+organization_id\s*=\s*selected_claim\.organization_id/,
    );
  });
});
