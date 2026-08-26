-- Financial invariants that remain authoritative regardless of write surface.
CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

ALTER TABLE fiscal_periods
  ADD CONSTRAINT fiscal_periods_number_check CHECK (period_number BETWEEN 1 AND 53),
  ADD CONSTRAINT fiscal_periods_dates_check CHECK (starts_on <= ends_on);
--> statement-breakpoint
ALTER TABLE legal_entities
  ADD CONSTRAINT legal_entities_code_not_reserved CHECK (upper(code) <> '0000');
--> statement-breakpoint
ALTER TABLE gl_accounts
  ADD CONSTRAINT gl_accounts_code_not_reserved CHECK (upper(code) <> '0000');
--> statement-breakpoint
ALTER TABLE segment_values
  ADD CONSTRAINT segment_values_code_not_reserved CHECK (upper(code) <> '0000'),
  ADD CONSTRAINT segment_values_code_format CHECK (upper(code) ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$');
--> statement-breakpoint
ALTER TABLE account_combinations
  ADD CONSTRAINT account_combinations_no_self_intercompany
  CHECK (intercompany_entity_id IS NULL OR intercompany_entity_id <> entity_id);
--> statement-breakpoint
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_one_functional_side CHECK (
    debit_functional >= 0 AND credit_functional >= 0 AND
    ((debit_functional > 0 AND credit_functional = 0) OR
     (credit_functional > 0 AND debit_functional = 0))
  ),
  ADD CONSTRAINT journal_lines_one_transaction_side CHECK (
    debit_transaction >= 0 AND credit_transaction >= 0 AND
    ((debit_transaction > 0 AND credit_transaction = 0) OR
     (credit_transaction > 0 AND debit_transaction = 0))
  ),
  ADD CONSTRAINT journal_lines_positive_fx_rate CHECK (fx_rate > 0);
--> statement-breakpoint
ALTER TABLE open_items
  ADD CONSTRAINT open_items_nonnegative_open_amount CHECK (open_transaction_amount >= 0),
  ADD CONSTRAINT open_items_open_not_over_original CHECK (open_transaction_amount <= abs(original_transaction_amount));
--> statement-breakpoint

CREATE UNIQUE INDEX ledgers_one_active_primary_per_entity
  ON ledgers (organization_id, legal_entity_id)
  WHERE kind = 'PRIMARY' AND active;
--> statement-breakpoint
CREATE UNIQUE INDEX account_combinations_typed_key_unique
  ON account_combinations (
    ledger_id, entity_id, account_id, subaccount_id, department_id,
    intercompany_entity_id, custom_1_id, custom_2_id, custom_3_id, custom_4_id,
    custom_5_id, custom_6_id, custom_7_id, custom_8_id
  ) NULLS NOT DISTINCT;
--> statement-breakpoint

-- Tenant-consistent reference targets.
CREATE UNIQUE INDEX ledgers_org_ledger_entity_unique
  ON ledgers (organization_id, id, legal_entity_id);
--> statement-breakpoint
CREATE UNIQUE INDEX fiscal_periods_org_ledger_id_unique
  ON fiscal_periods (organization_id, ledger_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX gl_accounts_org_ledger_id_unique
  ON gl_accounts (organization_id, ledger_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX account_combinations_org_ledger_id_unique
  ON account_combinations (organization_id, ledger_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX journal_entries_org_ledger_id_unique
  ON journal_entries (organization_id, ledger_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX party_accounts_org_ledger_id_unique
  ON party_accounts (organization_id, ledger_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX subledger_events_org_ledger_id_unique
  ON subledger_events (organization_id, ledger_id, id);
--> statement-breakpoint

ALTER TABLE ledgers
  ADD CONSTRAINT ledgers_tenant_entity_fk
  FOREIGN KEY (organization_id, legal_entity_id)
  REFERENCES legal_entities (organization_id, id);
--> statement-breakpoint
ALTER TABLE fiscal_periods
  ADD CONSTRAINT fiscal_periods_tenant_ledger_fk
  FOREIGN KEY (organization_id, ledger_id)
  REFERENCES ledgers (organization_id, id);
--> statement-breakpoint
ALTER TABLE gl_accounts
  ADD CONSTRAINT gl_accounts_tenant_ledger_fk
  FOREIGN KEY (organization_id, ledger_id)
  REFERENCES ledgers (organization_id, id);
--> statement-breakpoint
ALTER TABLE account_combinations
  ADD CONSTRAINT account_combinations_tenant_ledger_entity_fk
  FOREIGN KEY (organization_id, ledger_id, entity_id)
  REFERENCES ledgers (organization_id, id, legal_entity_id),
  ADD CONSTRAINT account_combinations_tenant_account_fk
  FOREIGN KEY (organization_id, ledger_id, account_id)
  REFERENCES gl_accounts (organization_id, ledger_id, id);
--> statement-breakpoint
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_tenant_ledger_entity_fk
  FOREIGN KEY (organization_id, ledger_id, legal_entity_id)
  REFERENCES ledgers (organization_id, id, legal_entity_id),
  ADD CONSTRAINT journal_entries_tenant_period_fk
  FOREIGN KEY (organization_id, ledger_id, period_id)
  REFERENCES fiscal_periods (organization_id, ledger_id, id);
--> statement-breakpoint
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_tenant_journal_fk
  FOREIGN KEY (organization_id, ledger_id, journal_entry_id)
  REFERENCES journal_entries (organization_id, ledger_id, id),
  ADD CONSTRAINT journal_lines_tenant_combination_fk
  FOREIGN KEY (organization_id, ledger_id, account_combination_id)
  REFERENCES account_combinations (organization_id, ledger_id, id),
  ADD CONSTRAINT journal_lines_tenant_party_account_fk
  FOREIGN KEY (organization_id, ledger_id, party_account_id)
  REFERENCES party_accounts (organization_id, ledger_id, id),
  ADD CONSTRAINT journal_lines_tenant_subledger_event_fk
  FOREIGN KEY (organization_id, ledger_id, subledger_event_id)
  REFERENCES subledger_events (organization_id, ledger_id, id);
--> statement-breakpoint
ALTER TABLE party_accounts
  ADD CONSTRAINT party_accounts_tenant_ledger_entity_fk
  FOREIGN KEY (organization_id, ledger_id, legal_entity_id)
  REFERENCES ledgers (organization_id, id, legal_entity_id),
  ADD CONSTRAINT party_accounts_tenant_party_fk
  FOREIGN KEY (organization_id, party_id)
  REFERENCES parties (organization_id, id),
  ADD CONSTRAINT party_accounts_tenant_control_account_fk
  FOREIGN KEY (organization_id, ledger_id, control_account_id)
  REFERENCES gl_accounts (organization_id, ledger_id, id);
--> statement-breakpoint
ALTER TABLE subledger_events
  ADD CONSTRAINT subledger_events_tenant_ledger_fk
  FOREIGN KEY (organization_id, ledger_id)
  REFERENCES ledgers (organization_id, id),
  ADD CONSTRAINT subledger_events_tenant_party_account_fk
  FOREIGN KEY (organization_id, ledger_id, party_account_id)
  REFERENCES party_accounts (organization_id, ledger_id, id);
--> statement-breakpoint
ALTER TABLE open_items
  ADD CONSTRAINT open_items_tenant_party_account_fk
  FOREIGN KEY (organization_id, ledger_id, party_account_id)
  REFERENCES party_accounts (organization_id, ledger_id, id),
  ADD CONSTRAINT open_items_tenant_source_event_fk
  FOREIGN KEY (organization_id, ledger_id, source_event_id)
  REFERENCES subledger_events (organization_id, ledger_id, id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN current_setting('app.organization_id', true)
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN current_setting('app.organization_id', true)::uuid
    ELSE NULL
  END
$$;
--> statement-breakpoint

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'audit_events', 'outbox_events', 'organization_key_versions',
    'organization_memberships', 'journal_entries', 'journal_entry_relations',
    'journal_lines', 'source_documents', 'account_combinations', 'fiscal_periods',
    'gl_accounts', 'ledgers', 'legal_entities', 'segment_definitions',
    'segment_values', 'open_items', 'parties', 'party_accounts', 'party_addresses',
    'subledger_events', 'entity_tax_registrations', 'tax_determination_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app.current_organization_id()) WITH CHECK (organization_id = app.current_organization_id())',
      tenant_table
    );
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant_isolation ON organizations
  USING (id = app.current_organization_id())
  WITH CHECK (id = app.current_organization_id());
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_posted_journal_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'Posted journal entries are immutable; create a linked reversal or replacement'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_posted_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.guard_posted_journal_entry();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_posted_journal_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status journal_status;
  parent_id uuid;
BEGIN
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_entry_id ELSE NEW.journal_entry_id END;
  SELECT status INTO parent_status FROM journal_entries WHERE id = parent_id;

  IF parent_status IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'Lines belonging to posted journals are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_posted_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_posted_journal_line();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.validate_journal_posting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_period fiscal_periods%ROWTYPE;
  selected_ledger ledgers%ROWTYPE;
  line_count integer;
  debit_total numeric(38,9);
  credit_total numeric(38,9);
BEGIN
  IF NEW.status <> 'POSTED' OR OLD.status = 'POSTED' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO selected_period
  FROM fiscal_periods
  WHERE id = NEW.period_id
  FOR UPDATE;

  SELECT * INTO selected_ledger
  FROM ledgers
  WHERE id = NEW.ledger_id
  FOR UPDATE;

  IF selected_period.state IN ('HARD_CLOSED', 'SEALED') THEN
    RAISE EXCEPTION 'Cannot post into a closed accounting period'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.accounting_date < selected_period.starts_on OR NEW.accounting_date > selected_period.ends_on THEN
    RAISE EXCEPTION 'Accounting date is outside the selected fiscal period'
      USING ERRCODE = '23514';
  END IF;

  IF selected_period.state = 'ADJUSTMENT_ONLY'
    AND NEW.purpose NOT IN ('ADJUSTING', 'REVERSAL', 'CLOSING', 'REVALUATION', 'TAX_ADJUSTMENT') THEN
    RAISE EXCEPTION 'Journal purpose is not permitted in an adjustment-only period'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.functional_currency <> selected_ledger.functional_currency THEN
    RAISE EXCEPTION 'Journal functional currency does not match the ledger'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*), coalesce(sum(debit_functional), 0), coalesce(sum(credit_functional), 0)
  INTO line_count, debit_total, credit_total
  FROM journal_lines
  WHERE journal_entry_id = NEW.id;

  IF line_count < 2 OR debit_total <= 0 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'Posted journal requires at least two lines and exact functional balance'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.journal_number IS NULL OR NEW.content_hash IS NULL OR NEW.posted_by IS NULL THEN
    RAISE EXCEPTION 'Posting number, content hash, and actor are required at posting'
      USING ERRCODE = '23502';
  END IF;

  NEW.total_debit_functional := debit_total;
  NEW.total_credit_functional := credit_total;
  NEW.posted_at := coalesce(NEW.posted_at, now());
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_validate_posting
  BEFORE UPDATE OF status ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.validate_journal_posting();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_successful_posting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor text;
  request_key text;
  previous_hash text;
  next_hash text;
BEGIN
  IF NEW.status <> 'POSTED' OR OLD.status = 'POSTED' THEN
    RETURN NEW;
  END IF;

  actor := nullif(current_setting('app.actor_id', true), '');
  request_key := coalesce(nullif(current_setting('app.request_id', true), ''), NEW.idempotency_key);
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Posting requires transaction-local actor context'
      USING ERRCODE = '28000';
  END IF;

  SELECT event_hash INTO previous_hash
  FROM audit_events
  WHERE organization_id = NEW.organization_id
  ORDER BY occurred_at DESC, id DESC
  LIMIT 1;

  next_hash := encode(digest(
    coalesce(previous_hash, '') || NEW.organization_id::text || NEW.id::text || request_key || 'journal.posted',
    'sha256'
  ), 'hex');

  INSERT INTO audit_events (
    organization_id, actor_type, actor_id, auth_method, source_surface,
    action, entity_type, entity_id, request_id, safe_metadata,
    previous_event_hash, event_hash
  ) VALUES (
    NEW.organization_id, 'USER_OR_SERVICE', actor,
    coalesce(nullif(current_setting('app.auth_method', true), ''), 'application'),
    coalesce(nullif(current_setting('app.source_surface', true), ''), NEW.origin::text),
    'journal.posted', 'journal_entry', NEW.id::text, request_key,
    jsonb_build_object('journalNumber', NEW.journal_number, 'contentHash', NEW.content_hash),
    previous_hash, next_hash
  );

  UPDATE ledgers
  SET first_posted_at = coalesce(first_posted_at, NEW.posted_at)
  WHERE id = NEW.ledger_id;

  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_audit_posting
  AFTER UPDATE OF status ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.audit_successful_posting();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_ledger_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.first_posted_at IS NOT NULL AND (
    NEW.functional_currency <> OLD.functional_currency OR
    NEW.accounting_profile <> OLD.accounting_profile OR
    NEW.legal_entity_id <> OLD.legal_entity_id
  ) THEN
    RAISE EXCEPTION 'Ledger entity, accounting profile, and functional currency are immutable after first posting'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ledgers_identity_immutable_after_posting
  BEFORE UPDATE ON ledgers
  FOR EACH ROW EXECUTE FUNCTION app.guard_ledger_identity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_period_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor text;
  reason text;
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'SEALED' THEN
    RAISE EXCEPTION 'A sealed period cannot be reopened by the application'
      USING ERRCODE = '55000';
  END IF;

  actor := nullif(current_setting('app.actor_id', true), '');
  reason := nullif(current_setting('app.reason', true), '');
  IF actor IS NULL OR reason IS NULL THEN
    RAISE EXCEPTION 'Period transitions require actor and reason context'
      USING ERRCODE = '28000';
  END IF;

  NEW.version := OLD.version + 1;
  NEW.closed_at := CASE WHEN NEW.state IN ('HARD_CLOSED', 'SEALED') THEN now() ELSE NULL END;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER fiscal_periods_guard_transition
  BEFORE UPDATE OF state ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION app.guard_period_transition();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();
--> statement-breakpoint
CREATE TRIGGER tax_snapshots_append_only
  BEFORE UPDATE OR DELETE ON tax_determination_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();
--> statement-breakpoint

REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
REVOKE UPDATE, DELETE ON tax_determination_snapshots FROM PUBLIC;
REVOKE DELETE ON journal_entries, journal_lines FROM PUBLIC;
