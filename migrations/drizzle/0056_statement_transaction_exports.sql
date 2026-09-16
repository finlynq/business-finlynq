ALTER TABLE "bank_statement_imports" ALTER COLUMN "opening_balance" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ALTER COLUMN "closing_balance" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD COLUMN "import_mode" text DEFAULT 'STATEMENT_BALANCES' NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" DROP CONSTRAINT "bank_statement_imports_reconciliation_required_check";--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_mode_check" CHECK ((import_mode = 'STATEMENT_BALANCES' AND opening_balance IS NOT NULL AND closing_balance IS NOT NULL AND reconciliation_session_id IS NOT NULL) OR (import_mode = 'TRANSACTION_EXPORT' AND opening_balance IS NULL AND closing_balance IS NULL AND reconciliation_session_id IS NULL));--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_statement_import_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  imported_count integer;
  duplicate_count integer;
  excluded_count integer;
BEGIN
  SELECT
    count(*) FILTER (WHERE disposition = 'IMPORTED')::integer,
    count(*) FILTER (WHERE disposition = 'DUPLICATE')::integer,
    count(*) FILTER (WHERE disposition = 'EXCLUDED')::integer
  INTO imported_count, duplicate_count, excluded_count
  FROM bank_statement_import_rows
  WHERE organization_id = NEW.organization_id
    AND statement_import_id = NEW.id;

  IF imported_count + duplicate_count <> NEW.included_row_count
    OR duplicate_count <> NEW.duplicate_row_count
    OR excluded_count <> NEW.excluded_row_count THEN
    RAISE EXCEPTION 'Statement import row counts do not match its immutable extraction summary'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM bank_external_accounts external_account
    JOIN bank_sync_runs sync_run
      ON sync_run.organization_id = external_account.organization_id
     AND sync_run.connection_id = external_account.connection_id
     AND sync_run.id = NEW.sync_run_id
    JOIN document_inbox_items inbox_item
      ON inbox_item.organization_id = NEW.organization_id
     AND inbox_item.id = NEW.inbox_item_id
    JOIN document_evidence_assets evidence
      ON evidence.organization_id = NEW.organization_id
     AND evidence.id = NEW.evidence_asset_id
    JOIN organization_key_versions key_version
      ON key_version.organization_id = NEW.organization_id
     AND key_version.version = NEW.key_version
    WHERE external_account.organization_id = NEW.organization_id
      AND external_account.id = NEW.external_account_id
      AND external_account.active
      AND sync_run.status = 'SUCCEEDED'
      AND sync_run.requested_start_on = NEW.statement_start_on
      AND sync_run.requested_end_on = NEW.statement_end_on
      AND sync_run.account_count = 1
      AND sync_run.observation_count = NEW.included_row_count
      AND sync_run.version_count = imported_count
      AND evidence.sha256 = NEW.source_sha256
      AND evidence.owner_module = inbox_item.owner_module
      AND inbox_item.asset_id = NEW.evidence_asset_id
      AND inbox_item.sha256 = NEW.source_sha256
      AND inbox_item.completion_hash IS NOT NULL
      AND inbox_item.status IN ('READY_TO_FILE', 'FILED')
      AND key_version.active
  ) THEN
    RAISE EXCEPTION 'Statement import is not linked to its exact account, sync, inbox, evidence, and key lineage'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.import_mode = 'STATEMENT_BALANCES' AND NOT EXISTS (
    SELECT 1
    FROM bank_balance_anchors balance_anchor
    JOIN bank_reconciliation_sessions reconciliation
      ON reconciliation.organization_id = NEW.organization_id
     AND reconciliation.id = NEW.reconciliation_session_id
    WHERE balance_anchor.organization_id = NEW.organization_id
      AND balance_anchor.external_account_id = NEW.external_account_id
      AND balance_anchor.sync_run_id = NEW.sync_run_id
      AND balance_anchor.currency_code = NEW.currency_code
      AND balance_anchor.balance = NEW.closing_balance
      AND balance_anchor.balance_at::date = NEW.statement_end_on
      AND reconciliation.external_account_id = NEW.external_account_id
      AND reconciliation.statement_start_on = NEW.statement_start_on
      AND reconciliation.statement_end_on = NEW.statement_end_on
      AND reconciliation.opening_balance = NEW.opening_balance
      AND reconciliation.closing_balance = NEW.closing_balance
      AND reconciliation.currency_code = NEW.currency_code
      AND reconciliation.status = 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'Statement-balance import is not linked to its exact balance anchor and draft reconciliation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.import_mode = 'TRANSACTION_EXPORT' AND EXISTS (
    SELECT 1 FROM bank_balance_anchors balance_anchor
    WHERE balance_anchor.organization_id = NEW.organization_id
      AND balance_anchor.external_account_id = NEW.external_account_id
      AND balance_anchor.sync_run_id = NEW.sync_run_id
  ) THEN
    RAISE EXCEPTION 'Transaction-export imports cannot invent a balance anchor'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_statement_import_integrity() FROM PUBLIC;
