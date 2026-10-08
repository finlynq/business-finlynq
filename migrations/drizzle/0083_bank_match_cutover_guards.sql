CREATE OR REPLACE FUNCTION app.guard_bank_reconciliation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Allocation commands bump the draft version without changing its workflow state.
  -- Keep every other field immutable on this path.
  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    IF NEW.version IS DISTINCT FROM OLD.version + 1
      OR (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version') THEN
      RAISE EXCEPTION 'A draft reconciliation update may only advance its version'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.external_account_id IS DISTINCT FROM OLD.external_account_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
    OR NEW.cash_account_combination_id IS DISTINCT FROM OLD.cash_account_combination_id
    OR NEW.statement_start_on IS DISTINCT FROM OLD.statement_start_on
    OR NEW.statement_end_on IS DISTINCT FROM OLD.statement_end_on
    OR NEW.opening_balance IS DISTINCT FROM OLD.opening_balance
    OR NEW.closing_balance IS DISTINCT FROM OLD.closing_balance
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.command_hash IS DISTINCT FROM OLD.command_hash
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NOT (
      (OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED')
      OR (OLD.status = 'SUBMITTED' AND NEW.status = 'REVIEWED')
      OR (OLD.status = 'REVIEWED' AND NEW.status = 'FINALIZED')
      OR (OLD.status IN ('DRAFT', 'SUBMITTED', 'REVIEWED') AND NEW.status = 'VOIDED')
    ) THEN
    RAISE EXCEPTION 'Invalid or identity-changing bank reconciliation transition'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'SUBMITTED' AND (
    NEW.submitted_by IS DISTINCT FROM app.current_actor_id()
    OR NEW.submitted_at IS NULL
    OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
    OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
    OR NEW.finalized_by IS DISTINCT FROM OLD.finalized_by
    OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
  ) THEN
    RAISE EXCEPTION 'The current actor must submit the unchanged reconciliation'
      USING ERRCODE = '55000';
  ELSIF NEW.status = 'REVIEWED' AND (
    NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.reviewed_by IS DISTINCT FROM app.current_actor_id()
    OR NEW.reviewed_at IS NULL
    OR NEW.finalized_by IS DISTINCT FROM OLD.finalized_by
    OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
  ) THEN
    RAISE EXCEPTION 'The current authorized actor must review the unchanged reconciliation'
      USING ERRCODE = '55000';
  ELSIF NEW.status = 'FINALIZED' AND (
    NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
    OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
    OR NEW.finalized_by IS DISTINCT FROM app.current_actor_id()
    OR NEW.finalized_at IS NULL
  ) THEN
    RAISE EXCEPTION 'The current authorized actor must finalize the unchanged reconciliation'
      USING ERRCODE = '55000';
  ELSIF NEW.status = 'VOIDED' AND (
    NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
    OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
    OR NEW.finalized_by IS DISTINCT FROM OLD.finalized_by
    OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
    OR NOT EXISTS (
      SELECT 1 FROM bank_reconciliation_voids void
      WHERE void.organization_id = NEW.organization_id
        AND void.reconciliation_session_id = NEW.id
        AND void.created_by = app.current_actor_id()
    )
  ) THEN
    RAISE EXCEPTION 'A reconciliation void requires an append-only reason from the current actor'
      USING ERRCODE = '55000';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_reconciliation_transition() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_match_allocation_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  observation_lock bigint;
  journal_line_lock bigint;
  observation_amount numeric(38,9);
  journal_line_amount numeric(38,9);
  observation_limit numeric(38,9);
  journal_line_limit numeric(38,9);
  observation_used numeric(38,9);
  journal_line_used numeric(38,9);
BEGIN
  observation_lock := hashtextextended(
    'business-finlynq:bank-observation:' || NEW.observation_version_id::text, 0
  );
  journal_line_lock := hashtextextended(
    'business-finlynq:bank-journal-line:' || NEW.journal_line_id::text, 0
  );
  PERFORM pg_advisory_xact_lock(least(observation_lock, journal_line_lock));
  IF observation_lock <> journal_line_lock THEN
    PERFORM pg_advisory_xact_lock(greatest(observation_lock, journal_line_lock));
  END IF;

  SELECT version.amount
  INTO observation_amount
  FROM bank_reconciliation_sessions reconciliation
  JOIN bank_observations observation
    ON observation.organization_id = reconciliation.organization_id
   AND observation.external_account_id = reconciliation.external_account_id
  JOIN bank_observation_versions version
    ON version.organization_id = observation.organization_id
   AND version.observation_id = observation.id
   AND version.id = NEW.observation_version_id
  WHERE reconciliation.organization_id = NEW.organization_id
    AND reconciliation.id = NEW.reconciliation_session_id
    AND reconciliation.status = 'DRAFT'
    AND version.status = 'POSTED'
    AND version.currency_code = reconciliation.currency_code
    AND version.posted_on BETWEEN reconciliation.statement_start_on AND reconciliation.statement_end_on
    AND NOT EXISTS (
      SELECT 1 FROM bank_observation_versions newer
      WHERE newer.organization_id = version.organization_id
        AND newer.observation_id = version.observation_id
        AND newer.version_number > version.version_number
    );

  SELECT CASE WHEN account.class = 'LIABILITY'
      THEN line.credit_transaction - line.debit_transaction
      ELSE line.debit_transaction - line.credit_transaction END
  INTO journal_line_amount
  FROM bank_reconciliation_sessions reconciliation
  JOIN journal_lines line
    ON line.organization_id = reconciliation.organization_id
   AND line.id = NEW.journal_line_id
   AND line.transaction_currency = reconciliation.currency_code
  JOIN journal_entries journal
    ON journal.organization_id = line.organization_id
   AND journal.id = line.journal_entry_id
   AND journal.status = 'POSTED'
  JOIN account_combinations combination
    ON combination.organization_id = line.organization_id
   AND combination.id = line.account_combination_id
  JOIN gl_accounts account
    ON account.organization_id = combination.organization_id
   AND account.id = combination.account_id
  WHERE reconciliation.organization_id = NEW.organization_id
    AND reconciliation.id = NEW.reconciliation_session_id
    AND reconciliation.status = 'DRAFT'
    AND journal.accounting_date BETWEEN reconciliation.statement_start_on AND reconciliation.statement_end_on
    AND (
      line.account_combination_id = reconciliation.cash_account_combination_id
      OR EXISTS (
        SELECT 1 FROM bank_account_cutovers cutover
        WHERE cutover.organization_id = reconciliation.organization_id
          AND cutover.reconciliation_session_id = reconciliation.id
          AND cutover.predecessor_account_combination_id = line.account_combination_id
          AND journal.accounting_date <= cutover.effective_on
          AND cutover.state = 'ACTIVE'
          AND NOT EXISTS (
            SELECT 1 FROM bank_account_cutovers later_active
            WHERE later_active.organization_id = cutover.organization_id
              AND later_active.lineage_id = cutover.lineage_id
              AND later_active.state = 'ACTIVE'
              AND later_active.version > cutover.version
          )
          AND NOT EXISTS (
            SELECT 1 FROM bank_account_cutovers deactivation
            WHERE deactivation.organization_id = cutover.organization_id
              AND deactivation.lineage_id = cutover.lineage_id
              AND deactivation.state = 'INACTIVE'
              AND deactivation.version > cutover.version
              AND deactivation.lifecycle_effective_on <= journal.accounting_date
          )
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM bank_account_cutovers cutover
      WHERE cutover.organization_id = reconciliation.organization_id
        AND cutover.reconciliation_session_id = reconciliation.id
        AND cutover.migration_journal_line_ids ? line.id::text
        AND cutover.state = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM bank_account_cutovers later_active
          WHERE later_active.organization_id = cutover.organization_id
            AND later_active.lineage_id = cutover.lineage_id
            AND later_active.state = 'ACTIVE'
            AND later_active.version > cutover.version
        )
        AND NOT EXISTS (
          SELECT 1 FROM bank_account_cutovers deactivation
          WHERE deactivation.organization_id = cutover.organization_id
            AND deactivation.lineage_id = cutover.lineage_id
            AND deactivation.state = 'INACTIVE'
            AND deactivation.version > cutover.version
            AND deactivation.lifecycle_effective_on <= journal.accounting_date
        )
    );

  IF observation_amount IS NULL OR journal_line_amount IS NULL THEN
    RAISE EXCEPTION 'A bank match requires current posted evidence and an authorized posted cash line in a draft reconciliation'
      USING ERRCODE = '23514';
  END IF;
  IF observation_amount = 0 OR journal_line_amount = 0
    OR sign(observation_amount) <> sign(journal_line_amount) THEN
    RAISE EXCEPTION 'A bank match requires bank and cash-line evidence with the same non-zero direction'
      USING ERRCODE = '23514';
  END IF;
  observation_limit := abs(observation_amount);
  journal_line_limit := abs(journal_line_amount);

  SELECT coalesce(sum(allocation.allocated_amount), 0)
  INTO observation_used
  FROM bank_match_allocations allocation
  JOIN bank_reconciliation_sessions reconciliation
    ON reconciliation.organization_id = allocation.organization_id
   AND reconciliation.id = allocation.reconciliation_session_id
   AND reconciliation.status <> 'VOIDED'
  LEFT JOIN bank_match_allocation_voids void
    ON void.organization_id = allocation.organization_id
   AND void.allocation_id = allocation.id
  WHERE allocation.organization_id = NEW.organization_id
    AND allocation.observation_version_id = NEW.observation_version_id
    AND void.id IS NULL;

  SELECT coalesce(sum(allocation.allocated_amount), 0)
  INTO journal_line_used
  FROM bank_match_allocations allocation
  JOIN bank_reconciliation_sessions reconciliation
    ON reconciliation.organization_id = allocation.organization_id
   AND reconciliation.id = allocation.reconciliation_session_id
   AND reconciliation.status <> 'VOIDED'
  LEFT JOIN bank_match_allocation_voids void
    ON void.organization_id = allocation.organization_id
   AND void.allocation_id = allocation.id
  WHERE allocation.organization_id = NEW.organization_id
    AND allocation.journal_line_id = NEW.journal_line_id
    AND void.id IS NULL;

  IF observation_used + NEW.allocated_amount > observation_limit
    OR journal_line_used + NEW.allocated_amount > journal_line_limit THEN
    RAISE EXCEPTION 'The allocation exceeds globally available bank or cash-line evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_match_allocation_cap() FROM PUBLIC;
