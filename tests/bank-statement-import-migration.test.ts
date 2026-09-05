import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMigrationOwnedConstraintContract } from "../scripts/operations/verify-database-schema.mjs";

const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0047_bank_statement_imports.sql"),
  "utf8",
);
const runtimeRole = readFileSync(
  join(process.cwd(), "deploy", "postgres", "010-runtime-role.sh"),
  "utf8",
);
const schemaVerifier = readFileSync(
  join(process.cwd(), "scripts", "operations", "verify-database-schema.mjs"),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  join(process.cwd(), "migrations", "drizzle", "meta", "_journal.json"),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

describe("bank statement import migration contract", () => {
  it("registers the generated tables and all tenant-qualified lineage edges", () => {
    expect(journal.entries.find((entry) => entry.idx === 47)).toMatchObject({
      idx: 47,
      tag: "0047_bank_statement_imports",
    });
    expect(migration).toContain('CREATE TABLE "bank_statement_imports"');
    expect(migration).toContain('CREATE TABLE "bank_statement_import_rows"');
    for (const constraint of [
      "bank_statement_imports_org_inbox_fk",
      "bank_statement_imports_org_evidence_fk",
      "bank_statement_imports_org_account_currency_fk",
      "bank_statement_imports_org_run_fk",
      "bank_statement_imports_org_reconciliation_fk",
      "bank_statement_import_rows_org_import_fk",
      "bank_statement_import_rows_org_observation_version_fk",
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }
    expect(migration).toContain("bank_statement_imports_org_evidence_unique");
    expect(migration).toContain("bank_statement_imports_org_run_unique");
  });

  it("keeps custom checks visible to the live schema verifier", () => {
    const contract = parseMigrationOwnedConstraintContract(migration);
    const imports = contract.get("bank_statement_imports");
    const rows = contract.get("bank_statement_import_rows");

    expect(imports?.checks.get("bank_statement_imports_row_counts_check")?.expression)
      .toContain("included_row_count+excluded_row_count<=1000");
    expect(imports?.checks.has("bank_statement_imports_encrypted_extraction_check")).toBe(true);
    expect(imports?.checks.has("bank_statement_imports_reconciliation_required_check")).toBe(true);
    expect(rows?.checks.has("bank_statement_import_rows_metadata_check")).toBe(true);
    expect(contract.get("bank_connections")?.checks.get("bank_connections_provider_check")?.expression)
      .toContain("FILE_IMPORT");
  });

  it("forces one-organization RLS and requires both import permissions", () => {
    for (const table of ["bank_statement_imports", "bank_statement_import_rows"]) {
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toMatch(new RegExp(
        `CREATE POLICY tenant_isolation ON ${table}\\s+USING \\(organization_id = app\\.current_organization_id\\(\\)\\)\\s+WITH CHECK \\(organization_id = app\\.current_organization_id\\(\\)\\)`,
      ));
    }
    expect(migration).toContain("app.current_actor_has_permission('banking.sync')");
    expect(migration).toContain("app.current_actor_has_permission('banking.reconcile.prepare')");
    expect(migration).toContain("(to_jsonb(NEW)->>'created_by')::uuid IS DISTINCT FROM app.current_actor_id()");
    expect(migration.match(/CREATE TRIGGER bank_statement_00_permission_guard/g)).toHaveLength(2);
  });

  it("makes imports append-only and validates row and aggregate lineage", () => {
    expect(migration).toMatch(
      /CREATE TRIGGER bank_immutable_record\s+BEFORE UPDATE OR DELETE ON bank_statement_imports/,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER bank_immutable_record\s+BEFORE UPDATE OR DELETE ON bank_statement_import_rows/,
    );
    expect(migration).toContain("CREATE FUNCTION app.guard_bank_statement_import_row()");
    expect(migration).toContain("sync_run.status = 'RUNNING'");
    expect(migration).toContain("observation.external_account_id = selected_import.external_account_id");
    expect(migration).toContain("CREATE CONSTRAINT TRIGGER bank_statement_import_integrity_guard");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("sync_run.status = 'SUCCEEDED'");
    expect(migration).toContain("inbox_item.asset_id = NEW.evidence_asset_id");
    expect(migration).toContain("evidence.sha256 = NEW.source_sha256");
  });

  it("uses account-kind-aware mapping guards and emits safe aggregate audit evidence", () => {
    expect(migration).toContain("initial_simplefin_classification boolean := false");
    expect(migration).toContain("connection.provider = 'SIMPLEFIN'");
    expect(migration).toContain("OLD.legal_entity_id IS NULL");
    expect(migration).toContain("NEW.legal_entity_id IS NOT NULL");
    expect(migration).toContain("FROM bank_reconciliation_sessions reconciliation");
    expect(migration).toContain("FROM bank_statement_imports statement_import");
    expect(migration).toContain("AND NOT initial_simplefin_classification");
    expect(migration).toContain("WHEN 'CASH' THEN 'ASSET'");
    expect(migration).toContain("WHEN 'CREDIT_CARD' THEN 'LIABILITY'");
    expect(migration).toContain("CREATE TRIGGER bank_mapped_account_insert_permission_guard");
    expect(migration).toContain("CREATE FUNCTION app.audit_bank_external_account_mapping_event()");
    expect(migration).toContain("'fromAccountKind', OLD.account_kind");
    expect(migration).toContain("'toAccountKind', NEW.account_kind");
    expect(migration).toContain("'bank.statement.imported'");
    expect(migration).toContain("'sourceSha256', NEW.source_sha256");
    const auditFunction = migration.slice(
      migration.indexOf("CREATE FUNCTION app.audit_bank_statement_import()"),
      migration.indexOf("REVOKE ALL ON FUNCTION app.audit_bank_statement_import()"),
    );
    expect(auditFunction).not.toContain("extraction_ciphertext");
    expect(auditFunction).not.toContain("row_ciphertext");
  });

  it("grants only reviewed read/insert access in migration and deployment allowlists", () => {
    expect(migration).toContain(
      "GRANT SELECT, INSERT ON bank_statement_imports, bank_statement_import_rows",
    );
    expect(migration).toContain(
      "REVOKE UPDATE, DELETE ON bank_statement_imports, bank_statement_import_rows",
    );
    for (const table of ["bank_statement_imports", "bank_statement_import_rows"]) {
      expect(runtimeRole).toContain(`'${table}'`);
      expect(schemaVerifier).toContain(`"${table}"`);
    }
  });
});
