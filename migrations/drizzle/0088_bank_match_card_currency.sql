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

  SELECT CASE WHEN line.transaction_currency = reconciliation.currency_code
      THEN line.debit_transaction - line.credit_transaction
      ELSE line.debit_functional - line.credit_functional END
  INTO journal_line_amount
  FROM bank_reconciliation_sessions reconciliation
  JOIN journal_lines line
    ON line.organization_id = reconciliation.organization_id
   AND line.id = NEW.journal_line_id
  JOIN journal_entries journal
    ON journal.organization_id = line.organization_id
   AND journal.id = line.journal_entry_id
   AND journal.status = 'POSTED'
  JOIN ledgers ledger
    ON ledger.organization_id = journal.organization_id
   AND ledger.id = journal.ledger_id
  JOIN account_combinations combination
    ON combination.organization_id = line.organization_id
   AND combination.id = line.account_combination_id
  JOIN gl_accounts account
    ON account.organization_id = combination.organization_id
   AND account.id = combination.account_id
  WHERE reconciliation.organization_id = NEW.organization_id
    AND reconciliation.id = NEW.reconciliation_session_id
    AND reconciliation.status = 'DRAFT'
    AND (line.transaction_currency = reconciliation.currency_code
      OR ledger.functional_currency = reconciliation.currency_code)
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
