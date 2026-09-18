import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { taxFilingTemplateDefinitionSchema } from "@/modules/tax/filing-template";

const root = process.cwd();
const migration = readFileSync(join(root, "migrations/drizzle/0054_tax_filing_reconciliation.sql"), "utf8");
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
});
