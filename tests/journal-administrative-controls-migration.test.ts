import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "migrations/drizzle/0053_journal_administrative_controls.sql",
  "utf8",
);

describe("journal administrative control migration", () => {
  it("grants a dedicated permission only to owner and organization admin templates", () => {
    expect(migration).toContain("'ledger.journal.administer'");
    expect(migration).toContain("role.key IN ('OWNER', 'ORGANIZATION_ADMIN')");
    expect(migration).toContain("organization_admin_authorize('ledger.journal.administer', true)");
    expect(migration).toContain("role.key IN ('OWNER', 'ORGANIZATION_ADMIN')");
    expect(migration).toContain("selected_authorization.is_demo");
  });

  it("blocks unsafe states and accounting dependencies before unposting or deletion", () => {
    expect(migration).toContain("selected_period_state <> 'OPEN'");
    expect(migration).toContain("Posted journals must be unposted before deletion");
    expect(migration).toContain("journal_entry_relations");
    expect(migration).toContain("bank_match_allocations");
    expect(migration).toContain("line.subledger_event_id IS NOT NULL");
    expect(migration).toContain("line.tax_snapshot_id IS NOT NULL");
    expect(migration).toContain("selected_entry.source_document_id IS NOT NULL");
  });

  it("keeps deletion as an immutable tombstone with exact replay semantics", () => {
    expect(migration).toContain("journal_transaction_controls_append_only");
    expect(migration).toContain("control.outcome = 'DELETED'");
    expect(migration).toContain("existing_control.command_hash IS DISTINCT FROM selected_command_hash");
    expect(migration).toContain("idempotent_replay boolean");
    expect(migration).not.toMatch(/DELETE FROM journal_entries/i);
    expect(migration).toContain("GRANT SELECT ON journal_transaction_controls TO business_finlynq_app");
  });

  it("audits actor, session, reason, previous state, transaction, time, and outcome", () => {
    for (const column of [
      "journal_entry_id", "previous_status", "previous_journal_number", "reason",
      "actor_id", "session_id", "request_id", "created_at", "outcome",
    ]) expect(migration).toContain(column);
    expect(migration).toContain("PERFORM app.append_tenant_business_audit(");
    expect(migration).toContain("'sessionId', selected_authorization.session_id");
    expect(migration).toContain("'journal.unpost', 'ledger.journal-unpost', 'journal_entry'");
    expect(migration).toContain("'journal.delete', 'ledger.journal-delete', 'journal_entry'");
  });
});
