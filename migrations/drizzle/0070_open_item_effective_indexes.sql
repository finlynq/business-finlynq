ALTER TABLE document_settlement_allocations ADD COLUMN effective_on date;
--> statement-breakpoint
ALTER TABLE open_item_void_events ADD COLUMN effective_on date;
--> statement-breakpoint
ALTER TABLE document_inbox_processing_attempts ADD COLUMN safe_message text;
--> statement-breakpoint

UPDATE document_settlement_allocations allocation
SET effective_on = coalesce(
  CASE WHEN allocation.allocation_type = 'REVERSAL' THEN (
    SELECT journal.accounting_date
    FROM journal_entries journal
    WHERE journal.organization_id = allocation.organization_id
      AND journal.command_hash = allocation.command_hash
      AND journal.purpose = 'REVERSAL'
    ORDER BY journal.created_at, journal.id
    LIMIT 1
  ) END,
  (
    SELECT coalesce(
      nullif(source.snapshot->>'settlementDate', '')::date,
      nullif(source.snapshot->>'accountingDate', '')::date,
      nullif(source.snapshot->>'documentDate', '')::date
    )
    FROM source_documents source
    WHERE source.organization_id = allocation.organization_id
      AND source.id = allocation.payment_source_document_id
  ),
  allocation.created_at::date
);
--> statement-breakpoint
UPDATE open_item_void_events void_event
SET effective_on = coalesce(
  (
    SELECT journal.accounting_date
    FROM journal_entries journal
    WHERE journal.organization_id = void_event.organization_id
      AND journal.command_hash = void_event.command_hash
      AND journal.purpose = 'REVERSAL'
    ORDER BY journal.created_at, journal.id
    LIMIT 1
  ),
  void_event.created_at::date
);
--> statement-breakpoint
ALTER TABLE document_settlement_allocations ALTER COLUMN effective_on SET NOT NULL;
--> statement-breakpoint
ALTER TABLE open_item_void_events ALTER COLUMN effective_on SET NOT NULL;
--> statement-breakpoint
CREATE INDEX document_settlement_allocations_org_item_effective_idx
  ON document_settlement_allocations(organization_id, open_item_id, effective_on);
--> statement-breakpoint
CREATE INDEX open_item_void_events_org_item_effective_idx
  ON open_item_void_events(organization_id, open_item_id, effective_on);
--> statement-breakpoint

ALTER TABLE bank_account_cutovers DISABLE TRIGGER bank_account_cutovers_write_guard;
--> statement-breakpoint
ALTER TABLE bank_account_cutovers ADD COLUMN lineage_id uuid;
--> statement-breakpoint
ALTER TABLE bank_account_cutovers ADD COLUMN version integer;
--> statement-breakpoint
ALTER TABLE bank_account_cutovers ADD COLUMN state text;
--> statement-breakpoint
ALTER TABLE bank_account_cutovers ADD COLUMN lifecycle_effective_on date;
--> statement-breakpoint
ALTER TABLE bank_account_cutovers ADD COLUMN supersedes_cutover_id uuid;
--> statement-breakpoint
UPDATE bank_account_cutovers
SET lineage_id=id, version=1, state='ACTIVE', lifecycle_effective_on=effective_on;
--> statement-breakpoint
ALTER TABLE bank_account_cutovers ALTER COLUMN lineage_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE bank_account_cutovers ALTER COLUMN version SET NOT NULL;
--> statement-breakpoint
ALTER TABLE bank_account_cutovers ALTER COLUMN state SET NOT NULL;
--> statement-breakpoint
ALTER TABLE bank_account_cutovers ALTER COLUMN lifecycle_effective_on SET NOT NULL;
--> statement-breakpoint
ALTER TABLE bank_account_cutovers ENABLE TRIGGER bank_account_cutovers_write_guard;
--> statement-breakpoint

DROP INDEX bank_account_cutovers_reconciliation_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX bank_account_cutovers_lineage_version_unique
  ON bank_account_cutovers(organization_id, lineage_id, version);
--> statement-breakpoint
CREATE UNIQUE INDEX bank_account_cutovers_org_supersedes_unique
  ON bank_account_cutovers(organization_id, supersedes_cutover_id);
--> statement-breakpoint
ALTER TABLE bank_account_cutovers
  ADD CONSTRAINT bank_account_cutovers_version_check CHECK (version > 0);
--> statement-breakpoint
ALTER TABLE bank_account_cutovers
  ADD CONSTRAINT bank_account_cutovers_state_check CHECK (state IN ('ACTIVE', 'INACTIVE'));
--> statement-breakpoint
ALTER TABLE bank_account_cutovers
  ADD CONSTRAINT bank_account_cutovers_org_supersedes_fk
  FOREIGN KEY (organization_id, supersedes_cutover_id)
  REFERENCES bank_account_cutovers(organization_id, id) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_account_cutover_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor bank_account_cutovers%ROWTYPE;
BEGIN
  IF (NEW.version = 1 AND (
       NEW.lineage_id <> NEW.id OR NEW.supersedes_cutover_id IS NOT NULL
       OR NEW.state <> 'ACTIVE' OR NEW.lifecycle_effective_on <> NEW.effective_on
     ))
    OR (NEW.version > 1 AND NEW.supersedes_cutover_id IS NULL) THEN
    RAISE EXCEPTION 'Bank account cutover version lineage is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.version > 1 THEN
    SELECT * INTO predecessor
    FROM bank_account_cutovers cutover
    WHERE cutover.organization_id = NEW.organization_id
      AND cutover.id = NEW.supersedes_cutover_id
      AND NOT EXISTS (
        SELECT 1 FROM bank_account_cutovers successor
        WHERE successor.organization_id=cutover.organization_id
          AND successor.supersedes_cutover_id=cutover.id
      );
    IF predecessor.id IS NULL
      OR predecessor.lineage_id <> NEW.lineage_id
      OR predecessor.version <> NEW.version - 1
      OR predecessor.reconciliation_session_id <> NEW.reconciliation_session_id
      OR predecessor.successor_account_combination_id <> NEW.successor_account_combination_id
      OR NEW.lifecycle_effective_on <= predecessor.lifecycle_effective_on
      OR predecessor.state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Bank account cutover must supersede the exact active current version prospectively'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'INACTIVE' AND (
      NEW.predecessor_account_combination_id <> predecessor.predecessor_account_combination_id
      OR NEW.effective_on <> predecessor.effective_on
      OR NEW.migration_journal_line_ids <> predecessor.migration_journal_line_ids
      OR NEW.proof_snapshot <> predecessor.proof_snapshot
      OR NEW.confirmation_hash <> predecessor.confirmation_hash
    ) THEN
      RAISE EXCEPTION 'Cutover deactivation must preserve the exact committed accounting proof'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.state = 'ACTIVE' AND (
    NEW.predecessor_account_combination_id = NEW.successor_account_combination_id
    OR NOT EXISTS (
      SELECT 1
      FROM bank_reconciliation_sessions reconciliation
      JOIN account_combinations predecessor_account_combination
        ON predecessor_account_combination.organization_id = reconciliation.organization_id
       AND predecessor_account_combination.id = NEW.predecessor_account_combination_id
       AND predecessor_account_combination.entity_id = reconciliation.legal_entity_id
       AND predecessor_account_combination.ledger_id = reconciliation.ledger_id
       AND predecessor_account_combination.active
      JOIN account_combinations successor_account_combination
        ON successor_account_combination.organization_id = reconciliation.organization_id
       AND successor_account_combination.id = NEW.successor_account_combination_id
       AND successor_account_combination.entity_id = reconciliation.legal_entity_id
       AND successor_account_combination.ledger_id = reconciliation.ledger_id
       AND successor_account_combination.active
      JOIN gl_accounts predecessor_account
        ON predecessor_account.organization_id = predecessor_account_combination.organization_id
       AND predecessor_account.ledger_id = predecessor_account_combination.ledger_id
       AND predecessor_account.id = predecessor_account_combination.account_id
      JOIN gl_accounts successor_account
        ON successor_account.organization_id = successor_account_combination.organization_id
       AND successor_account.ledger_id = successor_account_combination.ledger_id
       AND successor_account.id = successor_account_combination.account_id
      WHERE reconciliation.organization_id = NEW.organization_id
        AND reconciliation.id = NEW.reconciliation_session_id
        AND reconciliation.status = 'DRAFT'
        AND reconciliation.cash_account_combination_id = successor_account_combination.id
        AND NEW.effective_on BETWEEN reconciliation.statement_start_on AND reconciliation.statement_end_on
        AND predecessor_account.class = successor_account.class
        AND predecessor_account.active AND predecessor_account.postable
        AND successor_account.active AND successor_account.postable
        AND predecessor_account.control_kind = 'NONE'
        AND successor_account.control_kind = 'NONE'
    )
  ) THEN
    RAISE EXCEPTION 'Bank account cutover scope, state, or account lineage is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_bank_account_cutover_integrity() FROM PUBLIC;
