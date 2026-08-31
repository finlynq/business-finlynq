import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDatabaseSchemaContract,
  buildDatabaseRuntimeGrantContract,
  buildExpectedRuntimeGrantContract,
  buildSnapshotSchemaContract,
  compareRuntimeGrantContracts,
  compareSchemaContracts,
  applyMigrationOwnedConstraintContract,
  informationSchemaColumnType,
  loadMigrationOwnedConstraintContract,
  loadLatestJournalSnapshot,
  normalizeColumnDefault,
  normalizeCheckExpression,
  normalizePostgresConstraintIdentifier,
  normalizeIndexPredicate,
  normalizePostgresType,
  normalizeRlsPolicyExpression,
  normalizeSqlExpression,
  parseMigrationOwnedConstraintContract,
} from "../scripts/operations/verify-database-schema.mjs";

const temporaryDirectories: string[] = [];
const runtimeRoleReconciler = readFileSync(
  join(process.cwd(), "deploy", "postgres", "010-runtime-role.sh"),
  "utf8",
);

function temporaryMetaDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "business-finlynq-schema-verifier-"));
  temporaryDirectories.push(directory);
  return directory;
}

function snapshot() {
  return {
    tables: {
      "public.organizations": {
        name: "organizations",
        schema: "",
        columns: {
          id: { name: "id", type: "uuid", notNull: true },
          display_name: { name: "display_name", type: "text", notNull: true },
        },
      },
      "public.journal_lines": {
        name: "journal_lines",
        schema: "",
        columns: {
          id: { name: "id", type: "uuid", notNull: true },
          organization_id: { name: "organization_id", type: "uuid", notNull: true },
          amount: { name: "amount", type: "numeric(38, 9)", notNull: false },
        },
      },
    },
  };
}

function matchingDatabaseContract() {
  return buildDatabaseSchemaContract({
    tableRows: [
      { table_name: "journal_lines" },
      { table_name: "organizations" },
    ],
    columnRows: [
      {
        table_name: "organizations",
        column_name: "id",
        is_nullable: "NO",
        data_type: "uuid",
        udt_name: "uuid",
      },
      {
        table_name: "organizations",
        column_name: "display_name",
        is_nullable: "NO",
        data_type: "text",
        udt_name: "text",
      },
      {
        table_name: "journal_lines",
        column_name: "id",
        is_nullable: "NO",
        data_type: "uuid",
        udt_name: "uuid",
      },
      {
        table_name: "journal_lines",
        column_name: "organization_id",
        is_nullable: "NO",
        data_type: "uuid",
        udt_name: "uuid",
      },
      {
        table_name: "journal_lines",
        column_name: "amount",
        is_nullable: "YES",
        data_type: "numeric",
        udt_name: "numeric",
        numeric_precision: 38,
        numeric_scale: 9,
      },
    ],
    rlsRows: [
      { table_name: "journal_lines", rls_enabled: true, force_rls: true },
      { table_name: "organizations", rls_enabled: true, force_rls: true },
    ],
    policyRows: [
      {
        table_name: "journal_lines",
        policy_name: "tenant_isolation",
        command: "ALL",
        permissive: true,
        roles: ["PUBLIC"],
        using_expression: "(organization_id = app.current_organization_id())",
        with_check_expression: "(organization_id = app.current_organization_id())",
      },
      {
        table_name: "organizations",
        policy_name: "organizations_tenant_isolation",
        command: "ALL",
        permissive: true,
        roles: ["PUBLIC"],
        using_expression: "(id = app.current_organization_id())",
        with_check_expression: "(id = app.current_organization_id())",
      },
    ],
  });
}

function matchingRuntimeGrantContract() {
  const expected = buildExpectedRuntimeGrantContract();
  return buildDatabaseRuntimeGrantContract({
    roleRows: [{
      role_name: "business_finlynq_app",
      can_login: true,
      can_bypass_rls: false,
      is_superuser: false,
      can_create_database: false,
      can_create_role: false,
      can_replicate: false,
      inherits_privileges: false,
      connection_limit: 20,
    }],
    databasePrivilegeRows: [{
      grantee_name: "business_finlynq_app",
      privilege_type: "CONNECT",
      is_grantable: false,
    }],
    schemaPrivilegeRows: ["public", "app"].map((schema_name) => ({
      schema_name,
      grantee_name: "business_finlynq_app",
      privilege_type: "USAGE",
      is_grantable: false,
    })),
    relationRows: [
      ...[...expected.grants.keys()].map((relation_name) => ({ relation_name })),
      { relation_name: "users" },
    ],
    grantRows: [...expected.grants].flatMap(([relation_name, privileges]) => (
      [...privileges].map((privilege_type) => ({
        is_grantable: false,
        privilege_type,
        relation_name,
      }))
    )),
    columnGrantRows: [],
    functionRows: [...expected.functionGrants.keys()].map((function_signature) => ({
      function_signature,
    })),
    functionGrantRows: [...expected.functionGrants].flatMap(([function_signature, privileges]) => (
      [...privileges].map((privilege_type) => ({
        function_signature,
        is_grantable: false,
        privilege_type,
      }))
    )),
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("database schema verifier", () => {
  it("removes PUBLIC object and default privileges before applying the runtime allowlist", () => {
    expect(runtimeRoleReconciler).toContain(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC",
    );
    expect(runtimeRoleReconciler).toContain(
      "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC",
    );
    expect(runtimeRoleReconciler).toContain(
      "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC",
    );
    expect(runtimeRoleReconciler).toContain(
      "'REVOKE %s (%I) ON TABLE %I.%I FROM PUBLIC'",
    );
    expect(runtimeRoleReconciler).toContain(
      "PUBLIC or runtime column privileges remain after runtime reconciliation",
    );
    expect(runtimeRoleReconciler).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE :\"owner_role\" IN SCHEMA public",
    );
    expect(runtimeRoleReconciler).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE :\"owner_role\"\n  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
    );
    expect(runtimeRoleReconciler).toContain(
      "default_acl.defaclnamespace = 0",
    );
    expect(runtimeRoleReconciler).toContain(
      "PUBLIC or runtime default privileges remain after runtime reconciliation",
    );
    expect(runtimeRoleReconciler).toContain("'public.digest(text,text)'");
    expect(runtimeRoleReconciler).toContain("'public.digest(bytea,text)'");
  });

  it("keeps the verifier function allowlist identical to the reconciler", () => {
    const functionBlock = runtimeRoleReconciler.match(
      /FOREACH selected_signature IN ARRAY ARRAY\[([\s\S]*?)\]\s+LOOP/,
    )?.[1];
    expect(functionBlock).toBeDefined();
    const reconcilerFunctions = [...functionBlock!.matchAll(/'([^']+)'/g)]
      .map((match) => match[1]!.replaceAll(",", ", "))
      .sort();
    const verifierFunctions = [...buildExpectedRuntimeGrantContract().functionGrants.keys()].sort();

    expect(verifierFunctions).toEqual(reconcilerFunctions);
  });

  it("evaluates built-in global function defaults when pg_default_acl has no row", () => {
    const verifier = readFileSync(
      join(process.cwd(), "scripts", "operations", "verify-database-schema.mjs"),
      "utf8",
    );
    const defaultPrivilegeQuery = verifier.slice(
      verifier.indexOf("const defaultPrivilegeResult"),
      verifier.indexOf("return buildDatabaseRuntimeGrantContract", verifier.indexOf("const defaultPrivilegeResult")),
    );
    expect(verifier).toContain("default_acl.defaclnamespace = 0");
    expect(verifier).toContain(
      "pg_catalog.acldefault(default_type.object_type_code, relevant_owner.oid)",
    );
    expect(verifier).toContain("LEFT JOIN pg_catalog.pg_default_acl default_acl");
    expect(defaultPrivilegeQuery).toContain("SELECT database.datdba");
    expect(defaultPrivilegeQuery).toContain("SELECT relation.relowner");
    expect(defaultPrivilegeQuery).toContain("SELECT selected_function.proowner");
    // PostgreSQL 15+ gives the public schema to the pseudo-role
    // pg_database_owner. Namespace ownership alone does not mean that role can
    // create application objects, and synthesizing its built-in function
    // defaults would make every clean PostgreSQL 16 database fail verification.
    expect(defaultPrivilegeQuery).not.toContain("SELECT namespace.nspowner");
  });

  it("installs ownership-following policies on function-only control-plane tables", () => {
    const migration = readFileSync(
      join(process.cwd(), "migrations", "drizzle", "0025_tenant_rls_completion.sql"),
      "utf8",
    );
    const tenantPolicyMarker = migration.indexOf("-- These application-facing tables");
    const ownerPolicyBlock = migration.slice(0, tenantPolicyMarker);
    const existingTenantPolicyBlock = migration.slice(tenantPolicyMarker);

    for (const tableName of [
      "auth_email_outbox",
      "auth_one_time_tokens",
      "auth_organization_signups",
      "auth_recovery_requests",
      "auth_security_events",
      "auth_sessions",
      "demo_daily_claims",
      "demo_sandbox_slots",
    ]) {
      expect(ownerPolicyBlock).toContain(`'${tableName}'`);
    }
    expect(ownerPolicyBlock).not.toContain("'ledger_posting_policies'");
    expect(ownerPolicyBlock).not.toContain("'organization_invitations'");
    expect(existingTenantPolicyBlock).toContain("'ledger_posting_policies'");
    expect(existingTenantPolicyBlock).toContain("'organization_invitations'");
    expect(migration).toContain("WHEN 'ledger_posting_policies' THEN 'tenant_isolation'");
    expect(migration).toContain(
      "WHEN 'organization_invitations' THEN 'organization_invitations_tenant_policy'",
    );
    expect(migration).toContain("selected_table || '_owner_only_policy'");
    expect(migration).toContain("owner_relation.oid = %L::pg_catalog.regclass");
    expect(migration).toContain("relation.relkind IN ('r', 'p')");
    expect(migration).toContain("must define exactly one reviewed RLS policy");
  });

  it("loads the snapshot belonging to the highest journal entry", async () => {
    const directory = temporaryMetaDirectory();
    writeFileSync(join(directory, "_journal.json"), JSON.stringify({
      entries: [
        { idx: 0, tag: "0000_foundation" },
        { idx: 2, tag: "0002_current" },
        { idx: 1, tag: "0001_middle" },
      ],
    }));
    writeFileSync(join(directory, "0000_snapshot.json"), JSON.stringify({ tables: {} }));
    writeFileSync(join(directory, "0002_snapshot.json"), JSON.stringify(snapshot()));

    const loaded = await loadLatestJournalSnapshot(directory);

    expect(loaded.journalEntry).toEqual({ idx: 2, tag: "0002_current" });
    expect(loaded.snapshotPath).toBe(join(directory, "0002_snapshot.json"));
    expect(Object.keys(loaded.snapshot.tables)).toHaveLength(2);
  });

  it("fails actionably when the latest journal entry has no snapshot", async () => {
    const directory = temporaryMetaDirectory();
    writeFileSync(join(directory, "_journal.json"), JSON.stringify({
      entries: [{ idx: 24, tag: "0024_accounting_hierarchies" }],
    }));

    await expect(loadLatestJournalSnapshot(directory)).rejects.toThrow(
      "Latest Drizzle journal entry 0024_accounting_hierarchies has no matching 0024_snapshot.json",
    );
  });

  it("normalizes snapshot and information_schema type spellings", () => {
    expect(normalizePostgresType("numeric(38,9)")).toBe("numeric(38, 9)");
    expect(normalizePostgresType("timestamptz")).toBe("timestamp with time zone");
    expect(informationSchemaColumnType({
      data_type: "USER-DEFINED",
      udt_name: "journal_status",
    })).toBe("journal_status");
    expect(informationSchemaColumnType({
      data_type: "ARRAY",
      udt_name: "_int4",
    })).toBe("integer[]");
  });

  it("normalizes PostgreSQL 16 pg_get_expr owner-policy deparsing without hiding predicate changes", () => {
    const reviewedExpression =
      '(CURRENT_USER = pg_catalog.pg_get_userbyid(( SELECT owner_relation.relowner FROM pg_catalog.pg_class owner_relation WHERE (owner_relation.oid = \'public.auth_sessions\'::regclass))))';
    const postgresql16Expression =
      '(CURRENT_USER = pg_catalog.pg_get_userbyid(( SELECT owner_relation.relowner FROM pg_catalog.pg_class owner_relation WHERE (owner_relation.oid = \'auth_sessions\'::regclass::oid))))';
    expect(normalizeRlsPolicyExpression(reviewedExpression)).toBe(
      "current_user=pg_get_userbyidselectowner_relation.relownerfrompg_classowner_relationwhereowner_relation.oid='public.auth_sessions'::regclass",
    );
    expect(normalizeRlsPolicyExpression(postgresql16Expression))
      .toBe(normalizeRlsPolicyExpression(reviewedExpression));
    expect(normalizeRlsPolicyExpression(
      postgresql16Expression.replace("auth_sessions", "auth_email_outbox"),
    )).not.toBe(normalizeRlsPolicyExpression(reviewedExpression));
    expect(normalizeRlsPolicyExpression(
      postgresql16Expression.replace("'auth_sessions'", "'private.auth_sessions'"),
    )).not.toBe(normalizeRlsPolicyExpression(reviewedExpression));
    expect(normalizeRlsPolicyExpression("(organization_id = app.current_organization_id() OR true)"))
      .not.toBe(normalizeRlsPolicyExpression("organization_id = app.current_organization_id()"));
  });

  it("normalizes PostgreSQL CHECK parse/deparse equivalents without hiding changed bounds or members", () => {
    expect(normalizeCheckExpression("match_kind IN ('EXACT', 'SUGGESTED', 'MANUAL')", "bank_match_allocations"))
      .toBe(normalizeCheckExpression("(match_kind = ANY (ARRAY['EXACT'::text, 'SUGGESTED'::text, 'MANUAL'::text]))", "bank_match_allocations"));
    expect(normalizeCheckExpression("length(idempotency_key) BETWEEN 1 AND 180", "bank_match_allocations"))
      .toBe(normalizeCheckExpression("((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 180))", "bank_match_allocations"));
    expect(normalizeCheckExpression("y IS NULL OR x BETWEEN 1 AND 5", "constraint_probe"))
      .toBe(normalizeCheckExpression("((y IS NULL) OR ((x >= 1) AND (x <= 5)))", "constraint_probe"));
    expect(normalizeCheckExpression("y IS NULL AND status IN ('A', 'B')", "constraint_probe"))
      .toBe(normalizeCheckExpression("((y IS NULL) AND (status = ANY (ARRAY['A'::text, 'B'::text])))", "constraint_probe"));
    expect(normalizeCheckExpression("allocated_amount > 0", "bank_match_allocations"))
      .not.toBe(normalizeCheckExpression("allocated_amount >= 0", "bank_match_allocations"));
    expect(normalizeCheckExpression("match_kind IN ('EXACT', 'SUGGESTED')", "bank_match_allocations"))
      .not.toBe(normalizeCheckExpression("match_kind = ANY (ARRAY['EXACT'::text, 'MANUAL'::text])", "bank_match_allocations"));
    expect(normalizeCheckExpression("(kind = 'A' OR kind = 'B') AND active", "constraint_probe"))
      .not.toBe(normalizeCheckExpression("kind = 'A' OR (kind = 'B' AND active)", "constraint_probe"));
    expect(normalizeCheckExpression("(kind = 'A' OR kind = 'B') AND active", "constraint_probe"))
      .not.toBe(normalizeCheckExpression("kind = 'A' OR kind = 'B' AND active", "constraint_probe"));
  });

  it("normalizes reviewed PostgreSQL 16 numeric casts and arithmetic grouping only with numeric column evidence", () => {
    const numericColumns = new Map([
      ["allocated_amount", { type: "numeric(38, 9)" }],
      ["amount", { type: "numeric(38, 9)" }],
      ["closing_balance", { type: "numeric(38, 9)" }],
      ["debit_functional", { type: "numeric(38, 9)" }],
      ["credit_functional", { type: "numeric(38, 9)" }],
      ["finalized_observation_total", { type: "numeric(38, 9)" }],
      ["finalized_unexplained_difference", { type: "numeric(38, 9)" }],
      ["opening_balance", { type: "numeric(38, 9)" }],
    ]);
    const functionalSide = "debit_functional >= 0 AND credit_functional >= 0 AND (debit_functional > 0 AND credit_functional = 0 OR credit_functional > 0 AND debit_functional = 0)";
    const postgresql16FunctionalSide = "(debit_functional >= (0)::numeric AND credit_functional >= (0)::numeric AND ((debit_functional > (0)::numeric AND credit_functional = (0)::numeric) OR (credit_functional > (0)::numeric AND debit_functional = (0)::numeric)))";

    expect(normalizeCheckExpression("allocated_amount > 0", "bank_match_allocations", numericColumns))
      .toBe(normalizeCheckExpression("(allocated_amount > (0)::numeric)", "bank_match_allocations", numericColumns));
    expect(normalizeCheckExpression(functionalSide, "journal_lines", numericColumns))
      .toBe(normalizeCheckExpression(postgresql16FunctionalSide, "journal_lines", numericColumns));
    expect(normalizeCheckExpression(
      "finalized_observation_total = closing_balance - opening_balance AND finalized_unexplained_difference = 0",
      "bank_reconciliation_sessions",
      numericColumns,
    )).toBe(normalizeCheckExpression(
      "(finalized_observation_total = ((closing_balance - opening_balance)) AND finalized_unexplained_difference = (0)::numeric)",
      "bank_reconciliation_sessions",
      numericColumns,
    ));

    expect(normalizeCheckExpression("allocated_amount > 0", "bank_match_allocations"))
      .not.toBe(normalizeCheckExpression("allocated_amount > (0)::numeric", "bank_match_allocations"));
    expect(normalizeCheckExpression("allocated_amount > 0", "bank_match_allocations", new Map([["allocated_amount", { type: "text" }]])))
      .not.toBe(normalizeCheckExpression("allocated_amount > (0)::numeric", "bank_match_allocations", new Map([["allocated_amount", { type: "text" }]])));
    expect(normalizeCheckExpression("allocated_amount > 0", "bank_match_allocations", numericColumns))
      .not.toBe(normalizeCheckExpression("allocated_amount >= (0)::numeric", "bank_match_allocations", numericColumns));
    expect(normalizeCheckExpression("allocated_amount > 0", "bank_match_allocations", numericColumns))
      .not.toBe(normalizeCheckExpression("allocated_amount > (1)::numeric", "bank_match_allocations", numericColumns));
    expect(normalizeCheckExpression("status = 'ACTIVE'::status_kind", "constraint_probe"))
      .not.toBe(normalizeCheckExpression("status = 'ACTIVE'", "constraint_probe"));
    expect(normalizeCheckExpression("ready = (verified OR overridden)", "constraint_probe"))
      .not.toBe(normalizeCheckExpression("ready = verified OR overridden", "constraint_probe"));
  });

  it("normalizes PostgreSQL 16 partial-index and nested CHECK deparsing structurally", () => {
    const journalRelationColumns = new Map([["kind", { type: "journal_relation_kind" }]]);
    const ledgerColumns = new Map([["active", { type: "boolean" }], ["kind", { type: "ledger_kind" }]]);
    expect(normalizeIndexPredicate("status IN ('PENDING', 'SENDING')", "auth_email_outbox"))
      .toBe(normalizeIndexPredicate(
        "(status = ANY (ARRAY['PENDING'::text, 'SENDING'::text]))",
        "auth_email_outbox",
      ));
    expect(normalizeCheckExpression("length(btrim(granted_by)) BETWEEN 3 AND 200", "access_grants"))
      .toBe(normalizeCheckExpression(
        "((length(btrim(granted_by)) >= 3) AND (length(btrim(granted_by)) <= 200))",
        "access_grants",
      ));
    expect(normalizeCheckExpression("((status = 'A'::text) AND (y IS NULL))", "constraint_probe"))
      .toBe(normalizeCheckExpression("status = 'A' AND y IS NULL", "constraint_probe"));
    expect(normalizeCheckExpression("parent_id IS NOT NULL", "constraint_probe"))
      .toBe("parent_id is not null");
    expect(normalizeCheckExpression("access_grants.status = 'access_grants.status'", "access_grants"))
      .toBe(normalizeCheckExpression("status = 'access_grants.status'", "access_grants"));
    expect(normalizeIndexPredicate("kind = 'REVERSAL_OF'", "journal_entry_relations", journalRelationColumns))
      .toBe(normalizeIndexPredicate(
        "(kind = 'REVERSAL_OF'::journal_relation_kind)",
        "journal_entry_relations",
        journalRelationColumns,
      ));
    expect(normalizeIndexPredicate("kind = 'PRIMARY' AND active", "ledgers", ledgerColumns))
      .toBe(normalizeIndexPredicate(
        "((kind = 'PRIMARY'::ledger_kind) AND active)",
        "ledgers",
        ledgerColumns,
      ));

    expect(normalizeIndexPredicate("status IN ('PENDING', 'SENDING')", "auth_email_outbox"))
      .not.toBe(normalizeIndexPredicate("status IN ('PENDING', 'SENT')", "auth_email_outbox"));
    expect(normalizeCheckExpression("length(btrim(granted_by)) BETWEEN 3 AND 200", "access_grants"))
      .not.toBe(normalizeCheckExpression("length(btrim(granted_by)) BETWEEN 4 AND 200", "access_grants"));
    expect(normalizeCheckExpression("access_grants.status = 'access_grants.status'", "access_grants"))
      .not.toBe(normalizeCheckExpression("status = 'status'", "access_grants"));
    expect(normalizeCheckExpression("(status = 'A' OR status = 'B') AND y IS NULL", "constraint_probe"))
      .not.toBe(normalizeCheckExpression("status = 'A' OR (status = 'B' AND y IS NULL)", "constraint_probe"));
    expect(normalizeIndexPredicate("kind = 'REVERSAL_OF'", "journal_entry_relations", journalRelationColumns))
      .not.toBe(normalizeIndexPredicate("kind = 'REVERSAL_OF'::ledger_kind", "journal_entry_relations", journalRelationColumns));
    expect(normalizeIndexPredicate("kind = 'REVERSAL_OF'", "journal_entry_relations", journalRelationColumns))
      .not.toBe(normalizeIndexPredicate("kind = 'REPLACEMENT_OF'::journal_relation_kind", "journal_entry_relations", journalRelationColumns));
    expect(normalizeIndexPredicate("kind = 'REVERSAL_OF'", "journal_entry_relations"))
      .not.toBe(normalizeIndexPredicate("kind = 'REVERSAL_OF'::journal_relation_kind", "journal_entry_relations"));
  });

  it("normalizes catalog defaults and constraints while rejecting every deliberate schema mismatch", () => {
    expect(normalizeColumnDefault("CURRENT_TIMESTAMP")).toBe("now()");
    expect(normalizeColumnDefault("'DRAFT'::text")).toBe("'DRAFT'");
    expect(normalizeColumnDefault(true)).toBe("true");
    expect(normalizeColumnDefault(false)).toBe("false");
    expect(normalizeColumnDefault(0)).toBe("0");
    expect(normalizeColumnDefault(38.18)).toBe("38.18");
    expect(normalizeColumnDefault("repeat('0', 64)"))
      .toBe("'0000000000000000000000000000000000000000000000000000000000000000'");
    expect(normalizeColumnDefault("repeat('1', 64)"))
      .not.toBe("'0000000000000000000000000000000000000000000000000000000000000000'");
    expect(normalizeColumnDefault(null)).toBeNull();
    expect(normalizeSqlExpression('( LENGTH("idempotency_key") BETWEEN 1 AND 180 )'))
      .toBe("length(idempotency_key) between 1 and 180");

    const expected = buildSnapshotSchemaContract({
      tables: {
        "public.constraint_parent": {
          name: "constraint_parent",
          schema: "",
          columns: { id: { name: "id", type: "uuid", notNull: true } },
          foreignKeys: {}, indexes: {}, uniqueConstraints: {}, checkConstraints: {},
        },
        "public.constraint_probe": {
          name: "constraint_probe",
          schema: "",
          columns: {
            id: { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
            parent_id: { name: "parent_id", type: "uuid", notNull: true },
            request_key: { name: "request_key", type: "text", notNull: true, default: "'DRAFT'" },
          },
          foreignKeys: {
            constraint_probe_parent_fk: {
              name: "constraint_probe_parent_fk", tableFrom: "constraint_probe", tableTo: "constraint_parent",
              columnsFrom: ["parent_id"], columnsTo: ["id"], onDelete: "restrict", onUpdate: "no action",
            },
          },
          checkConstraints: {
            constraint_probe_request_key_length: {
              name: "constraint_probe_request_key_length", value: 'length("request_key") BETWEEN 1 AND 180',
            },
          },
          uniqueConstraints: {
            constraint_probe_parent_request_unique: {
              name: "constraint_probe_parent_request_unique", columns: ["parent_id", "request_key"],
            },
          },
          indexes: {
            constraint_probe_request_idx: {
              name: "constraint_probe_request_idx", isUnique: false, method: "btree",
              columns: [{ expression: "request_key", isExpression: false, asc: false, nulls: "first" }],
              where: '"request_key" <> \'\'',
            },
          },
        },
      },
    });
    const actual = buildDatabaseSchemaContract({
      tableRows: [{ table_name: "constraint_parent" }, { table_name: "constraint_probe" }],
      columnRows: [
        { table_name: "constraint_parent", column_name: "id", is_nullable: "NO", data_type: "uuid", udt_name: "uuid" },
        { table_name: "constraint_probe", column_name: "id", is_nullable: "NO", data_type: "uuid", udt_name: "uuid", column_default: "gen_random_uuid()" },
        { table_name: "constraint_probe", column_name: "parent_id", is_nullable: "NO", data_type: "uuid", udt_name: "uuid" },
        { table_name: "constraint_probe", column_name: "request_key", is_nullable: "NO", data_type: "text", udt_name: "text", column_default: "'DRAFT'::text" },
      ],
      rlsRows: [], policyRows: [],
      foreignKeyRows: [{
        table_name: "constraint_probe", constraint_name: "constraint_probe_parent_fk", table_to: "constraint_parent",
        columns_from: ["parent_id"], columns_to: ["id"], on_delete: "r", on_update: "a",
      }],
      checkRows: [{
        table_name: "constraint_probe", constraint_name: "constraint_probe_request_key_length",
        expression: "(length(request_key) BETWEEN 1 AND 180)",
      }],
      uniqueConstraintRows: [{
        table_name: "constraint_probe", constraint_name: "constraint_probe_parent_request_unique", columns: ["parent_id", "request_key"],
      }],
      indexRows: [{
        table_name: "constraint_probe", index_name: "constraint_probe_request_idx", is_unique: false, method: "btree",
        columns: [{ expression: "request_key DESC NULLS FIRST", isExpression: false, asc: false, nulls: "first" }],
        where: "(request_key <> '')",
      }],
    });

    expect(compareSchemaContracts(expected, actual)).toEqual([]);
    const probe = actual.tables.get("constraint_probe");
    if (!probe) throw new Error("Test contract is incomplete");
    probe.columns.get("request_key").default = "'LIVE'";
    probe.foreignKeys.get("constraint_probe_parent_fk").columnsTo = ["legacy_id"];
    probe.checks.get("constraint_probe_request_key_length").expression = "length(request_key) between 2 and 180";
    probe.uniqueConstraints.get("constraint_probe_parent_request_unique").columns = ["request_key"];
    probe.indexes.get("constraint_probe_request_idx").where = "request_key <> 'ARCHIVED'";

    const diagnostics = compareSchemaContracts(expected, actual);
    expect(diagnostics).toContain("[DEFAULT_MISMATCH] public.constraint_probe.request_key: snapshot='DRAFT', database='LIVE'");
    expect(diagnostics).toContain("[FOREIGN_KEY_MISMATCH] public.constraint_probe.constraint_probe_parent_fk differs between the latest Drizzle snapshot and PostgreSQL");
    expect(diagnostics).toContain("[CHECK_MISMATCH] public.constraint_probe.constraint_probe_request_key_length differs between the latest Drizzle snapshot and PostgreSQL");
    expect(diagnostics).toContain("[UNIQUE_CONSTRAINT_MISMATCH] public.constraint_probe.constraint_probe_parent_request_unique differs between the latest Drizzle snapshot and PostgreSQL");
    expect(diagnostics).toContain("[INDEX_MISMATCH] public.constraint_probe.constraint_probe_request_idx differs between the latest Drizzle snapshot and PostgreSQL");
  });

  it("uses the migration-owned contract for hand-authored constraints omitted from the historical baseline", async () => {
    const commentedInlineUnique = parseMigrationOwnedConstraintContract(`
      CREATE TABLE inline_unique_comment_probe (
        -- This comment intentionally precedes the inline constraint.
        organization_id uuid NOT NULL UNIQUE
      );
    `);
    expect(commentedInlineUnique.get("inline_unique_comment_probe")?.uniqueConstraints.get("inline_unique_comment_probe_organization_id_key"))
      .toEqual({
        columns: ["organization_id"],
        name: "inline_unique_comment_probe_organization_id_key",
        nullsNotDistinct: false,
      });

    const parsed = parseMigrationOwnedConstraintContract(`
      CREATE TABLE constraint_probe (
        parent_id uuid NOT NULL,
        request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 180),
        legacy_token uuid,
        CONSTRAINT constraint_probe_parent_request_unique UNIQUE (parent_id, request_key),
        CONSTRAINT constraint_probe_request_key_shape CHECK (request_key ~ '^[a-z]+$'),
        CONSTRAINT constraint_probe_retired_check CHECK (parent_id IS NOT NULL),
        CONSTRAINT constraint_probe_legacy_check CHECK (legacy_token IS NOT NULL),
        CONSTRAINT constraint_probe_legacy_unique UNIQUE (legacy_token),
        CONSTRAINT constraint_probe_legacy_fk FOREIGN KEY (legacy_token)
          REFERENCES constraint_parent(id),
        CONSTRAINT constraint_probe_parent_fk FOREIGN KEY (parent_id)
          REFERENCES constraint_parent(id) ON DELETE RESTRICT
      );
      --> statement-breakpoint
      ALTER TABLE constraint_probe
        ADD CONSTRAINT constraint_probe_parent_check CHECK (parent_id IS NOT NULL);
      --> statement-breakpoint
      CREATE UNIQUE INDEX constraint_probe_request_key_idx
        ON constraint_probe USING btree (request_key DESC NULLS FIRST)
        WHERE request_key <> '';
      --> statement-breakpoint
      DROP INDEX constraint_probe_request_key_idx;
      --> statement-breakpoint
      ALTER TABLE constraint_probe DROP COLUMN legacy_token;
      --> statement-breakpoint
      ALTER TABLE constraint_probe DROP CONSTRAINT constraint_probe_retired_check;
    `);
    const chronologicalParsed = parsed as typeof parsed & {
      droppedColumns: Map<string, Set<string>>;
      droppedConstraints: Map<string, Set<string>>;
      droppedIndexes: Set<string>;
    };
    expect(parsed.get("constraint_probe")?.checks).toEqual(new Map([
      ["constraint_probe_request_key_check", {
        name: "constraint_probe_request_key_check", expression: "length(request_key)>=1 and length(request_key)<=180", generated: true,
      }],
      ["constraint_probe_request_key_shape", {
        name: "constraint_probe_request_key_shape", expression: "request_key~'^[a-z]+$'", generated: false,
      }],
      ["constraint_probe_parent_check", {
        name: "constraint_probe_parent_check", expression: "parent_id is not null", generated: false,
      }],
    ]));
    expect(parsed.get("constraint_probe")?.foreignKeys.get("constraint_probe_parent_fk")).toEqual({
      columnsFrom: ["parent_id"],
      columnsTo: ["id"],
      name: "constraint_probe_parent_fk",
      onDelete: "restrict",
      onUpdate: "no action",
      tableTo: "constraint_parent",
    });
    expect(parsed.get("constraint_probe")?.indexes.has("constraint_probe_request_key_idx")).toBe(false);
    expect(chronologicalParsed.droppedIndexes).toEqual(new Set(["constraint_probe_request_key_idx"]));
    expect(chronologicalParsed.droppedColumns.get("constraint_probe")).toEqual(new Set(["legacy_token"]));
    expect(chronologicalParsed.droppedConstraints.get("constraint_probe")).toEqual(new Set(["constraint_probe_retired_check"]));
    expect(parsed.get("constraint_probe")?.checks.has("constraint_probe_legacy_check")).toBe(false);
    expect(parsed.get("constraint_probe")?.uniqueConstraints.has("constraint_probe_legacy_unique")).toBe(false);
    expect(parsed.get("constraint_probe")?.foreignKeys.has("constraint_probe_legacy_fk")).toBe(false);

    const historical = buildSnapshotSchemaContract({
      tables: {
        "public.constraint_probe": {
          name: "constraint_probe", schema: "", columns: {
            parent_id: { name: "parent_id", type: "uuid", notNull: true },
            request_key: { name: "request_key", type: "text", notNull: true },
          }, foreignKeys: {}, indexes: {
            constraint_probe_request_key_idx: {
              name: "constraint_probe_request_key_idx",
              columns: [{ expression: "request_key", isExpression: false, asc: true, nulls: "last" }],
              isUnique: true,
              method: "btree",
            },
          }, uniqueConstraints: {}, checkConstraints: {
            constraint_probe_retired_check: {
              name: "constraint_probe_retired_check",
              value: "parent_id IS NOT NULL",
            },
          },
        },
      },
    });
    const merged = applyMigrationOwnedConstraintContract(historical, parsed);
    expect(merged.tables.get("constraint_probe")?.checks.size).toBe(3);
    expect(merged.tables.get("constraint_probe")?.uniqueConstraints.get("constraint_probe_parent_request_unique"))
      .toEqual({ name: "constraint_probe_parent_request_unique", columns: ["parent_id", "request_key"], nullsNotDistinct: false });
    expect(merged.tables.get("constraint_probe")?.indexes.get("constraint_probe_parent_request_unique"))
      .toMatchObject({ isUnique: true, method: "btree" });
    expect(merged.tables.get("constraint_probe")?.indexes.has("constraint_probe_request_key_idx")).toBe(false);

    const journalSnapshot = {
      tables: new Map([["journal_entries", {
        checks: new Map(),
        columns: new Map(),
        foreignKeys: new Map([["journal_entries_ledger_id_ledgers_id_fk", {
          columnsFrom: ["ledger_id"], columnsTo: ["id"], name: "journal_entries_ledger_id_ledgers_id_fk",
          onDelete: "restrict", onUpdate: "no action", tableTo: "ledgers",
        }]]),
        indexes: new Map(),
        name: "journal_entries",
        uniqueConstraints: new Map(),
      }]]),
    };
    const journalOverlay = parseMigrationOwnedConstraintContract(`
      ALTER TABLE journal_entries
        ADD CONSTRAINT journal_entries_tenant_ledger_entity_fk
        FOREIGN KEY (organization_id, ledger_id, legal_entity_id)
        REFERENCES ledgers (organization_id, id, legal_entity_id);
    `);
    const journalMerged = applyMigrationOwnedConstraintContract(journalSnapshot, journalOverlay);
    expect([...journalMerged.tables.get("journal_entries")!.foreignKeys.keys()]).toEqual([
      "journal_entries_ledger_id_ledgers_id_fk",
      "journal_entries_tenant_ledger_entity_fk",
    ]);

    const migrationContract = await loadMigrationOwnedConstraintContract();
    const counts = [...migrationContract.values()].reduce(
      (total, table) => ({
        checks: total.checks + table.checks.size,
        foreignKeys: total.foreignKeys + table.foreignKeys.size,
        indexes: total.indexes + table.indexes.size,
        uniqueConstraints: total.uniqueConstraints + table.uniqueConstraints.size,
      }),
      { checks: 0, foreignKeys: 0, indexes: 0, uniqueConstraints: 0 },
    );
    expect(counts).toEqual({ checks: 174, foreignKeys: 106, indexes: 116, uniqueConstraints: 53 });
    expect(migrationContract.get("bank_connections")?.checks.get("bank_connections_provider_check"))
      .toMatchObject({ expression: "provider='SIMPLEFIN'" });
    expect(migrationContract.get("bank_match_allocations")?.checks.get("bank_match_allocations_command_hash_sha256"))
      .toMatchObject({ expression: "command_hash~'^(?:[0-9a-f]{64}|legacy-bank-match:[0-9a-f-]{36})$'" });
    expect(migrationContract.get("bank_match_allocations")?.foreignKeys.get("bank_match_allocations_org_session_fk"))
      .toMatchObject({ columnsFrom: ["organization_id", "reconciliation_session_id"], columnsTo: ["organization_id", "id"], tableTo: "bank_reconciliation_sessions" });
    expect(migrationContract.get("demo_sandbox_slots")?.uniqueConstraints.has("demo_sandbox_slots_lease_session_id_key"))
      .toBe(false);
    expect(migrationContract.get("auth_organization_signups")?.uniqueConstraints.get("auth_organization_signups_organization_id_key"))
      .toEqual({
        columns: ["organization_id"],
        name: "auth_organization_signups_organization_id_key",
        nullsNotDistinct: false,
      });
    expect(migrationContract.get("auth_organization_signups")?.checks.has("auth_organization_signups_supported_currency_check"))
      .toBe(false);
    expect([
      migrationContract.get("fiscal_periods")?.exclusionConstraints?.get("fiscal_periods_no_overlapping_dates"),
      migrationContract.get("entity_tax_registrations")?.exclusionConstraints?.get("entity_tax_registrations_regime_window_exclusion"),
      migrationContract.get("bank_reconciliation_sessions")?.exclusionConstraints?.get("bank_reconciliation_sessions_active_account_period_exclude"),
    ]).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "gist" }),
      expect.objectContaining({ method: "gist" }),
      expect.objectContaining({ method: "gist", where: "status<>'VOIDED'" }),
    ]));
  });

  it("extracts inline CHECKs after typed-column parentheses and applies PostgreSQL constraint identifiers", () => {
    const longTable = "constraint_identity_table_name_that_is_long_enough_to_exceed_postgres_limit";
    const longColumn = "column_name_that_is_also_long_enough_to_force_constraint_name_truncation";
    const parsed = parseMigrationOwnedConstraintContract(`
      CREATE TABLE ${longTable} (
        ${longColumn} numeric(38, 18) NOT NULL CHECK (${longColumn} > 0)
      );
    `);
    const generatedName = `${longTable}_${longColumn}_check`;
    const identifier = normalizePostgresConstraintIdentifier(generatedName);
    expect(Buffer.byteLength(identifier, "utf8")).toBeLessThanOrEqual(63);
    expect(parsed.get(longTable)?.checks.get(generatedName)).toMatchObject({ expression: `${longColumn}>0`, generated: true });

    const expected = { tables: new Map([[longTable, {
      checks: parsed.get(longTable)!.checks, columns: new Map(), exclusionConstraints: new Map(), foreignKeys: new Map(),
      indexes: new Map(), name: longTable, uniqueConstraints: new Map(),
    }]]) };
    const actual = { tables: new Map([[longTable, {
      checks: new Map([[identifier, { expression: `${longColumn}>0`, name: identifier }]]), columns: new Map(),
      exclusionConstraints: new Map(), foreignKeys: new Map(), indexes: new Map(), name: longTable, uniqueConstraints: new Map(),
    }]]) };
    expect(compareSchemaContracts(expected, actual)).toEqual([]);

    const firstColumn = "column_name_that_is_also_long_enough_to_force_constraint_name_collision_a";
    const secondColumn = "column_name_that_is_also_long_enough_to_force_constraint_name_collision_b";
    const collisionParsed = parseMigrationOwnedConstraintContract(`
      CREATE TABLE ${longTable} (
        ${firstColumn} integer CHECK (${firstColumn} > 0),
        ${secondColumn} integer CHECK (${secondColumn} > 0)
      );
    `);
    const collisionChecks = collisionParsed.get(longTable)!.checks;
    const collisionActual = { tables: new Map([[longTable, {
      checks: new Map([...collisionChecks.values()].map((check, position) => [
        `${normalizePostgresConstraintIdentifier(check.name).slice(0, 61)}_${position + 1}`,
        { expression: check.expression, name: `${normalizePostgresConstraintIdentifier(check.name).slice(0, 61)}_${position + 1}` },
      ])), columns: new Map(), exclusionConstraints: new Map(), foreignKeys: new Map(), indexes: new Map(), name: longTable, uniqueConstraints: new Map(),
    }]]) };
    const collisionExpected = { tables: new Map([[longTable, {
      checks: collisionChecks, columns: new Map(), exclusionConstraints: new Map(), foreignKeys: new Map(), indexes: new Map(), name: longTable, uniqueConstraints: new Map(),
    }]]) };
    expect(compareSchemaContracts(collisionExpected, collisionActual)).toEqual([]);
  });

  it("compares exclusion constraints separately from ordinary indexes", () => {
    const exclusion = {
      elements: [
        { expression: "organization_id", operator: "=" },
        { expression: "daterange(starts_on,ends_on,'[]')", operator: "&&" },
      ],
      method: "gist",
      name: "fiscal_periods_no_overlapping_dates",
      where: null,
    };
    const table = (selectedExclusion: typeof exclusion) => ({
      checks: new Map(), columns: new Map(), exclusionConstraints: new Map([[selectedExclusion.name, selectedExclusion]]),
      foreignKeys: new Map(), indexes: new Map(), name: "fiscal_periods", uniqueConstraints: new Map(),
    });
    const expected = { tables: new Map([["fiscal_periods", table(exclusion)]]) };
    const actual = { tables: new Map([["fiscal_periods", table({ ...exclusion, method: "btree" })]]) };
    expect(compareSchemaContracts(expected, actual)).toContain(
      "[EXCLUSION_CONSTRAINT_MISMATCH] public.fiscal_periods.fiscal_periods_no_overlapping_dates differs between the latest Drizzle snapshot and PostgreSQL",
    );
  });

  it("accepts exact table, column, type, nullability, and RLS parity", () => {
    const expected = buildSnapshotSchemaContract(snapshot());
    const actual = matchingDatabaseContract();

    expect(compareSchemaContracts(expected, actual)).toEqual([]);
    expect(expected.tables.get("organizations")?.forceRls).toBe(true);
    expect(expected.tables.get("journal_lines")?.forceRls).toBe(true);
  });

  it("accepts the ownership-following policy contract for control-plane tables", () => {
    const expected = buildSnapshotSchemaContract({
      tables: {
        "public.auth_sessions": {
          name: "auth_sessions",
          schema: "",
          columns: {
            id: { name: "id", type: "uuid", notNull: true },
          },
        },
      },
    });
    const ownerExpression = "(CURRENT_USER = pg_catalog.pg_get_userbyid(( SELECT owner_relation.relowner FROM pg_catalog.pg_class owner_relation WHERE (owner_relation.oid = 'public.auth_sessions'::regclass))))";
    const actual = buildDatabaseSchemaContract({
      tableRows: [{ table_name: "auth_sessions" }],
      columnRows: [{
        table_name: "auth_sessions",
        column_name: "id",
        is_nullable: "NO",
        data_type: "uuid",
        udt_name: "uuid",
      }],
      rlsRows: [{ table_name: "auth_sessions", rls_enabled: true, force_rls: true }],
      policyRows: [{
        table_name: "auth_sessions",
        policy_name: "auth_sessions_owner_only_policy",
        command: "ALL",
        permissive: true,
        roles: ["PUBLIC"],
        using_expression: ownerExpression,
        with_check_expression: ownerExpression,
      }],
    });

    expect(expected.tables.get("auth_sessions")?.forceRls).toBe(true);
    expect(compareSchemaContracts(expected, actual)).toEqual([]);
  });

  it("keeps every preserved pre-0025 tenant policy name exact", () => {
    const tableNames = ["ledger_posting_policies", "organization_invitations"] as const;
    const expected = buildSnapshotSchemaContract({
      tables: Object.fromEntries(tableNames.map((tableName) => [
        `public.${tableName}`,
        {
          name: tableName,
          schema: "",
          columns: {
            organization_id: { name: "organization_id", type: "uuid", notNull: true },
          },
        },
      ])),
    });
    const actual = buildDatabaseSchemaContract({
      tableRows: tableNames.map((table_name) => ({ table_name })),
      columnRows: tableNames.map((table_name) => ({
        table_name,
        column_name: "organization_id",
        is_nullable: "NO",
        data_type: "uuid",
        udt_name: "uuid",
      })),
      rlsRows: tableNames.map((table_name) => ({ table_name, rls_enabled: true, force_rls: true })),
      policyRows: [
        {
          table_name: "ledger_posting_policies",
          policy_name: "tenant_isolation",
          command: "ALL",
          permissive: true,
          roles: ["PUBLIC"],
          using_expression: "(organization_id = app.current_organization_id())",
          with_check_expression: "(organization_id = app.current_organization_id())",
        },
        {
          table_name: "organization_invitations",
          policy_name: "organization_invitations_tenant_policy",
          command: "ALL",
          permissive: true,
          roles: ["PUBLIC"],
          using_expression: "(organization_id = app.current_organization_id())",
          with_check_expression: "(organization_id = app.current_organization_id())",
        },
      ],
    });

    expect(compareSchemaContracts(expected, actual)).toEqual([]);

    actual.tables.get("organization_invitations")?.policies.splice(0, 1, {
      command: "ALL",
      name: "tenant_isolation",
      permissive: true,
      roles: ["PUBLIC"],
      usingExpression: "organization_id = app.current_organization_id()",
      withCheckExpression: "organization_id = app.current_organization_id()",
    });
    expect(compareSchemaContracts(expected, actual)).toEqual([
      "[RLS_POLICY_EXPECTED_MISSING] public.organization_invitations must define reviewed RLS policy organization_invitations_tenant_policy",
      "[RLS_POLICY_EXTRA] public.organization_invitations has unreviewed RLS policy tenant_isolation",
    ]);
  });

  it("rejects an RLS/FORCE table without an explicit policy", () => {
    const expected = buildSnapshotSchemaContract(snapshot());
    const actual = matchingDatabaseContract();
    const journalLines = actual.tables.get("journal_lines");
    if (!journalLines) throw new Error("Test contract is incomplete");
    journalLines.policies.length = 0;

    expect(compareSchemaContracts(expected, actual)).toEqual([
      "[RLS_POLICY_MISSING] public.journal_lines must define at least one explicit row-level security policy",
    ]);
  });

  it("rejects extra or permissive RLS policies even when the reviewed policy remains", () => {
    const expected = buildSnapshotSchemaContract(snapshot());
    const actual = matchingDatabaseContract();
    const organizations = actual.tables.get("organizations");
    if (!organizations) throw new Error("Test contract is incomplete");
    organizations.policies.push({
      command: "ALL",
      name: "ci_schema_verifier_leak",
      permissive: true,
      roles: ["PUBLIC"],
      usingExpression: "true",
      withCheckExpression: "true",
    });
    organizations.policies[0].usingExpression = "id = app.current_organization_id() OR true";

    const diagnostics = compareSchemaContracts(expected, actual);

    expect(diagnostics).toContain(
      "[RLS_POLICY_COUNT] public.organizations must define exactly one reviewed RLS policy; found 2",
    );
    expect(diagnostics).toContain(
      "[RLS_POLICY_EXTRA] public.organizations has unreviewed RLS policy ci_schema_verifier_leak",
    );
    expect(diagnostics).toContain(
      "[RLS_POLICY_USING] public.organizations.organizations_tenant_isolation USING predicate differs from the reviewed contract",
    );
  });

  it("rejects altered command, role, permissiveness, and WITH CHECK metadata", () => {
    const expected = buildSnapshotSchemaContract(snapshot());
    const actual = matchingDatabaseContract();
    const journalLines = actual.tables.get("journal_lines");
    if (!journalLines) throw new Error("Test contract is incomplete");
    const policy = journalLines.policies[0];
    policy.command = "SELECT";
    policy.permissive = false;
    policy.roles = ["business_finlynq_app"];
    policy.withCheckExpression = "true";

    expect(compareSchemaContracts(expected, actual)).toEqual([
      "[RLS_POLICY_COMMAND] public.journal_lines.tenant_isolation must use FOR ALL; found SELECT",
      "[RLS_POLICY_PERMISSIVE] public.journal_lines.tenant_isolation must be permissive=true",
      "[RLS_POLICY_ROLES] public.journal_lines.tenant_isolation must apply only to PUBLIC",
      "[RLS_POLICY_WITH_CHECK] public.journal_lines.tenant_isolation WITH CHECK predicate differs from the reviewed contract",
    ]);
  });

  it("reports every mismatch with qualified, actionable diagnostics", () => {
    const expected = buildSnapshotSchemaContract(snapshot());
    const actual = matchingDatabaseContract();
    const journalLines = actual.tables.get("journal_lines");
    const organizations = actual.tables.get("organizations");
    if (!journalLines || !organizations) throw new Error("Test contract is incomplete");
    journalLines.columns.delete("organization_id");
    journalLines.columns.set("legacy_amount", {
      name: "legacy_amount",
      nullable: false,
      type: "numeric(38, 9)",
    });
    journalLines.columns.set("amount", {
      name: "amount",
      nullable: false,
      type: "numeric(38, 18)",
    });
    organizations.forceRlsEnabled = false;
    organizations.policies.length = 0;
    actual.tables.set("legacy_table", {
      columns: new Map(),
      forceRlsEnabled: false,
      name: "legacy_table",
      rlsEnabled: false,
    });

    const diagnostics = compareSchemaContracts(expected, actual);

    expect(diagnostics).toContain(
      "[MISSING_COLUMN] public.journal_lines.organization_id is declared by the latest Drizzle snapshot but is absent from PostgreSQL",
    );
    expect(diagnostics).toContain(
      "[EXTRA_COLUMN] public.journal_lines.legacy_amount exists in PostgreSQL but is absent from the latest Drizzle snapshot",
    );
    expect(diagnostics).toContain(
      "[TYPE_MISMATCH] public.journal_lines.amount: snapshot=numeric(38, 9), database=numeric(38, 18)",
    );
    expect(diagnostics).toContain(
      "[NULLABILITY_MISMATCH] public.journal_lines.amount: snapshot=NULL, database=NOT NULL",
    );
    expect(diagnostics).toContain(
      "[RLS_NOT_FORCED] public.organizations must use FORCE ROW LEVEL SECURITY",
    );
    expect(diagnostics).toContain(
      "[RLS_POLICY_MISSING] public.organizations must define at least one explicit row-level security policy",
    );
    expect(diagnostics).toContain(
      "[EXTRA_TABLE] public.legacy_table exists in PostgreSQL but is absent from the latest Drizzle snapshot",
    );
  });

  it("accepts the exact reconciled runtime table and view grant matrix", () => {
    const expected = buildExpectedRuntimeGrantContract();
    const actual = matchingRuntimeGrantContract();

    expect(expected.grants.get("open_item_balances")).toEqual(new Set(["SELECT"]));
    expect(expected.functionGrants.get("public.digest(bytea, text)")).toEqual(
      new Set(["EXECUTE"]),
    );
    expect(compareRuntimeGrantContracts(actual, expected)).toEqual([]);
  });

  it("reports a missing required runtime grant", () => {
    const actual = matchingRuntimeGrantContract();
    actual.grants.get("organizations")?.delete("SELECT");

    expect(compareRuntimeGrantContracts(actual)).toContain(
      "[MISSING_GRANT] business_finlynq_app needs direct SELECT on public.organizations",
    );
  });

  it("reports direct privileges on relations omitted from the matrix", () => {
    const actual = matchingRuntimeGrantContract();
    actual.grants.set("users", new Set(["SELECT"]));

    expect(compareRuntimeGrantContracts(actual)).toContain(
      "[EXTRA_GRANT] business_finlynq_app has unreviewed direct SELECT on public.users",
    );
  });

  it("reports unsafe table, grant-option, and column privileges", () => {
    const actual = matchingRuntimeGrantContract();
    actual.grants.get("organizations")?.add("DELETE");
    actual.grantOptions.push({ privilege: "SELECT", relationName: "organizations" });
    actual.columnGrants.push({
      columnName: "email_ciphertext",
      isGrantable: false,
      privilege: "SELECT",
      relationName: "users",
    });

    const diagnostics = compareRuntimeGrantContracts(actual);

    expect(diagnostics).toContain(
      "[UNSAFE_GRANT] business_finlynq_app has unreviewed direct DELETE on public.organizations",
    );
    expect(diagnostics).toContain(
      "[UNSAFE_GRANT_OPTION] business_finlynq_app can re-grant SELECT on public.organizations",
    );
    expect(diagnostics).toContain(
      "[UNSAFE_COLUMN_GRANT] business_finlynq_app has unreviewed direct SELECT on public.users.email_ciphertext",
    );
  });

  it("reports PUBLIC grants, inherited effective privileges, and role memberships", () => {
    const actual = matchingRuntimeGrantContract();
    actual.publicGrants.push({ privilege: "SELECT", relationName: "organizations" });
    actual.publicColumnGrants.push({
      columnName: "display_name",
      privilege: "SELECT",
      relationName: "organizations",
    });
    actual.effectiveGrants.get("users")?.add("DELETE");
    if (!actual.effectiveGrants.has("users")) {
      actual.effectiveGrants.set("users", new Set(["DELETE"]));
    }
    actual.memberships.push({
      grantedRoleName: "legacy_writer",
      memberRoleName: "business_finlynq_app",
    });

    const diagnostics = compareRuntimeGrantContracts(actual);

    expect(diagnostics).toContain(
      "[PUBLIC_GRANT] PUBLIC has SELECT on public.organizations; runtime access must be explicit",
    );
    expect(diagnostics).toContain(
      "[PUBLIC_COLUMN_GRANT] PUBLIC has SELECT on public.organizations.display_name; runtime access must be explicit",
    );
    expect(diagnostics).toContain(
      "[UNSAFE_EFFECTIVE_GRANT] business_finlynq_app inherits unreviewed DELETE on public.users",
    );
    expect(diagnostics).toContain(
      "[UNSAFE_ROLE_MEMBERSHIP] legacy_writer -> business_finlynq_app creates an unreviewed runtime privilege path",
    );
  });

  it("reports unsafe role, database, schema, sequence, and app-schema object privileges", () => {
    const actual = matchingRuntimeGrantContract();
    actual.unsafeRoleAttributes.push({
      actualValue: true,
      attribute: "can_bypass_rls",
      expectedValue: false,
    });
    actual.databasePrivileges.push({
      granteeName: "PUBLIC",
      isGrantable: false,
      privilege: "CONNECT",
    });
    actual.schemaPrivileges.push({
      granteeName: "business_finlynq_app",
      isGrantable: false,
      privilege: "CREATE",
      schemaName: "public",
    });
    actual.unsafeObjectGrants.push({
      granteeName: "business_finlynq_app",
      isGrantable: false,
      objectIdentity: "public.legacy_sequence",
      objectKind: "sequence",
      privilege: "USAGE",
    });

    expect(compareRuntimeGrantContracts(actual)).toEqual(expect.arrayContaining([
      "[UNSAFE_ROLE_ATTRIBUTE] business_finlynq_app.can_bypass_rls is true; expected false",
      "[UNSAFE_DATABASE_GRANT] PUBLIC has CONNECT on the application database",
      "[UNSAFE_SCHEMA_GRANT] business_finlynq_app has CREATE on schema public",
      "[UNSAFE_OBJECT_GRANT] business_finlynq_app has USAGE on sequence public.legacy_sequence",
    ]));
  });

  it("reads direct column ACLs even when the same privilege exists at table level", () => {
    const verifier = readFileSync(
      join(process.cwd(), "scripts", "operations", "verify-database-schema.mjs"),
      "utf8",
    );
    const columnQuery = verifier.slice(
      verifier.indexOf("const columnGrantResult"),
      verifier.indexOf("const publicColumnGrantResult"),
    );
    expect(columnQuery).toContain("pg_catalog.aclexplode");
    expect(columnQuery).toContain("pg_catalog.array_ndims(attribute.attacl) = 1");
    expect(columnQuery).not.toContain("COALESCE(attribute.attacl, '{}'::aclitem[])");
    expect(columnQuery).toContain("privilege.grantee = selected_role.oid");
    expect(columnQuery).not.toContain("NOT pg_catalog.has_table_privilege");
  });

  it("uses dimension-safe ACL arrays for every reconciler and verifier aclexplode", () => {
    const verifier = readFileSync(
      join(process.cwd(), "scripts", "operations", "verify-database-schema.mjs"),
      "utf8",
    );
    const reconciler = readFileSync(
      join(process.cwd(), "deploy", "postgres", "010-runtime-role.sh"),
      "utf8",
    );
    for (const source of [verifier, reconciler]) {
      const aclexplodeCount = source.match(/aclexplode\(/g)?.length ?? 0;
      const arrayDimensionCount = source.match(/array_ndims\(/g)?.length ?? 0;
      expect(aclexplodeCount).toBeGreaterThan(0);
      expect(arrayDimensionCount).toBeGreaterThanOrEqual(aclexplodeCount);
      expect(source).not.toContain("'{}'::aclitem[]");
    }
  });

  it("uses a non-reserved alias for information_schema columns", () => {
    const verifier = readFileSync(
      join(process.cwd(), "scripts", "operations", "verify-database-schema.mjs"),
      "utf8",
    );
    expect(verifier).toContain("FROM information_schema.columns column_definition");
    expect(verifier).not.toContain("FROM information_schema.columns column\n");
  });

  it("casts catalog name arrays to text arrays before node-postgres reads them", () => {
    const verifier = readFileSync(
      join(process.cwd(), "scripts", "operations", "verify-database-schema.mjs"),
      "utf8",
    );
    expect(verifier).toContain("selected_role.rolname::text");
    expect(verifier).toContain("array_agg(source_attribute.attname::text ORDER BY source_key.ordinality)");
    expect(verifier).toContain("array_agg(target_attribute.attname::text ORDER BY target_key.ordinality)");
    expect(verifier).toContain("array_agg(attribute.attname::text ORDER BY constraint_key.ordinality)");
    expect(verifier).not.toContain("array_agg(source_attribute.attname ORDER BY");
    expect(verifier).not.toContain("array_agg(attribute.attname ORDER BY");
  });

  it("requires the full reviewed function allowlist and rejects public extension drift", () => {
    const actual = matchingRuntimeGrantContract();
    expect(actual.functionGrants.get("app.current_organization_id()"))
      .toEqual(new Set(["EXECUTE"]));
    actual.functionGrants.get("public.digest(text, text)")?.delete("EXECUTE");
    actual.functions.add("public.crypt(text, text)");
    actual.functionGrants.set("public.crypt(text, text)", new Set(["EXECUTE"]));
    actual.effectiveFunctionGrants.set("public.crypt(text, text)", new Set(["EXECUTE"]));
    actual.publicFunctionGrants.push({
      privilege: "EXECUTE",
      signature: "public.digest(bytea, text)",
    });

    const diagnostics = compareRuntimeGrantContracts(actual);

    expect(diagnostics).toContain(
      "[MISSING_FUNCTION_GRANT] business_finlynq_app needs direct EXECUTE on public.digest(text, text)",
    );
    expect(diagnostics).toContain(
      "[EXTRA_FUNCTION_GRANT] business_finlynq_app has unreviewed direct EXECUTE on public.crypt(text, text)",
    );
    expect(diagnostics).toContain(
      "[PUBLIC_FUNCTION_GRANT] PUBLIC has EXECUTE on public.digest(bytea, text); runtime access must be explicit",
    );
  });

  it("reports unsafe global and schema-scoped default privileges", () => {
    const expected = buildExpectedRuntimeGrantContract();
    const actual = buildDatabaseRuntimeGrantContract({
      roleRows: [{
        role_name: "business_finlynq_app",
        can_login: true,
        can_bypass_rls: false,
        is_superuser: false,
        can_create_database: false,
        can_create_role: false,
        can_replicate: false,
        inherits_privileges: false,
        connection_limit: 20,
      }],
      databasePrivilegeRows: [{
        grantee_name: "business_finlynq_app",
        privilege_type: "CONNECT",
      }],
      schemaPrivilegeRows: ["public", "app"].map((schema_name) => ({
        schema_name,
        grantee_name: "business_finlynq_app",
        privilege_type: "USAGE",
      })),
      relationRows: [...expected.grants.keys()].map((relation_name) => ({ relation_name })),
      grantRows: [...expected.grants].flatMap(([relation_name, privileges]) => (
        [...privileges].map((privilege_type) => ({ privilege_type, relation_name }))
      )),
      functionRows: [...expected.functionGrants.keys()].map((function_signature) => ({
        function_signature,
      })),
      functionGrantRows: [...expected.functionGrants].flatMap(([function_signature, privileges]) => (
        [...privileges].map((privilege_type) => ({ function_signature, privilege_type }))
      )),
      defaultPrivilegeRows: [
        {
          grantee_name: "PUBLIC",
          object_type: "function",
          owner_role_name: "postgres",
          privilege_type: "EXECUTE",
          scope_name: "<global>",
        },
        {
          grantee_name: "business_finlynq_app",
          object_type: "table",
          owner_role_name: "postgres",
          privilege_type: "INSERT",
          scope_name: "public",
        },
      ],
    });

    expect(compareRuntimeGrantContracts(actual)).toEqual(expect.arrayContaining([
      "[UNSAFE_DEFAULT_PRIVILEGE] PUBLIC receives EXECUTE on future function objects in <global> defaults owned by postgres",
      "[UNSAFE_DEFAULT_PRIVILEGE] business_finlynq_app receives INSERT on future table objects in public defaults owned by postgres",
    ]));
  });

  it("fails actionably when the reconciled runtime role is missing", () => {
    const actual = matchingRuntimeGrantContract();
    actual.roleExists = false;

    expect(compareRuntimeGrantContracts(actual)).toEqual([
      "[MISSING_ROLE] PostgreSQL role business_finlynq_app does not exist; run the reviewed runtime-role reconciler",
    ]);
  });
});
