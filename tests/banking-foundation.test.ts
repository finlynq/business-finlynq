import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(join(process.cwd(), "migrations", "drizzle", "0021_banking_foundation.sql"), "utf8");
const idempotencyMigration = readFileSync(join(process.cwd(), "migrations", "drizzle", "0028_bank_match_allocation_idempotency.sql"), "utf8");
const service = readFileSync(join(process.cwd(), "src", "modules", "banking", "banking-service.ts"), "utf8");
const seed = readFileSync(join(process.cwd(), "src", "modules", "onboarding", "demo-bootstrap.ts"), "utf8");
const workspace = readFileSync(join(process.cwd(), "src", "app", "_components", "banking-workspace.client.tsx"), "utf8");
const workspaceData = readFileSync(join(process.cwd(), "src", "modules", "banking", "banking-workspace.ts"), "utf8");

describe("banking persistence and workflow contract", () => {
  it("makes every manual allocation retry durable, conflict-safe, and split-capable", () => {
    expect(idempotencyMigration).toContain("legacy-bank-match:");
    expect(idempotencyMigration).toContain("DISABLE TRIGGER banking_permission_guard");
    expect(idempotencyMigration).toContain("DISABLE TRIGGER bank_immutable_record");
    expect(idempotencyMigration).toContain("ENABLE TRIGGER banking_permission_guard");
    expect(idempotencyMigration).toContain("ENABLE TRIGGER bank_immutable_record");
    expect(idempotencyMigration).toContain("bank_match_allocations_org_session_idempotency_unique");
    expect(idempotencyMigration).toContain("CREATE UNIQUE INDEX bank_match_allocations_org_session_idempotency_unique");
    expect(idempotencyMigration).toContain("command_hash");
    expect(service).toContain("banking.reconciliation.match.allocation");
    expect(service).toContain("ON CONFLICT (organization_id, reconciliation_session_id, idempotency_key) DO NOTHING");
    expect(service).toContain("matchesStoredCommandFingerprint");
    expect(service).toContain('"v1"');
    expect(service).toContain("IDEMPOTENCY_CONFLICT");
    expect(workspace).toContain("const [matchIdempotencyKey, setMatchIdempotencyKey]");
    expect(workspace).toContain("idempotencyKey: requestKey");
  });

  it("forces tenant RLS, denies delete, and registers every bank table for nightly reset", () => {
    for (const table of [
      "bank_connections", "bank_connection_credential_events", "bank_external_accounts", "bank_sync_runs",
      "bank_observations", "bank_observation_versions", "bank_balance_anchors",
      "bank_reconciliation_sessions", "bank_reconciliation_voids", "bank_match_allocations",
      "bank_match_allocation_voids", "bank_rules", "bank_rule_runs",
      "bank_draft_proposals",
    ]) {
      expect(migration).toContain(`'${table}'`);
      expect(migration).toContain(table);
    }
    expect(migration).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("IF TG_OP = 'DELETE'");
    expect(migration).not.toMatch(/GRANT\s+DELETE/i);
  });

  it("separates immutable provider evidence, voided allocations, and guarded final proof", () => {
    expect(migration).toContain("CREATE TABLE bank_observation_versions");
    expect(migration).toContain("CREATE TABLE bank_match_allocation_voids");
    expect(migration).toContain("finalized_unexplained_difference = 0");
    expect(migration).toContain("OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED'");
    expect(migration).toContain("OLD.status IN ('DRAFT', 'SUBMITTED', 'REVIEWED') AND NEW.status = 'VOIDED'");
    expect(migration).toContain("bank_reconciliation_sessions_active_account_period_unique");
    expect(migration).toContain("bank_reconciliation_sessions_active_account_period_exclude");
    expect(migration).toContain("daterange(statement_start_on, statement_end_on, '[]') WITH &&");
    expect(migration).toContain("guard_bank_reconciliation_chain");
    expect(migration).toContain("predecessor.closing_balance <> NEW.opening_balance");
    expect(service).toContain("OPENING_BALANCE_DISCONTINUITY");
    expect(service).toContain("PREVIOUS_RECONCILIATION_NOT_FINALIZED");
    expect(migration).toContain("CREATE TABLE bank_reconciliation_voids");
    expect(migration).toContain("banking.reconcile.prepare");
    expect(migration).toContain("banking.reconcile.review");
    expect(service).toContain("RECONCILIATION_NOT_BALANCED");
    expect(service).toContain("finalized_match_hash");
    expect(service).toContain("business-finlynq:bank-evidence:");
    expect(migration).toContain("business-finlynq:bank-evidence:");
    expect(workspace).toContain("stored immutable finalization snapshot");
    expect(workspace).toContain("Add exact allocation");
    expect(workspace).toContain("Void match");
    expect(workspace).toContain("Record authorized review");
    expect(workspace).toContain("Void reconciliation");
  });

  it("separates reconciliation preparation from review by permission while allowing intentional dual-role users", () => {
    const guardBody = migration.match(
      /FUNCTION app\.guard_banking_mutation\(\)[\s\S]*?END\r?\n\$\$;/,
    )?.[0] ?? "";
    expect(service).toContain("PERMISSIONS.prepareBankReconciliation");
    expect(service).toContain("PERMISSIONS.reviewBankReconciliation");
    expect(migration).toMatch(/ACCOUNTANT_APPROVER[\s\S]*banking\.reconcile\.review/);
    expect(migration).toMatch(/BOOKKEEPER_MAKER[\s\S]*banking\.reconcile\.prepare/);
    expect(migration).not.toContain("NEW.reviewed_by = OLD.created_by");
    expect(migration).not.toContain("NEW.reviewed_by = OLD.submitted_by");
    expect(workspace).toContain("workspace.permissions.reconcilePrepare");
    expect(workspace).toContain("workspace.permissions.reconcileReview");
    expect(service).toContain('session.status === "REVIEWED"');
    expect(service).toContain("RECONCILIATION_VOID_PERMISSION_REQUIRED");
    expect(guardBody).toContain("(new_row ->> 'status') = 'VOIDED'");
    expect(guardBody).toContain("(old_row ->> 'status') = 'REVIEWED'");
    expect(migration).toMatch(/TG_TABLE_NAME = 'bank_reconciliation_voids'[\s\S]*reconciliation\.status = 'REVIEWED'[\s\S]*banking\.reconcile\.review/);
    expect(guardBody).toContain("to_jsonb(NEW)");
    expect(guardBody).not.toMatch(/\bNEW\.[a-z_]+/);
    expect(workspace).toContain("A reviewed session requires review permission");
  });

  it("retains one provider row while safely versioning encrypted credential replacements and lifecycle state", () => {
    expect(migration).toContain("bank_connections_org_provider_unique");
    expect(migration).toContain("CREATE TABLE bank_connection_credential_events");
    expect(migration).toContain("bank_connection_credential_events_connection_version_unique");
    expect(migration).toContain("bank_connection_credential_events_org_idempotency_unique");
    expect(service).toContain("reauthorizeSimpleFin");
    expect(service).toContain("disableSimpleFin");
    expect(service).toContain("credential_version");
    expect(migration).toContain("bank_sync_runs_org_connection_credential_fk");
    expect(service).toContain("run.credential_version = connection.credential_version");
    expect(migration).toContain("guard_bank_connection_credential_evidence");
    expect(migration).toContain("credential replacement must advance exactly one append-only version");
    expect(service).toContain("activeCredential.credentialVersion");
    expect(service).toContain("credentials_ciphertext = $3");
    expect(service).toContain("REAUTHORIZATION_REQUIRED");
    expect(service).toContain("PROVIDER_AUTHORIZATION_REJECTED");
    expect(workspace).toContain("Reauthorize connection");
    expect(workspace).toContain("Disable feed");
  });

  it("appends non-secret banking mutations to the tenant business audit chain", () => {
    expect(migration).toContain("app.audit_banking_business_event()");
    for (const action of [
      "bank.connection.created",
      "bank.connection.reauthorized",
      "bank.account.mapping-changed",
      "bank.rule.version-created",
      "bank.reconciliation.match-created",
      "bank.reconciliation.match-voided",
      "bank.reconciliation.submitted",
      "bank.reconciliation.reviewed",
      "bank.reconciliation.finalized",
      "bank.reconciliation.voided",
    ]) expect(migration).toContain(action);
    const auditBody = migration.match(/FUNCTION app\.audit_banking_business_event\(\)[\s\S]*?END\r?\n\$\$;/)?.[0] ?? "";
    expect(auditBody).toContain("app.append_tenant_business_audit");
    expect(auditBody).not.toContain("credentials_ciphertext', NEW.credentials_ciphertext");
    expect(auditBody).not.toContain("condition_ciphertext");
    expect(auditBody).not.toContain("action_ciphertext");
    expect(auditBody).not.toContain("NEW.reason");
  });

  it("fails closed on provider currency changes and filters reconciliation evidence by its snapshotted currency", () => {
    expect(service).toContain("ACCOUNT_CURRENCY_CHANGED");
    expect(service).toContain("persistedExternal.currency_code !== account.currencyCode");
    expect(service).toMatch(/external\.currency_code = NEW\.currency_code|version\.currency_code = \$6/);
    expect(migration).toContain("bank_external_accounts_org_id_currency_unique");
    expect(migration).toContain("guard_bank_observation_currency");
    expect(migration).toContain("bank_reconciliation_sessions_org_account_currency_fk");
  });

  it("enforces the mapped entity, ledger, cash combination, account type, and currency in PostgreSQL", () => {
    expect(migration).toContain("bank_external_accounts_org_mapping_currency_unique");
    expect(migration).toContain("bank_external_accounts_org_ledger_entity_fk");
    expect(migration).toContain("bank_external_accounts_org_ledger_combination_fk");
    expect(migration).toContain("bank_reconciliation_sessions_org_account_mapping_currency_fk");
    expect(migration).toContain("bank_reconciliation_sessions_org_ledger_entity_fk");
    expect(migration).toContain("bank_reconciliation_sessions_org_ledger_combination_fk");
    expect(migration).toContain("guard_bank_external_account_mapping");
    expect(migration).toContain("account.class = 'ASSET'");
    expect(migration).toContain("account.control_kind = 'NONE'");
    expect(migration).not.toContain("ledger.functional_currency = NEW.currency_code");
    expect(migration).toContain("JOIN organization_currencies enabled_currency");
    expect(migration).toContain("enabled_currency.currency_code = NEW.currency_code");
    expect(migration).toContain("AND enabled_currency.enabled");
    expect(migration).toContain("guard_bank_currency_mapping_state");
    expect(migration).toContain("|organization-currency|");
    expect(migration).toContain("guard_bank_sync_lineage");
    expect(migration).toContain("sync_run.connection_id = external.connection_id");
    expect(migration).toContain("sync_run.status = 'RUNNING'");
    expect(migration).toContain("version.sync_run_id = NEW.sync_run_id");
    expect(seed).toContain("VALUES ($1,$2,$3,'RUNNING'");
    expect(seed).toMatch(/UPDATE bank_sync_runs SET[\s\S]*status = 'SUCCEEDED'/);
    expect(service).toContain("line.transaction_currency = $6");
    expect(migration).toContain("line.transaction_currency = reconciliation.currency_code");
    expect(service).not.toContain("ELSE line.debit_functional - line.credit_functional");
    expect(migration).toContain("guard_bank_combination_mapping_state");
    expect(migration).toContain("guard_bank_gl_account_mapping_state");
    expect(migration).toContain("guard_bank_ledger_mapping_state");
    expect(migration).toContain("guard_bank_entity_mapping_state");
    expect(migration).toContain("bank-cash-mapping|");
  });

  it("does not let updates rewrite any mutable banking record primary key", () => {
    for (const guard of [
      "guard_bank_connection_identity",
      "guard_bank_external_account_identity",
      "guard_bank_sync_transition",
      "guard_bank_reconciliation_transition",
    ]) {
      const body = migration.match(new RegExp(
        `FUNCTION app\\.${guard}\\(\\)[\\s\\S]*?END\\r?\\n\\$\\$;`,
      ))?.[0];
      expect(body, guard).toContain("NEW.id IS DISTINCT FROM OLD.id");
    }
  });

  it("serializes and caps allocations globally while releasing evidence from voided sessions", () => {
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("business-finlynq:bank-observation:");
    expect(service).toContain("business-finlynq:bank-journal-line:");
    expect(service).toMatch(/allocated_session\.status <> 'VOIDED'[\s\S]*observation_version_id = observation\.id/);
    expect(service).toMatch(/allocated_session\.status <> 'VOIDED'[\s\S]*journal_line_id = line\.id/);
    expect(service).toContain("allocation.journal_amount > 0");
    expect(service).toContain("sign(allocation.observation_amount) = sign(allocation.journal_amount)");
    expect(migration).toContain("guard_bank_match_allocation_cap");
    expect(migration).toContain("sign(observation_amount) <> sign(journal_line_amount)");
    expect(migration).toContain("The allocation exceeds globally available bank or cash-line evidence");
    expect(workspaceData).toContain("allocated_session.status <> 'VOIDED'");
  });

  it("returns reconciliation journal labels with one PostgreSQL text type", () => {
    expect(workspaceData).toContain(
      "coalesce(journal.journal_number::text, journal.description) AS journal_label",
    );
    expect(workspaceData).not.toContain(
      "coalesce(journal.journal_number, journal.description) AS journal_label",
    );
  });

  it("keeps categorization manual-review-only and versions rule state append-only", () => {
    expect(migration).toContain("kind text NOT NULL CHECK (kind = 'MANUAL_REVIEW')");
    expect(migration).toContain("supersedes_rule_id");
    expect(service).toContain('kind: z.literal("MANUAL_REVIEW")');
    expect(service).toContain("versionBankRuleState");
    expect(workspace).toContain("does not turn a suggestion into a GL, AR, AP, or transfer draft");
    expect(workspace).not.toContain('<option value="GL_DRAFT">');
    expect(service).toContain("RULE_TARGET_REQUIRES_BANK_SCOPE");
    expect(service).toContain("account.control_kind = 'NONE'");
    expect(workspace).toContain("workspace.ruleTargetAccounts");
    expect(workspace).toContain("Categorization suggestions");
    expect(workspaceData).toContain("proposalDetailsResult");
  });

  it("evaluates only active leaf rule versions so inactive successors retire active ancestors", () => {
    expect(service).toMatch(
      /WHERE rule\.organization_id = \$1 AND rule\.state = 'ACTIVE'[\s\S]*AND NOT EXISTS \([\s\S]*successor\.supersedes_rule_id = rule\.id[\s\S]*\)/,
    );
    expect(service).toContain("selected.state === input.state");
    expect(service).toContain("supersedes_rule_id");
  });

  it("seeds synthetic mapped/unmapped accounts, observations, a reconciliation, and a rule without outbound credentials", () => {
    expect(seed).toContain("Synthetic nightly-reset feed");
    expect(seed).toContain("outboundProviderCallsAllowed: false");
    expect(seed).toContain("mapped: true");
    expect(seed).toContain("mapped: false");
    expect(seed).toContain("bank_observation_versions");
    expect(seed).toContain("bank_reconciliation_sessions");
    expect(seed).toContain("Review bank fees");
    expect(seed).toMatch(
      /await seedDemoBankingData\(client, identity, foundations\);[\s\S]*await clearDemoSeedApplicationContext\(client\);/,
    );
    expect(seed).toContain("set_config('app.organization_id', '', true)");
  });

  it("keeps the repeatable fixed public template bank-free while seeding nightly-reset sandboxes", () => {
    expect(seed).toMatch(
      /if \(!identity\.publicTemplate\) \{[\s\S]*?await seedDemoBankingData\(client, identity, foundations\);[\s\S]*?await clearDemoSeedApplicationContext\(client\);[\s\S]*?\}/,
    );
    expect(seed).toContain("draft-only, bank-free baseline invariant");
    expect(seed).toContain("bank_connections !== \"0\"");
    expect(seed).toContain("bank_connections: \"1\"");
    expect(seed).toContain("bank_accounts: \"2\"");
    expect(seed).toContain("bank_observations: \"3\"");
    expect(seed).toContain("const DEMO_BASELINE_VERSION = 6");
    expect(seed).toContain("slot.baseline_version < $2");
    expect(seed).toContain('slot?.state === "READY" && slot.baseline_version < DEMO_BASELINE_VERSION');
  });
});
