import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0065_statement_import_eml_hardening.sql"),
  "utf8",
);

describe("statement import and EML hardening migration", () => {
  it("keeps authoritative mapping locks behind an authorized security-definer boundary", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.guard_bank_external_account_mapping()");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, public, pg_temp");
    expect(migration).toContain("NEW.organization_id IS DISTINCT FROM app.current_organization_id()");
    expect(migration).toContain("app.current_actor_id() IS NULL");
    expect(migration).toContain("app.current_actor_has_permission('banking.reconcile.prepare')");
    expect(migration).toContain("FOR SHARE OF combination, account, ledger, entity, enabled_currency");
    expect(migration).toContain("REVOKE ALL ON FUNCTION app.guard_bank_external_account_mapping() FROM PUBLIC");
  });

  it("validates EML evidence before dropping the prior MIME constraint", () => {
    const add = migration.indexOf("ADD CONSTRAINT document_evidence_assets_metadata_check_v3");
    const validate = migration.indexOf("VALIDATE CONSTRAINT document_evidence_assets_metadata_check_v3");
    const drop = migration.indexOf("DROP CONSTRAINT document_evidence_assets_metadata_check_v2");
    expect(add).toBeGreaterThanOrEqual(0);
    expect(validate).toBeGreaterThan(add);
    expect(drop).toBeGreaterThan(validate);
    expect(migration).toContain("'message/rfc822'");
    expect(migration).toContain(") NOT VALID;");
  });
});
