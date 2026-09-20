import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  join(root, "migrations", "drizzle", "0066_coordinated_accounting_agent_workflows.sql"),
  "utf8",
);
const dailyTools = readFileSync(join(root, "src", "modules", "mcp", "daily-tools.ts"), "utf8");
const assetTools = readFileSync(join(root, "src", "modules", "mcp", "asset-tools.ts"), "utf8");
const setupTools = readFileSync(join(root, "src", "modules", "mcp", "setup-tools.ts"), "utf8");
const proposalService = readFileSync(
  join(root, "src", "modules", "banking", "proposal-service.ts"),
  "utf8",
);
const inboxStore = readFileSync(
  join(root, "src", "modules", "document-storage", "inbox-store.ts"),
  "utf8",
);
const filingExport = readFileSync(
  join(root, "src", "modules", "tax", "filing-export.ts"),
  "utf8",
);

const workflowTables = [
  "document_inbox_processing_attempts",
  "asset_tax_classifications",
  "asset_tax_schedules",
  "bank_account_cutovers",
  "bank_accounting_proposals",
  "tax_filing_asset_adjustments",
];

describe("coordinated accounting workflow contract", () => {
  it("forces tenant RLS and append-only permission guards on every workflow table", () => {
    for (const table of workflowTables) {
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY tenant_isolation ON ${table}`);
      expect(migration).toContain(`CREATE TRIGGER ${table}_write_guard`);
    }
    for (const permission of [
      "tax.mappings.manage",
      "tax.filings.prepare",
      "banking.reconcile.prepare",
      "banking.reconcile.review",
      "ledger.journal.draft",
    ]) expect(migration).toContain(`'${permission}'`);
    expect(migration).toContain("RAISE EXCEPTION '% is append-only'");
    expect(migration).toContain("FROM PUBLIC");
  });

  it("enforces current effective category and mapping lineage at the database boundary", () => {
    expect(migration).toContain('DISABLE TRIGGER "asset_categories_write_guard"');
    expect(migration).toContain('DISABLE TRIGGER "tax_account_mapping_sets_permission_guard"');
    expect(migration).toContain("effective_from = DATE '1900-01-01' + greatest(version - 1, 0)");
    expect(migration).toContain("lag(id) OVER");
    expect(migration).toContain('ENABLE TRIGGER "asset_categories_write_guard"');
    expect(migration).toContain('ENABLE TRIGGER "tax_account_mapping_sets_permission_guard"');
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.guard_asset_category_integrity()");
    expect(migration).toContain("successor.supersedes_category_id = category.id");
    expect(migration).toContain("category.effective_from <= NEW.in_service_on");
    expect(migration).toContain("Asset record does not match its current effective active category");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.guard_tax_account_mapping_set()");
    expect(migration).toContain("successor.supersedes_mapping_set_id = mapping.id");
    expect(migration).toContain("NEW.effective_from <= predecessor.effective_from");
    expect(migration).toContain("mapping_set.effective_from <= NEW.period_end");
    expect(migration).toContain("later.effective_from <= NEW.period_end");
  });

  it("allows only cutover-authorized predecessor cash lines and excludes migration lines", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app.guard_bank_match_allocation_cap()");
    expect(migration).toContain("cutover.predecessor_account_combination_id = line.account_combination_id");
    expect(migration).toContain("journal.accounting_date <= cutover.effective_on");
    expect(migration).toContain("cutover.migration_journal_line_ids ? line.id::text");
  });

  it("exposes the reviewed cutover, proposal, tax mapping, and CCA MCP surfaces", () => {
    for (const tool of [
      "finlynq_daily_preview_bank_account_cutover",
      "finlynq_daily_commit_bank_account_cutover",
      "finlynq_daily_list_bank_accounting_proposals",
      "finlynq_daily_get_bank_accounting_proposal",
      "finlynq_daily_prepare_bank_accounting_proposal",
      "finlynq_daily_decide_bank_accounting_proposal",
      "finlynq_daily_commit_bank_accounting_proposal",
      "finlynq_daily_list_tax_filing_workpapers",
      "finlynq_daily_preview_tax_filing_export",
      "finlynq_daily_export_tax_filing_workpaper",
    ]) expect(dailyTools).toContain(tool);
    for (const tool of [
      "finlynq_daily_asset_tax_workspace",
      "finlynq_daily_propose_asset_tax_classification",
      "finlynq_daily_save_asset_tax_classification",
      "finlynq_daily_preview_asset_tax_schedule",
      "finlynq_daily_create_asset_tax_schedule",
      "finlynq_daily_attach_asset_tax_adjustment",
    ]) expect(assetTools).toContain(tool);
    for (const tool of [
      "finlynq_setup_list_tax_account_mapping_versions",
      "finlynq_setup_preview_tax_account_mappings",
      "finlynq_setup_save_tax_account_mappings",
      "finlynq_setup_deactivate_tax_account_mappings",
    ]) expect(setupTools).toContain(tool);
  });

  it("creates proposal journals atomically and keeps EML error history without stale current errors", () => {
    expect(proposalService).toMatch(/createManualJournal\(\{[\s\S]+?\}, client\);/);
    expect(inboxStore).toContain("INSERT INTO document_inbox_processing_attempts");
    expect(inboxStore).toContain('attempt.outcome === "SUCCEEDED"');
    expect(inboxStore).toContain("delete preserved.errorCode");
    expect(inboxStore).toContain("delete preserved.reason");
    expect(inboxStore).toContain("ORDER BY created_at DESC, id DESC LIMIT 20");
  });

  it("grants only read and append access to the new protected workflow tables", () => {
    expect(migration).toContain("GRANT SELECT, INSERT ON document_inbox_processing_attempts");
    expect(migration).toContain("REVOKE UPDATE, DELETE ON document_inbox_processing_attempts");
    for (const table of workflowTables) expect(migration).toContain(table);
  });

  it("bounds tax exports and omits secrets and raw document content", () => {
    expect(filingExport).toContain("MAX_DETERMINATION_ROWS = 5_000");
    expect(filingExport).toContain("MAX_EXPORT_BYTES = 8 * 1024 * 1024");
    expect(filingExport).toContain("authorizationRechecked: true");
    expect(filingExport).toContain('exportBoundary: "REVIEW_ONLY_NO_SUBMISSION_NO_PAYMENT"');
    expect(filingExport).toContain('registration.regime_key AS "regimeKey"');
    expect(filingExport).toContain('AS "mappedBalance"');
    expect(filingExport).toContain('AS "sourceContentHash"');
    expect(filingExport).not.toContain("registration_ciphertext");
    expect(filingExport).not.toContain("configuration_evidence");
    expect(filingExport).not.toContain("document_evidence_assets");
  });
});
