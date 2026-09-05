import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const lifecycleScript = readFileSync(
  join(repositoryRoot, "scripts", "operations", "verify-ci-database-lifecycle.sh"),
  "utf8",
);
const workflow = readFileSync(
  join(repositoryRoot, ".github", "workflows", "ci.yml"),
  "utf8",
);
const migrationJournal = JSON.parse(readFileSync(
  join(repositoryRoot, "migrations", "drizzle", "meta", "_journal.json"),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };
const tenantPolicyMigration = readFileSync(
  join(repositoryRoot, "migrations", "drizzle", "0025_tenant_rls_completion.sql"),
  "utf8",
);
const restoreSafetyMigration = readFileSync(
  join(repositoryRoot, "migrations", "drizzle", "0029_restore_safe_currency_lookup.sql"),
  "utf8",
);

describe("CI predecessor-upgrade and restore verification", () => {
  it("can create or drop only fixed loopback sibling test databases behind an explicit guard", () => {
    expect(lifecycleScript).toContain(
      'expected_guard="business-finlynq-disposable-ci-databases"',
    );
    expect(lifecycleScript).toContain('[[ "$CI" == "true" ]]');
    expect(lifecycleScript).toContain('[[ "$GITHUB_ACTIONS" == "true" ]]');
    expect(lifecycleScript).toContain(
      '[[ "$PGHOST" == "127.0.0.1" ]]',
    );
    expect(lifecycleScript).toContain(
      'expected_source_database="business_finlynq_test"',
    );
    expect(lifecycleScript).toContain(
      'predecessor_database="business_finlynq_test_predecessor_upgrade"',
    );
    expect(lifecycleScript).toContain(
      'restore_database="business_finlynq_test_restore_verify"',
    );
    expect(lifecycleScript).toContain(
      "PostgreSQL cluster contains non-CI databases and is not disposable",
    );
    expect(lifecycleScript).toContain(
      'case "$selected_database" in',
    );
    expect(lifecycleScript).toContain(
      '"$predecessor_database"|"$restore_database")',
    );
    expect(lifecycleScript).toContain("--maintenance-db postgres");
    expect(lifecycleScript).toContain(
      "newly created sibling database is not empty",
    );
    expect(lifecycleScript).toContain("--if-exists");
    expect(lifecycleScript).toContain("--force");
    expect(lifecycleScript).toContain("trap cleanup EXIT");
    expect(lifecycleScript).toContain(
      '"$runner_temp"/business-finlynq-*) rm -rf -- "$temporary_root"',
    );
  });

  it("replays exactly 0000-0024 before preserving a tenant sentinel through 0046", () => {
    expect(migrationJournal.entries.map((entry) => entry.idx)).toEqual(
      Array.from({ length: 47 }, (_, index) => index),
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 25)?.tag).toBe(
      "0025_tenant_rls_completion",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 26)?.tag).toBe(
      "0026_snapshot_baseline",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 27)?.tag).toBe(
      "0027_session_user_agent_binding",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 28)?.tag).toBe(
      "0028_bank_match_allocation_idempotency",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 29)?.tag).toBe(
      "0029_restore_safe_currency_lookup",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 30)?.tag).toBe(
      "0030_organization_write_activation",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 31)?.tag).toBe(
      "0031_audit_graph_leaf_index",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 32)?.tag).toBe(
      "0032_observability_correlation_metrics",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 33)?.tag).toBe(
      "0033_self_service_signup_write_activation",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 34)?.tag).toBe(
      "0034_clean_praxagora",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 35)?.tag).toBe(
      "0035_remote_mcp_security",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 36)?.tag).toBe(
      "0036_mcp_approval_assurance",
    );
    expect(tenantPolicyMigration).toContain("ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY");
    expect(migrationJournal.entries.find((entry) => entry.idx === 37)?.tag).toBe(
      "0037_shared_public_demo",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 38)?.tag).toBe(
      "0038_mcp_approval_session_binding",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 39)?.tag).toBe(
      "0039_create_fiscal_periods",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 45)?.tag).toBe(
      "0045_organization_fx_provider_policy",
    );
    expect(migrationJournal.entries.find((entry) => entry.idx === 46)?.tag).toBe(
      "0046_central_bank_fx_providers",
    );
    expect(tenantPolicyMigration).toContain("ALTER TABLE public.%I FORCE ROW LEVEL SECURITY");
    expect(tenantPolicyMigration).toContain("auth_sessions");
    expect(lifecycleScript).toContain("migration_prefix <= 24");
    expect(lifecycleScript).toContain("entry.idx <= 24");
    expect(lifecycleScript).toContain("migration_count -eq 25");
    expect(lifecycleScript).toContain(
      "INSERT INTO organizations (",
    );
    expect(lifecycleScript).toContain("ci-predecessor-sentinel");
    expect(lifecycleScript).toContain("ci.predecessor-audit-root");
    expect(lifecycleScript).toContain("ci.predecessor-audit-leaf");
    expect(lifecycleScript).toContain(
      'predecessor_audit_root_hash="bc7860b6b606f2879bba3d3d89c3eb363cd3de4621b98298a0ecd6d4d1559bc0"',
    );
    expect(lifecycleScript).toContain(
      'predecessor_audit_leaf_hash="a4366c38712347b450f5ccee094129dd19ac34119419fc4cdc3de61fb9f1c8b1"',
    );
    expect(lifecycleScript).toContain("'2040-01-01T00:00:00Z'");
    expect(lifecycleScript).toContain("'2030-01-01T00:00:00Z'");
    expect(lifecycleScript).toContain(
      'run_migrations "$predecessor_database" "$repository_root/migrations/drizzle"',
    );
    expect(lifecycleScript).toContain('[[ "$upgraded_count" == "47" ]]');
    expect(lifecycleScript).toContain(
      "tenant sentinel was not preserved through migrations 0025 through 0046",
    );
    expect(lifecycleScript).toContain("ci.predecessor-audit-after-upgrade");
    expect(lifecycleScript).toContain(
      "predecessor audit graph was not preserved and extended from its graph leaf",
    );
    expect(lifecycleScript).toContain(
      "upgraded predecessor audit helper did not return the appended graph leaf",
    );
    expect(lifecycleScript).toContain('reconcile_roles "$predecessor_database"');
    expect(lifecycleScript).toContain(
      'verify_fail_closed_default_privileges "$predecessor_database"',
    );
    expect(lifecycleScript).toContain(
      "CREATE FUNCTION public.business_finlynq_acl_probe_function()",
    );
    expect(lifecycleScript).toContain(
      "PUBLIC received implicit EXECUTE on a future function",
    );
    expect(lifecycleScript).toContain('verify_schema_and_grants "$predecessor_database"');
    expect(lifecycleScript).toContain("scripts/operations/verify-journal-type-registry.ts");
  });

  it("performs a real custom-format dump and transactional restore of populated data", () => {
    expect(restoreSafetyMigration).toContain(
      'DROP CONSTRAINT "auth_organization_signups_supported_currency_check"',
    );
    expect(restoreSafetyMigration).toContain("SET search_path = pg_catalog");
    expect(restoreSafetyMigration).toContain("FROM public.currency_definitions AS definition");
    expect(restoreSafetyMigration).toContain("pg_catalog.upper(currency_code)");
    expect(restoreSafetyMigration).toContain(
      'ADD CONSTRAINT "auth_organization_signups_functional_currency_fk"',
    );
    expect(restoreSafetyMigration).toContain(
      'FOREIGN KEY ("functional_currency") REFERENCES "public"."currency_definitions"("code")',
    );
    expect(lifecycleScript).toContain("source database has no populated organization data to restore");
    expect(lifecycleScript).toContain(
      "source database is missing the bootstrapped demo organization sentinel",
    );
    expect(lifecycleScript).toContain("PGPASSWORD=\"$backup_password\" pg_dump");
    expect(lifecycleScript).toContain("--format custom");
    expect(lifecycleScript).toContain("--no-owner");
    expect(lifecycleScript).toContain("--no-privileges");
    expect(lifecycleScript).toContain(
      'pg_restore --list "$dump_path" > "$dump_listing"',
    );
    expect(lifecycleScript).toContain(
      'grep -Fq "TABLE DATA public organizations" "$dump_listing"',
    );
    expect(lifecycleScript).toContain("PGPASSWORD=\"$PGPASSWORD\" pg_restore");
    expect(lifecycleScript).toContain("--exit-on-error");
    expect(lifecycleScript).toContain("--single-transaction");
    expect(lifecycleScript).toContain('run_migrations "$restore_database"');
    expect(lifecycleScript).toContain('reconcile_roles "$restore_database"');
    expect(lifecycleScript).toContain(
      'verify_fail_closed_default_privileges "$restore_database"',
    );
    expect(lifecycleScript).toContain('verify_schema_and_grants "$restore_database"');
    expect(lifecycleScript).toContain("deploy/postgres/010-runtime-role.sh");
    expect(lifecycleScript).toContain("deploy/postgres/015-auth-worker-role.sh");
    expect(lifecycleScript).toContain("deploy/postgres/020-backup-role.sh");
    expect(lifecycleScript).toContain(
      "restored organization count differs from the populated source",
    );
    expect(lifecycleScript).toContain(
      "restored demo organization sentinel differs from the populated source",
    );
    expect(lifecycleScript).toContain(
      'restore_correlation_request_a="00000000-0000-4000-8000-0000000000c1"',
    );
    expect(lifecycleScript).toContain(
      'restore_correlation_request_b="00000000-0000-4000-8000-0000000000c2"',
    );
    expect(lifecycleScript).toContain(
      "organization.member-sessions-revoked",
    );
    expect(lifecycleScript).toContain(
      "source audit/outbox request correlation fixture is incomplete",
    );
    expect(lifecycleScript).toContain(
      "restored audit/outbox request IDs differ from the populated source",
    );
  });

  it("runs the upgrade check before clean replay and restore check only after test data is populated", () => {
    const predecessorStep = workflow.indexOf(
      "bash scripts/operations/verify-ci-database-lifecycle.sh predecessor-upgrade",
    );
    const mainMigration = workflow.indexOf("- run: npm run db:migrate");
    const demoBootstrap = workflow.indexOf("- name: Bootstrap the fixed public demo");
    const testRun = workflow.indexOf("- run: npm run test");
    const restoreStep = workflow.indexOf(
      "bash scripts/operations/verify-ci-database-lifecycle.sh restore",
    );
    const buildRun = workflow.indexOf("- run: npm run build");

    expect(workflow).toContain(
      "BUSINESS_FINLYNQ_CI_DATABASE_GUARD: business-finlynq-disposable-ci-databases",
    );
    expect(workflow).toContain("GRANT SELECT ON organizations TO PUBLIC");
    expect(workflow).toContain("GRANT SELECT (email_ciphertext) ON users TO PUBLIC");
    expect(workflow).toContain(
      "GRANT EXECUTE ON FUNCTION public.digest(text, text) TO PUBLIC",
    );
    expect(workflow).toContain(
      "GRANT business_finlynq_runtime_inherited_stale TO business_finlynq_app",
    );
    expect(workflow).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC",
    );
    expect(workflow).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT INSERT ON TABLES TO business_finlynq_app",
    );
    expect(workflow).toContain(
      "Prove stale default privileges fail schema verification",
    );
    expect(workflow).toContain(
      "[UNSAFE_DEFAULT_PRIVILEGE] PUBLIC receives EXECUTE on future function objects in <global>",
    );
    expect(workflow).toContain("DROP OWNED BY business_finlynq_runtime_inherited_stale");
    expect(workflow).not.toContain("pg_restore --list /tmp/business-finlynq-backup-role-smoke.dump | grep");
    expect(predecessorStep).toBeGreaterThan(-1);
    expect(predecessorStep).toBeLessThan(mainMigration);
    expect(demoBootstrap).toBeLessThan(testRun);
    expect(testRun).toBeLessThan(restoreStep);
    expect(restoreStep).toBeLessThan(buildRun);
  });
});
