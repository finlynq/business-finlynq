import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { taxFilingTemplateDefinitionSchema } from "@/modules/tax/filing-template";

const root = process.cwd();
const migration = readFileSync(join(root, "migrations/drizzle/0054_tax_filing_reconciliation.sql"), "utf8");
const auditTriggerRepair = readFileSync(join(root, "migrations/drizzle/0071_ticket_60_62_hardening.sql"), "utf8");
const filingGovernance = readFileSync(join(root, "migrations/drizzle/0073_tax_filing_configuration_lifecycle.sql"), "utf8");
const filingScopeConstraints = readFileSync(join(root, "migrations/drizzle/0075_tax_filing_scope_constraints.sql"), "utf8");
const runtimeGrants = readFileSync(join(root, "deploy/postgres/010-runtime-role.sh"), "utf8");
const verifier = readFileSync(join(root, "scripts/operations/verify-database-schema.mjs"), "utf8");

describe("tax filing reconciliation migration", () => {
  it("retains the valid, digest-bound original Canadian template version", () => {
    const serialized = migration.match(/\$template\$(\{.*\})\$template\$::jsonb/)?.[1];
    expect(serialized).toBeDefined();
    const originalDefinition = taxFilingTemplateDefinitionSchema.parse(JSON.parse(serialized!));
    expect(originalDefinition.fields.filter((field) => field.kind === "ACCOUNT"))
      .toHaveLength(3);
    const digest = createHash("sha256").update(serialized!).digest("hex");
    expect(migration).toContain(`'${digest}'`);
    expect(migration).toContain("'ca.gst-hst.return', 1");
  });

  it("keeps shared templates global while forcing tenant isolation on client data", () => {
    expect(migration).not.toContain("jsonb_object_length");
    expect(migration).toContain(`"tax_filings"."reported_values" <> '{}'`);
    expect(migration.indexOf("tax_account_mapping_sets_org_id_unique"))
      .toBeLessThan(migration.indexOf("tax_account_mapping_lines_org_set_fk"));
    expect(migration).not.toContain("ALTER TABLE tax_filing_templates ENABLE ROW LEVEL SECURITY");
    for (const table of ["tax_account_mapping_sets", "tax_account_mapping_lines", "tax_filings"]) {
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY tenant_isolation ON ${table}`);
    }
    expect(migration).toContain("tax_account_mapping_sets_permission_guard");
    expect(migration).toContain("tax_filings_permission_guard");
    expect(migration).toContain("Tax mapping field, account, or ledger is invalid");
    expect(migration).toContain("Tax filing status, template, ledger, or mapping lineage is invalid");
  });

  it("makes mapping versions and filings append-only, audited, and reset-safe", () => {
    expect(migration).toContain("TG_OP <> 'INSERT'");
    expect(migration).toContain("tax.mapping.version-created");
    expect(migration).toContain("tax.filing.historical-reconciled");
    expect(migration).toContain("tax_account_mapping_set_integrity_guard");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    const reset = migration.split("INSERT INTO demo_sandbox_reset_tables")[1] ?? "";
    expect(reset.indexOf("tax_account_mapping_lines")).toBeLessThan(reset.indexOf("tax_account_mapping_sets"));
    expect(reset.indexOf("tax_filings")).toBeLessThan(reset.indexOf("tax_account_mapping_sets"));
  });

  it("audits both mapping versions and filings without accessing a missing record field", () => {
    expect(auditTriggerRepair).toContain("CREATE OR REPLACE FUNCTION app.audit_tax_filing_event()");
    expect(auditTriggerRepair).toContain("selected_row jsonb := to_jsonb(NEW)");
    expect(auditTriggerRepair).toContain("'version', selected_row -> 'version'");
    expect(auditTriggerRepair).not.toMatch(/\bNEW\.version\b/);
    expect(auditTriggerRepair).toContain("RETURN NEW");
    expect(auditTriggerRepair).toContain("REVOKE ALL ON FUNCTION app.audit_tax_filing_event() FROM PUBLIC");
  });

  it("keeps runtime grant allowlists in lockstep without update or delete access", () => {
    for (const table of ["tax_filing_templates", "tax_account_mapping_sets", "tax_account_mapping_lines", "tax_filings"]) {
      expect(runtimeGrants).toContain(`'${table}'`);
      expect(verifier).toContain(`"${table}"`);
    }
    const insertBlock = runtimeGrants.split("FOREACH selected_name IN ARRAY ARRAY[")[3]?.split("] LOOP")[0] ?? "";
    expect(insertBlock).toContain("'tax_account_mapping_sets'");
    expect(insertBlock).toContain("'tax_account_mapping_lines'");
    expect(insertBlock).toContain("'tax_filings'");
    expect(insertBlock).not.toContain("'tax_filing_templates'");
    expect(migration).toContain("REVOKE UPDATE, DELETE ON tax_filing_templates, tax_account_mapping_sets");
  });

  it("adds explicit permissions to existing and future accounting role templates", () => {
    expect(migration).toContain("'tax.mappings.manage'");
    expect(migration).toContain("'tax.filings.prepare'");
    expect(migration).toContain("assign_tax_filing_template_permissions");
    expect(migration).toContain("'OWNER', 'ACCOUNTANT_APPROVER', 'BOOKKEEPER_MAKER', 'demo_accountant'");
  });

  it("backfills filing governance without deleting templates, mappings, or workpapers", () => {
    expect(filingGovernance).toContain("WITH candidates AS");
    expect(filingGovernance).toContain("current_active_count");
    expect(filingGovernance).toContain("'NEEDS_CONFIGURATION'");
    expect(filingGovernance).toContain("configuration_id=filing.mapping_set_id");
    expect(filingGovernance).toContain("configuration_version=configuration.version");
    expect(filingGovernance).not.toMatch(/DELETE\s+FROM\s+(tax_filing_templates|tax_account_mapping_sets|tax_filings)/i);
    for (const id of [
      "f1000000-0000-4000-8000-000000000001",
      "f1000000-0000-4000-8000-000000000002",
      "f2000000-0000-4000-8000-000000000001",
      "f2000000-0000-4000-8000-000000000002",
    ]) expect(filingGovernance).not.toContain(`DELETE ${id}`);
  });

  it("creates composite self-reference targets before their foreign keys", () => {
    for (const [uniqueName, foreignKeyName] of [
      ["tax_filing_canonical_selections_org_id_unique", "tax_filing_canonical_selections_org_supersedes_fk"],
      ["tax_filing_configurations_org_id_unique", "tax_filing_configurations_org_supersedes_fk"],
      ["tax_filing_lifecycle_events_org_id_unique", "tax_filing_lifecycle_events_org_supersedes_fk"],
    ]) {
      expect(filingGovernance.indexOf(uniqueName)).toBeGreaterThan(-1);
      expect(filingGovernance.indexOf(uniqueName)).toBeLessThan(filingGovernance.indexOf(foreignKeyName));
    }
  });

  it("makes nullable registration scopes unique and filing configuration references mandatory", () => {
    expect(filingScopeConstraints).toContain("UNIQUE NULLS NOT DISTINCT");
    expect(filingScopeConstraints).toContain('"configuration_id" SET NOT NULL');
    expect(filingScopeConstraints).toContain('"configuration_version" SET NOT NULL');
    expect(filingGovernance).toContain("tax_filing_configuration_reference_guard");
    expect(filingGovernance).toContain("tax_filing_governance_integrity");
    expect(filingGovernance).toContain("tax_filing_configuration_overlap_guard");
    expect(filingGovernance).toContain("prior.effective_from<=NEW.effective_from");
    expect(filingGovernance).toContain("Tax filing replacement scope or lifecycle is invalid");
    expect(filingGovernance).toContain("candidate.valid_to >= coalesce(mapping.effective_to,mapping.effective_from)");
    expect(filingGovernance).toContain("template.effective_from<=NEW.effective_from");
    expect(filingGovernance).toContain("configuration.state='ACTIVE'");
    expect(filingGovernance).toContain("successor.effective_from<=NEW.period_end");
  });

  it("keeps the runtime app role append-only on governance tables", () => {
    for (const table of [
      "tax_filing_configurations",
      "tax_filing_lifecycle_events",
      "tax_filing_canonical_selections",
    ]) {
      expect(runtimeGrants).toContain(`'${table}'`);
      expect(verifier).toContain(`"${table}"`);
    }
    expect(filingGovernance).toContain("REVOKE UPDATE,DELETE ON tax_filing_configurations");
  });
});
