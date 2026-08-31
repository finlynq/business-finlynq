import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const activationMigration = readFileSync(
  join(repositoryRoot, "migrations", "drizzle", "0030_organization_write_activation.sql"),
  "utf8",
);
const graphIndexMigration = readFileSync(
  join(repositoryRoot, "migrations", "drizzle", "0031_audit_graph_leaf_index.sql"),
  "utf8",
);

describe("immutable audit graph migration", () => {
  it("blocks legacy inserts before validating and replacing the complete writer boundary", () => {
    const lockPosition = activationMigration.indexOf(
      "LOCK TABLE public.audit_events IN SHARE ROW EXCLUSIVE MODE",
    );
    const validationPosition = activationMigration.indexOf("DO $audit_graph_validation$");
    const helperPosition = activationMigration.indexOf(
      "CREATE OR REPLACE FUNCTION app.locked_audit_graph_leaf",
    );
    const triggerPosition = activationMigration.indexOf(
      "CREATE OR REPLACE FUNCTION app.enforce_audit_event_chain_tip",
    );
    const writerPosition = activationMigration.indexOf(
      "CREATE OR REPLACE FUNCTION app.append_tenant_business_audit",
    );

    expect(lockPosition).toBeGreaterThanOrEqual(0);
    expect(validationPosition).toBeGreaterThan(lockPosition);
    expect(helperPosition).toBeGreaterThan(validationPosition);
    expect(triggerPosition).toBeGreaterThan(helperPosition);
    expect(writerPosition).toBeGreaterThan(triggerPosition);
  });

  it("rejects roots, leaves, branches, orphans, disconnected cycles, and nonfinite history", () => {
    expect(activationMigration).toContain("root_counts AS");
    expect(activationMigration).toContain("leaf_counts AS");
    expect(activationMigration).toContain("branched_organizations AS");
    expect(activationMigration).toContain("orphaned_organizations AS");
    expect(activationMigration).toContain("WITH RECURSIVE");
    expect(activationMigration).toContain(
      "coalesce(visited.reachable_count, 0) <> counts.event_count",
    );
    expect(activationMigration).toContain("NOT isfinite(event.occurred_at)");
  });

  it("uses the locked graph leaf in the trigger and all three active audit writers", () => {
    expect(activationMigration.match(/FROM app\.locked_audit_graph_leaf\(/g)).toHaveLength(4);
    expect(activationMigration).not.toContain("ORDER BY event.occurred_at DESC");
    expect(activationMigration).toContain("maximum_historical_time + interval '1 microsecond'");
    expect(activationMigration).toContain(
      "CREATE OR REPLACE FUNCTION app.audit_successful_posting()",
    );
    expect(activationMigration).toContain(
      "CREATE OR REPLACE FUNCTION app.audit_period_transition()",
    );
    expect(activationMigration).toContain(
      "REVOKE ALL ON FUNCTION app.locked_audit_graph_leaf(uuid) FROM PUBLIC",
    );
    for (const functionName of [
      "locked_audit_graph_leaf",
      "enforce_audit_event_chain_tip",
      "append_tenant_business_audit",
      "audit_successful_posting",
      "audit_period_transition",
    ]) {
      const declaration = activationMigration.indexOf(
        `CREATE OR REPLACE FUNCTION app.${functionName}`,
      );
      const body = activationMigration.indexOf("AS $$", declaration);
      expect(activationMigration.slice(declaration, body)).toContain(
        "SET search_path = pg_catalog, public, pg_temp",
      );
    }
  });

  it("adds the graph-leaf lookup index through the generated declaration chain", () => {
    expect(graphIndexMigration).toContain(
      'CREATE INDEX "audit_events_org_previous_hash_idx"',
    );
    expect(graphIndexMigration).toContain(
      '("organization_id", "previous_event_hash")',
    );
  });
});
