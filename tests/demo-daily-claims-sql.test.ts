import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0012_daily_demo_claims.sql"),
  "utf8",
);
const capacityMigration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0017_demo_claim_network_capacity.sql"),
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
const capacitySessionStart = capacityMigration.indexOf(
  "CREATE OR REPLACE FUNCTION app.auth_issue_demo_session(",
);
const capacitySessionEnd = capacityMigration.indexOf(
  "REVOKE ALL ON FUNCTION app.auth_issue_demo_session",
  capacitySessionStart,
);
const capacitySessionSql = capacityMigration.slice(
  capacitySessionStart,
  capacitySessionEnd,
);

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

  it("raises only the durable per-network capacity in a forward migration", () => {
    expect(capacitySessionStart).toBeGreaterThanOrEqual(0);
    expect(capacitySessionEnd).toBeGreaterThan(capacitySessionStart);

    const expectedReplacement = issueSessionSql
      .replace(
        "CREATE FUNCTION app.auth_issue_demo_session(",
        "CREATE OR REPLACE FUNCTION app.auth_issue_demo_session(",
      )
      .replace(
        "IF selected_daily_ip_claims >= 2 THEN RETURN; END IF;",
        "IF selected_daily_ip_claims >= 16 THEN RETURN; END IF;",
      );

    expect(capacitySessionSql).toBe(expectedReplacement);
    expect(capacityMigration).toContain(
      "REVOKE ALL ON FUNCTION app.auth_issue_demo_session(text, text, text, text, text, text) FROM PUBLIC;",
    );
    expect(capacityMigration).toContain(
      "app.auth_issue_demo_session(text, text, text, text, text, text)\n      TO business_finlynq_app;",
    );
  });
});
