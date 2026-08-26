-- Close the release-gate bypasses found during the independent accounting and
-- security review. These controls are authoritative even when a write surface
-- accidentally omits an application-level check.

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

ALTER TABLE fiscal_periods
  ADD CONSTRAINT fiscal_periods_no_overlapping_dates
  EXCLUDE USING gist (
    ledger_id WITH =,
    daterange(starts_on, ends_on, '[]') WITH &&
  );
--> statement-breakpoint

-- Tenant-qualified reference targets that were not present in the first
-- foundation migration.
CREATE UNIQUE INDEX source_documents_org_entity_id_unique
  ON source_documents (organization_id, legal_entity_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX segment_definitions_org_id_unique
  ON segment_definitions (organization_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX tax_snapshots_org_ledger_id_unique
  ON tax_determination_snapshots (organization_id, ledger_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX journal_type_definitions_identity_unique
  ON journal_type_definitions (id, key, version);
--> statement-breakpoint
CREATE UNIQUE INDEX audit_events_org_hash_unique
  ON audit_events (organization_id, event_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX organization_key_versions_one_active
  ON organization_key_versions (organization_id)
  WHERE active;
--> statement-breakpoint

ALTER TABLE account_combinations
  ADD CONSTRAINT account_combinations_tenant_intercompany_fk
    FOREIGN KEY (organization_id, intercompany_entity_id)
    REFERENCES legal_entities (organization_id, id),
  ADD CONSTRAINT account_combinations_tenant_subaccount_fk
    FOREIGN KEY (organization_id, subaccount_id)
    REFERENCES segment_values (organization_id, id),
  ADD CONSTRAINT account_combinations_tenant_department_fk
    FOREIGN KEY (organization_id, department_id)
    REFERENCES segment_values (organization_id, id),
  ADD CONSTRAINT account_combinations_tenant_custom_1_fk
    FOREIGN KEY (organization_id, custom_1_id)
    REFERENCES segment_values (organization_id, id),
  ADD CONSTRAINT account_combinations_tenant_custom_2_fk
    FOREIGN KEY (organization_id, custom_2_id)
    REFERENCES segment_values (organization_id, id),
  ADD CONSTRAINT account_combinations_tenant_custom_3_fk
    FOREIGN KEY (organization_id, custom_3_id)
    REFERENCES segment_values (organization_id, id),
  ADD CONSTRAINT account_combinations_tenant_custom_4_fk
    FOREIGN KEY (organization_id, custom_4_id)
    REFERENCES segment_values (organization_id, id),
  ADD CONSTRAINT account_combinations_tenant_custom_5_fk
    FOREIGN KEY (organization_id, custom_5_id)
    REFERENCES segment_values (organization_id, id),
  ADD CONSTRAINT account_combinations_tenant_custom_6_fk
    FOREIGN KEY (organization_id, custom_6_id)
    REFERENCES segment_values (organization_id, id),
  ADD CONSTRAINT account_combinations_tenant_custom_7_fk
    FOREIGN KEY (organization_id, custom_7_id)
    REFERENCES segment_values (organization_id, id),
  ADD CONSTRAINT account_combinations_tenant_custom_8_fk
    FOREIGN KEY (organization_id, custom_8_id)
    REFERENCES segment_values (organization_id, id);
--> statement-breakpoint

ALTER TABLE segment_values
  ADD CONSTRAINT segment_values_tenant_definition_fk
    FOREIGN KEY (organization_id, definition_id)
    REFERENCES segment_definitions (organization_id, id);
--> statement-breakpoint

ALTER TABLE parties
  ADD CONSTRAINT parties_tenant_internal_entity_fk
    FOREIGN KEY (organization_id, internal_legal_entity_id)
    REFERENCES legal_entities (organization_id, id);
--> statement-breakpoint

ALTER TABLE party_addresses
  ADD CONSTRAINT party_addresses_tenant_party_fk
    FOREIGN KEY (organization_id, party_id)
    REFERENCES parties (organization_id, id);
--> statement-breakpoint

ALTER TABLE source_documents
  ADD CONSTRAINT source_documents_tenant_entity_fk
    FOREIGN KEY (organization_id, legal_entity_id)
    REFERENCES legal_entities (organization_id, id);
--> statement-breakpoint

ALTER TABLE entity_tax_registrations
  ADD CONSTRAINT entity_tax_registrations_tenant_entity_fk
    FOREIGN KEY (organization_id, legal_entity_id)
    REFERENCES legal_entities (organization_id, id);
--> statement-breakpoint

ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_type_identity_fk
    FOREIGN KEY (journal_type_definition_id, journal_type_key, journal_type_version)
    REFERENCES journal_type_definitions (id, key, version),
  ADD CONSTRAINT journal_entries_tenant_source_document_fk
    FOREIGN KEY (organization_id, legal_entity_id, source_document_id)
    REFERENCES source_documents (organization_id, legal_entity_id, id);
--> statement-breakpoint

ALTER TABLE journal_entry_relations
  ADD CONSTRAINT journal_relations_tenant_from_fk
    FOREIGN KEY (organization_id, from_journal_id)
    REFERENCES journal_entries (organization_id, id),
  ADD CONSTRAINT journal_relations_tenant_to_fk
    FOREIGN KEY (organization_id, to_journal_id)
    REFERENCES journal_entries (organization_id, id);
--> statement-breakpoint

ALTER TABLE subledger_events
  ADD CONSTRAINT subledger_events_tenant_source_document_fk
    FOREIGN KEY (organization_id, source_document_id)
    REFERENCES source_documents (organization_id, id);
--> statement-breakpoint

ALTER TABLE tax_determination_snapshots
  ADD CONSTRAINT tax_snapshots_tenant_ledger_entity_fk
    FOREIGN KEY (organization_id, ledger_id, legal_entity_id)
    REFERENCES ledgers (organization_id, id, legal_entity_id),
  ADD CONSTRAINT tax_snapshots_tenant_source_document_fk
    FOREIGN KEY (organization_id, legal_entity_id, source_document_id)
    REFERENCES source_documents (organization_id, legal_entity_id, id);
--> statement-breakpoint

ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_tenant_tax_snapshot_fk
    FOREIGN KEY (organization_id, ledger_id, tax_snapshot_id)
    REFERENCES tax_determination_snapshots (organization_id, ledger_id, id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_actor_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN current_setting('app.actor_id', true)
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN current_setting('app.actor_id', true)::uuid
    ELSE NULL
  END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_actor_has_permission(required_permission text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organizations organization
    JOIN organization_memberships membership
      ON membership.organization_id = organization.id
    JOIN membership_roles membership_role
      ON membership_role.organization_id = membership.organization_id
     AND membership_role.membership_id = membership.id
    JOIN roles role
      ON role.organization_id = membership_role.organization_id
     AND role.id = membership_role.role_id
    JOIN role_permissions role_permission
      ON role_permission.organization_id = role.organization_id
     AND role_permission.role_id = role.id
    WHERE organization.id = app.current_organization_id()
      AND organization.active
      AND membership.user_id = app.current_actor_id()
      AND membership.active
      AND role.active
      AND role_permission.permission_key = required_permission
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.segment_value_is_valid(
  selected_organization_id uuid,
  selected_value_id uuid,
  expected_definition_key text,
  selected_accounting_date date
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT selected_value_id IS NULL OR EXISTS (
    SELECT 1
    FROM segment_values value
    JOIN segment_definitions definition
      ON definition.organization_id = value.organization_id
     AND definition.id = value.definition_id
    WHERE value.organization_id = selected_organization_id
      AND value.id = selected_value_id
      AND lower(definition.key) = lower(expected_definition_key)
      AND definition.state = 'ACTIVE_LOCKED'
      AND value.active
      AND value.valid_from <= selected_accounting_date
      AND (value.valid_to IS NULL OR value.valid_to >= selected_accounting_date)
  )
$$;
--> statement-breakpoint

-- Milestone 0 supports cross-border CAD/USD transactions. More currencies are
-- added by extending this single metadata contract in both kernel and SQL.
CREATE OR REPLACE FUNCTION app.currency_minor_units(currency_code text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE upper(currency_code)
    WHEN 'CAD' THEN 2
    WHEN 'USD' THEN 2
    ELSE NULL
  END
$$;
--> statement-breakpoint

-- A submitted/approved journal is a frozen approval candidate; a posted one is
-- immutable forever. Initial inserts can only create clean drafts.
CREATE OR REPLACE FUNCTION app.guard_journal_insert_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'DRAFT'
    OR NEW.journal_number IS NOT NULL
    OR NEW.content_hash IS NOT NULL
    OR NEW.posted_by IS NOT NULL
    OR NEW.posted_at IS NOT NULL
    OR NEW.total_debit_functional <> 0
    OR NEW.total_credit_functional <> 0 THEN
    RAISE EXCEPTION 'Journal entries must be inserted as clean drafts and posted through the posting command'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_entries_guard_insert ON journal_entries;
CREATE TRIGGER journal_entries_guard_insert
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_insert_state();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_posted_journal_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('POSTED', 'REVERSED') THEN
      RAISE EXCEPTION 'Posted journal entries are immutable; create a linked reversal or replacement'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'Posted journal entries are immutable; create a linked reversal or replacement'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'REVERSED' THEN
    RAISE EXCEPTION 'Do not mutate a posted journal to reversed; post and link a full reversal journal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IN ('SUBMITTED', 'APPROVED', 'POSTED') AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.ledger_id IS DISTINCT FROM OLD.ledger_id OR
    NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id OR
    NEW.period_id IS DISTINCT FROM OLD.period_id OR
    NEW.journal_type_definition_id IS DISTINCT FROM OLD.journal_type_definition_id OR
    NEW.journal_type_key IS DISTINCT FROM OLD.journal_type_key OR
    NEW.journal_type_version IS DISTINCT FROM OLD.journal_type_version OR
    NEW.source_document_id IS DISTINCT FROM OLD.source_document_id OR
    NEW.source_event_key IS DISTINCT FROM OLD.source_event_key OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
    NEW.origin IS DISTINCT FROM OLD.origin OR
    NEW.purpose IS DISTINCT FROM OLD.purpose OR
    NEW.accounting_date IS DISTINCT FROM OLD.accounting_date OR
    NEW.functional_currency IS DISTINCT FROM OLD.functional_currency OR
    NEW.description IS DISTINCT FROM OLD.description OR
    NEW.created_by IS DISTINCT FROM OLD.created_by
  ) THEN
    RAISE EXCEPTION 'Journal business content cannot change while submitting, approving, or posting'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'SUBMITTED' AND NEW.status NOT IN ('DRAFT', 'APPROVED', 'POSTED') THEN
    RAISE EXCEPTION 'Submitted journal content is frozen; return it to draft before editing'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'APPROVED' AND NEW.status NOT IN ('DRAFT', 'POSTED') THEN
    RAISE EXCEPTION 'Approved journal content is frozen; return it to draft before editing'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT', 'SUBMITTED', 'POSTED') THEN
    RAISE EXCEPTION 'Invalid journal workflow transition from draft'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'SUBMITTED' AND NEW.status = 'APPROVED'
    AND NOT app.current_actor_has_permission('ledger.journal.approve') THEN
    RAISE EXCEPTION 'Approval permission is required'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED'
    AND NOT app.current_actor_has_permission('ledger.journal.submit') THEN
    RAISE EXCEPTION 'Submission permission is required'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED' THEN
    NEW.content_hash := app.compute_journal_content_hash(OLD.id);
    SELECT coalesce(max(approval.journal_version), 0) + 1
    INTO NEW.approval_version
    FROM journal_approvals approval
    WHERE approval.organization_id = OLD.organization_id
      AND approval.ledger_id = OLD.ledger_id
      AND approval.journal_entry_id = OLD.id;
  END IF;

  IF OLD.status = 'SUBMITTED' AND NEW.status = 'APPROVED' AND (
    NEW.approval_version IS NULL OR NOT EXISTS (
      SELECT 1
      FROM journal_approvals approval
      WHERE approval.organization_id = OLD.organization_id
        AND approval.ledger_id = OLD.ledger_id
        AND approval.journal_entry_id = OLD.id
        AND approval.journal_version = NEW.approval_version
        AND approval.content_hash = OLD.content_hash
        AND approval.decision = 'APPROVED'
    )
  ) THEN
    RAISE EXCEPTION 'Approval transition requires an append-only approval for the frozen content'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'DRAFT' AND OLD.status IN ('SUBMITTED', 'APPROVED') THEN
    NEW.content_hash := NULL;
    NEW.approval_version := NULL;
    NEW.approved_by := NULL;
    NEW.approved_at := NULL;
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Every line mutation takes the same parent-row lock as posting. This closes
-- both the re-parenting bypass and the validate-then-edit race.
CREATE OR REPLACE FUNCTION app.guard_posted_journal_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent journal_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.organization_id <> OLD.organization_id OR
    NEW.ledger_id <> OLD.ledger_id OR
    NEW.journal_entry_id <> OLD.journal_entry_id
  ) THEN
    RAISE EXCEPTION 'A journal line cannot be moved between journals or tenants'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO parent
  FROM journal_entries
  WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.journal_entry_id ELSE OLD.journal_entry_id END
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal line parent was not found'
      USING ERRCODE = '23503';
  END IF;

  IF parent.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Submitted, approved, and posted journal lines are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP <> 'DELETE' AND (
    NEW.organization_id <> parent.organization_id OR
    NEW.ledger_id <> parent.ledger_id
  ) THEN
    RAISE EXCEPTION 'Journal line tenant and ledger must match its parent'
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint

-- Hash canonical, locked business content. Posting metadata and derived totals
-- are deliberately excluded; all financial/source inputs and ordered lines are
-- included.
CREATE OR REPLACE FUNCTION app.compute_journal_content_hash(selected_journal_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT encode(
    digest(
      convert_to(
        jsonb_build_object(
          'id', entry.id,
          'organizationId', entry.organization_id,
          'ledgerId', entry.ledger_id,
          'legalEntityId', entry.legal_entity_id,
          'periodId', entry.period_id,
          'journalTypeDefinitionId', entry.journal_type_definition_id,
          'journalTypeKey', entry.journal_type_key,
          'journalTypeVersion', entry.journal_type_version,
          'sourceDocumentId', entry.source_document_id,
          'sourceEventKey', entry.source_event_key,
          'idempotencyKey', entry.idempotency_key,
          'origin', entry.origin,
          'purpose', entry.purpose,
          'accountingDate', entry.accounting_date,
          'functionalCurrency', entry.functional_currency,
          'description', entry.description,
          'createdBy', entry.created_by,
          'lines', coalesce((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', line.id,
                'lineNumber', line.line_number,
                'accountCombinationId', line.account_combination_id,
                'debitFunctional', line.debit_functional,
                'creditFunctional', line.credit_functional,
                'transactionCurrency', line.transaction_currency,
                'debitTransaction', line.debit_transaction,
                'creditTransaction', line.credit_transaction,
                'fxRate', line.fx_rate,
                'fxRateSource', line.fx_rate_source,
                'fxRateEffectiveAt', line.fx_rate_effective_at,
                'partyAccountId', line.party_account_id,
                'subledgerEventId', line.subledger_event_id,
                'taxSnapshotId', line.tax_snapshot_id,
                'memo', line.memo
              ) ORDER BY line.line_number, line.id
            )
            FROM journal_lines line
            WHERE line.journal_entry_id = entry.id
          ), '[]'::jsonb)
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
  FROM journal_entries entry
  WHERE entry.id = selected_journal_id
    AND entry.organization_id = app.current_organization_id()
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.validate_journal_posting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_period fiscal_periods%ROWTYPE;
  selected_ledger ledgers%ROWTYPE;
  selected_type journal_type_definitions%ROWTYPE;
  selected_source source_documents%ROWTYPE;
  line_count integer;
  invalid_line_count integer;
  debit_total numeric(38,9);
  credit_total numeric(38,9);
  canonical_hash text;
BEGIN
  IF NEW.status <> 'POSTED' OR OLD.status = 'POSTED' THEN
    RETURN NEW;
  END IF;

  IF NOT app.current_actor_has_permission('ledger.journal.post') THEN
    RAISE EXCEPTION 'Posting permission is required for an active organization member'
      USING ERRCODE = '42501';
  END IF;

  IF upper(coalesce(current_setting('app.source_surface', true), '')) IN ('MCP', 'IMPORT') THEN
    RAISE EXCEPTION 'MCP and import surfaces may create drafts but cannot post journals'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO selected_period
  FROM fiscal_periods
  WHERE organization_id = NEW.organization_id
    AND ledger_id = NEW.ledger_id
    AND id = NEW.period_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal period does not belong to its tenant and ledger'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO selected_ledger
  FROM ledgers
  WHERE organization_id = NEW.organization_id
    AND legal_entity_id = NEW.legal_entity_id
    AND id = NEW.ledger_id
  FOR UPDATE;

  IF NOT FOUND OR NOT selected_ledger.active THEN
    RAISE EXCEPTION 'Journal ledger is inactive or does not belong to its tenant and entity'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO selected_type
  FROM journal_type_definitions
  WHERE id = NEW.journal_type_definition_id
    AND key = NEW.journal_type_key
    AND version = NEW.journal_type_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal type key, version, and definition do not identify one registry entry'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_document_id IS NOT NULL THEN
    SELECT * INTO selected_source
    FROM source_documents
    WHERE organization_id = NEW.organization_id
      AND legal_entity_id = NEW.legal_entity_id
      AND id = NEW.source_document_id;

    IF NOT FOUND OR selected_source.owner_module <> selected_type.owner_module THEN
      RAISE EXCEPTION 'Source document must belong to the journal tenant, entity, and owner module'
        USING ERRCODE = '23514';
    END IF;
  ELSIF selected_type.owner_module <> 'ledger' THEN
    RAISE EXCEPTION 'Source-owned journal types require an immutable source document'
      USING ERRCODE = '23502';
  END IF;

  IF selected_period.state IN ('HARD_CLOSED', 'SEALED') THEN
    RAISE EXCEPTION 'Cannot post into a closed accounting period'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.accounting_date < selected_period.starts_on OR NEW.accounting_date > selected_period.ends_on THEN
    RAISE EXCEPTION 'Accounting date is outside the selected fiscal period'
      USING ERRCODE = '23514';
  END IF;

  IF selected_period.state = 'ADJUSTMENT_ONLY' THEN
    IF NEW.purpose NOT IN ('ADJUSTING', 'REVERSAL', 'CLOSING', 'REVALUATION', 'TAX_ADJUSTMENT') THEN
      RAISE EXCEPTION 'Journal purpose is not permitted in an adjustment-only period'
        USING ERRCODE = '55000';
    END IF;

    IF NOT app.current_actor_has_permission('ledger.journal.post_adjustment') THEN
      RAISE EXCEPTION 'Adjustment posting permission is required in an adjustment-only period'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.functional_currency <> selected_ledger.functional_currency THEN
    RAISE EXCEPTION 'Journal functional currency does not match the ledger'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*), coalesce(sum(line.debit_functional), 0), coalesce(sum(line.credit_functional), 0)
  INTO line_count, debit_total, credit_total
  FROM journal_lines line
  WHERE line.organization_id = NEW.organization_id
    AND line.ledger_id = NEW.ledger_id
    AND line.journal_entry_id = NEW.id;

  IF line_count < 2 OR debit_total <= 0 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'Posted journal requires at least two lines and exact functional balance'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO invalid_line_count
  FROM journal_lines line
  JOIN account_combinations combination
    ON combination.organization_id = line.organization_id
   AND combination.ledger_id = line.ledger_id
   AND combination.id = line.account_combination_id
  JOIN gl_accounts account
    ON account.organization_id = combination.organization_id
   AND account.ledger_id = combination.ledger_id
   AND account.id = combination.account_id
  LEFT JOIN party_accounts party_account
    ON party_account.organization_id = line.organization_id
   AND party_account.ledger_id = line.ledger_id
   AND party_account.id = line.party_account_id
  LEFT JOIN subledger_events subledger_event
    ON subledger_event.organization_id = line.organization_id
   AND subledger_event.ledger_id = line.ledger_id
   AND subledger_event.id = line.subledger_event_id
  LEFT JOIN tax_determination_snapshots tax_snapshot
    ON tax_snapshot.organization_id = line.organization_id
   AND tax_snapshot.ledger_id = line.ledger_id
   AND tax_snapshot.id = line.tax_snapshot_id
  WHERE line.organization_id = NEW.organization_id
    AND line.ledger_id = NEW.ledger_id
    AND line.journal_entry_id = NEW.id
    AND (
      NOT combination.active
      OR combination.entity_id <> NEW.legal_entity_id
      OR NOT account.active
      OR NOT account.postable
      OR account.valid_from > NEW.accounting_date
      OR (account.valid_to IS NOT NULL AND account.valid_to < NEW.accounting_date)
      OR (combination.intercompany_entity_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM legal_entities intercompany
        WHERE intercompany.organization_id = NEW.organization_id
          AND intercompany.id = combination.intercompany_entity_id
          AND intercompany.active
      ))
      OR NOT app.segment_value_is_valid(NEW.organization_id, combination.subaccount_id, 'subaccount', NEW.accounting_date)
      OR NOT app.segment_value_is_valid(NEW.organization_id, combination.department_id, 'department', NEW.accounting_date)
      OR NOT app.segment_value_is_valid(NEW.organization_id, combination.custom_1_id, 'custom1', NEW.accounting_date)
      OR NOT app.segment_value_is_valid(NEW.organization_id, combination.custom_2_id, 'custom2', NEW.accounting_date)
      OR NOT app.segment_value_is_valid(NEW.organization_id, combination.custom_3_id, 'custom3', NEW.accounting_date)
      OR NOT app.segment_value_is_valid(NEW.organization_id, combination.custom_4_id, 'custom4', NEW.accounting_date)
      OR NOT app.segment_value_is_valid(NEW.organization_id, combination.custom_5_id, 'custom5', NEW.accounting_date)
      OR NOT app.segment_value_is_valid(NEW.organization_id, combination.custom_6_id, 'custom6', NEW.accounting_date)
      OR NOT app.segment_value_is_valid(NEW.organization_id, combination.custom_7_id, 'custom7', NEW.accounting_date)
      OR NOT app.segment_value_is_valid(NEW.organization_id, combination.custom_8_id, 'custom8', NEW.accounting_date)
      OR app.currency_minor_units(NEW.functional_currency) IS NULL
      OR app.currency_minor_units(line.transaction_currency) IS NULL
      OR line.debit_functional <> round(
        line.debit_functional,
        app.currency_minor_units(NEW.functional_currency)
      )
      OR line.credit_functional <> round(
        line.credit_functional,
        app.currency_minor_units(NEW.functional_currency)
      )
      OR line.debit_transaction <> round(
        line.debit_transaction,
        app.currency_minor_units(line.transaction_currency)
      )
      OR line.credit_transaction <> round(
        line.credit_transaction,
        app.currency_minor_units(line.transaction_currency)
      )
      OR (line.debit_functional > 0) <> (line.debit_transaction > 0)
      OR round(
        line.debit_transaction * line.fx_rate,
        app.currency_minor_units(NEW.functional_currency)
      ) <> line.debit_functional
      OR round(
        line.credit_transaction * line.fx_rate,
        app.currency_minor_units(NEW.functional_currency)
      ) <> line.credit_functional
      OR (line.transaction_currency = NEW.functional_currency AND line.fx_rate <> 1)
      OR (line.party_account_id IS NOT NULL AND party_account.id IS NULL)
      OR (line.subledger_event_id IS NOT NULL AND (
        subledger_event.id IS NULL
        OR subledger_event.party_account_id IS DISTINCT FROM line.party_account_id
        OR (NEW.source_document_id IS NOT NULL AND subledger_event.source_document_id <> NEW.source_document_id)
      ))
      OR (account.control_kind = 'AR' AND (
        NEW.source_document_id IS NULL
        OR
        selected_type.owner_module <> 'receivables'
        OR
        party_account.id IS NULL
        OR party_account.role <> 'CUSTOMER'
        OR party_account.control_account_id <> account.id
        OR subledger_event.id IS NULL
      ))
      OR (account.control_kind = 'AP' AND (
        NEW.source_document_id IS NULL
        OR
        selected_type.owner_module <> 'payables'
        OR
        party_account.id IS NULL
        OR party_account.role <> 'SUPPLIER'
        OR party_account.control_account_id <> account.id
        OR subledger_event.id IS NULL
      ))
      OR (line.tax_snapshot_id IS NOT NULL AND (
        tax_snapshot.id IS NULL
        OR tax_snapshot.legal_entity_id <> NEW.legal_entity_id
        OR tax_snapshot.source_document_id IS DISTINCT FROM NEW.source_document_id
        OR tax_snapshot.status <> 'APPLIED'
      ))
      OR (EXISTS (
        SELECT 1 FROM segment_definitions definition
        WHERE definition.organization_id = NEW.organization_id
          AND definition.required
          AND definition.state = 'ACTIVE_LOCKED'
          AND (
            (lower(definition.key) = 'subaccount' AND combination.subaccount_id IS NULL)
            OR (lower(definition.key) = 'department' AND combination.department_id IS NULL)
            OR (lower(definition.key) = 'custom1' AND combination.custom_1_id IS NULL)
            OR (lower(definition.key) = 'custom2' AND combination.custom_2_id IS NULL)
            OR (lower(definition.key) = 'custom3' AND combination.custom_3_id IS NULL)
            OR (lower(definition.key) = 'custom4' AND combination.custom_4_id IS NULL)
            OR (lower(definition.key) = 'custom5' AND combination.custom_5_id IS NULL)
            OR (lower(definition.key) = 'custom6' AND combination.custom_6_id IS NULL)
            OR (lower(definition.key) = 'custom7' AND combination.custom_7_id IS NULL)
            OR (lower(definition.key) = 'custom8' AND combination.custom_8_id IS NULL)
          )
      ))
    );

  IF invalid_line_count > 0 THEN
    RAISE EXCEPTION 'One or more journal lines violate account, dimension, subledger, tax, or FX policy'
      USING ERRCODE = '23514';
  END IF;

  canonical_hash := app.compute_journal_content_hash(NEW.id);
  IF canonical_hash IS NULL OR NEW.content_hash IS DISTINCT FROM canonical_hash THEN
    RAISE EXCEPTION 'Posting content hash must match canonical locked journal content'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.journal_number IS NOT NULL OR NEW.journal_number IS NOT NULL THEN
    RAISE EXCEPTION 'Journal numbers are allocated only by the database posting transition'
      USING ERRCODE = '55000';
  END IF;

  NEW.journal_number := app.allocate_journal_number(NEW.organization_id, NEW.ledger_id, 'JOURNAL');
  NEW.posted_by := app.current_actor_id();
  NEW.total_debit_functional := debit_total;
  NEW.total_credit_functional := credit_total;
  NEW.posted_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint

ALTER TABLE journal_approvals
  ADD CONSTRAINT journal_approvals_decision_check
  CHECK (decision IN ('APPROVED', 'REJECTED'));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_journal_approval_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate journal_entries%ROWTYPE;
  canonical_hash text;
BEGIN
  IF NEW.actor_id IS DISTINCT FROM app.current_actor_id()
    OR NOT app.current_actor_has_permission('ledger.journal.approve') THEN
    RAISE EXCEPTION 'Approval requires the authenticated actor and approval permission'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO candidate
  FROM journal_entries
  WHERE organization_id = NEW.organization_id
    AND ledger_id = NEW.ledger_id
    AND id = NEW.journal_entry_id
  FOR UPDATE;

  IF NOT FOUND OR candidate.status <> 'SUBMITTED' THEN
    RAISE EXCEPTION 'Only a frozen submitted journal can be approved or rejected'
      USING ERRCODE = '55000';
  END IF;

  canonical_hash := app.compute_journal_content_hash(candidate.id);
  IF NEW.journal_version < 1
    OR NEW.journal_version IS DISTINCT FROM candidate.approval_version
    OR NEW.content_hash IS DISTINCT FROM canonical_hash
    OR candidate.content_hash IS DISTINCT FROM canonical_hash THEN
    RAISE EXCEPTION 'Approval must bind to the canonical frozen journal content'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_approvals_guard_insert ON journal_approvals;
CREATE TRIGGER journal_approvals_guard_insert
  BEFORE INSERT ON journal_approvals
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_approval_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.validate_posting_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'POSTED' OR OLD.status = 'POSTED' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'APPROVED' AND NEW.approval_version IS NULL THEN
    RAISE EXCEPTION 'An approved journal must identify the exact approved version'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.approval_version IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM journal_approvals approval
    WHERE approval.organization_id = NEW.organization_id
      AND approval.ledger_id = NEW.ledger_id
      AND approval.journal_entry_id = NEW.id
      AND approval.journal_version = NEW.approval_version
      AND approval.content_hash = NEW.content_hash
      AND approval.decision = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'The exact journal version and canonical content hash have not been approved'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Audit and outbox writes occur as one serialized trigger-side operation. The
-- shared runtime role cannot forge either table directly.
CREATE OR REPLACE FUNCTION app.audit_successful_posting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text, 0));

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

  INSERT INTO outbox_events (
    organization_id, topic, aggregate_type, aggregate_id, payload
  ) VALUES (
    NEW.organization_id, 'ledger.journal-posted', 'journal_entry', NEW.id::text,
    jsonb_build_object(
      'journalId', NEW.id,
      'journalNumber', NEW.journal_number,
      'contentHash', NEW.content_hash
    )
  );

  UPDATE ledgers
  SET first_posted_at = coalesce(first_posted_at, NEW.posted_at)
  WHERE organization_id = NEW.organization_id
    AND id = NEW.ledger_id;

  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_period_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor uuid;
  reason text;
  request_key text;
  previous_hash text;
  next_hash text;
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  actor := app.current_actor_id();
  reason := nullif(current_setting('app.reason', true), '');
  request_key := nullif(current_setting('app.request_id', true), '');

  IF actor IS NULL OR reason IS NULL OR request_key IS NULL THEN
    RAISE EXCEPTION 'Period transitions require actor, reason, and request context'
      USING ERRCODE = '28000';
  END IF;

  INSERT INTO period_events (
    organization_id, ledger_id, period_id, from_state, to_state,
    reason, actor_id, request_id
  ) VALUES (
    NEW.organization_id, NEW.ledger_id, NEW.id, OLD.state, NEW.state,
    reason, actor, request_key
  );

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text, 0));

  SELECT event_hash INTO previous_hash
  FROM audit_events
  WHERE organization_id = NEW.organization_id
  ORDER BY occurred_at DESC, id DESC
  LIMIT 1;

  next_hash := encode(digest(
    coalesce(previous_hash, '') || NEW.organization_id::text || NEW.id::text || request_key || 'period.transition',
    'sha256'
  ), 'hex');

  INSERT INTO audit_events (
    organization_id, actor_type, actor_id, auth_method, source_surface,
    action, entity_type, entity_id, request_id, reason, safe_metadata,
    previous_event_hash, event_hash
  ) VALUES (
    NEW.organization_id, 'USER', actor::text,
    coalesce(nullif(current_setting('app.auth_method', true), ''), 'application'),
    coalesce(nullif(current_setting('app.source_surface', true), ''), 'UI'),
    'period.transition', 'fiscal_period', NEW.id::text, request_key, reason,
    jsonb_build_object('from', OLD.state, 'to', NEW.state, 'version', NEW.version),
    previous_hash, next_hash
  );

  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_period_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor uuid;
  reason text;
  auth_method text;
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'SEALED' THEN
    RAISE EXCEPTION 'A sealed period cannot be reopened by the application'
      USING ERRCODE = '55000';
  END IF;

  actor := app.current_actor_id();
  reason := nullif(current_setting('app.reason', true), '');
  IF actor IS NULL OR reason IS NULL THEN
    RAISE EXCEPTION 'Period transitions require actor and reason context'
      USING ERRCODE = '28000';
  END IF;

  IF (OLD.state = 'HARD_CLOSED' AND NEW.state IN ('OPEN', 'ADJUSTMENT_ONLY'))
    OR (OLD.state = 'ADJUSTMENT_ONLY' AND NEW.state = 'OPEN') THEN
    IF NOT app.current_actor_has_permission('ledger.period.reopen') THEN
      RAISE EXCEPTION 'Period reopening permission is required'
        USING ERRCODE = '42501';
    END IF;

    auth_method := lower(coalesce(current_setting('app.auth_method', true), ''));
    IF auth_method NOT LIKE '%mfa%' THEN
      RAISE EXCEPTION 'Period reopening requires step-up MFA authentication'
        USING ERRCODE = '28000';
    END IF;
  ELSIF NOT app.current_actor_has_permission('ledger.period.close') THEN
    RAISE EXCEPTION 'Period close permission is required'
      USING ERRCODE = '42501';
  END IF;

  NEW.version := OLD.version + 1;
  NEW.closed_at := CASE WHEN NEW.state IN ('HARD_CLOSED', 'SEALED') THEN now() ELSE NULL END;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_fiscal_period_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  identity_changed boolean;
  has_journals boolean;
BEGIN
  identity_changed :=
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.ledger_id IS DISTINCT FROM OLD.ledger_id OR
    NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year OR
    NEW.period_number IS DISTINCT FROM OLD.period_number OR
    NEW.label IS DISTINCT FROM OLD.label OR
    NEW.starts_on IS DISTINCT FROM OLD.starts_on OR
    NEW.ends_on IS DISTINCT FROM OLD.ends_on;

  IF NOT identity_changed THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM journal_entries entry
    WHERE entry.organization_id = OLD.organization_id
      AND entry.ledger_id = OLD.ledger_id
      AND entry.period_id = OLD.id
  ) INTO has_journals;

  IF OLD.state <> 'OPEN' OR has_journals THEN
    RAISE EXCEPTION 'Fiscal-period identity and dates are immutable after journal use or close'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS fiscal_periods_identity_immutable ON fiscal_periods;
CREATE TRIGGER fiscal_periods_identity_immutable
  BEFORE UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION app.guard_fiscal_period_identity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_journal_relation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  from_entry journal_entries%ROWTYPE;
  to_entry journal_entries%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Journal correction relations are append-only'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.from_journal_id = NEW.to_journal_id THEN
    RAISE EXCEPTION 'A journal cannot correct itself'
      USING ERRCODE = '23514';
  END IF;

  IF NOT app.current_actor_has_permission('ledger.journal.reverse') THEN
    RAISE EXCEPTION 'Journal reversal permission is required'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO from_entry FROM journal_entries WHERE id = NEW.from_journal_id FOR SHARE;
  SELECT * INTO to_entry FROM journal_entries WHERE id = NEW.to_journal_id FOR SHARE;

  IF from_entry.status <> 'POSTED' OR to_entry.status <> 'POSTED'
    OR from_entry.organization_id <> NEW.organization_id
    OR to_entry.organization_id <> NEW.organization_id
    OR from_entry.ledger_id <> to_entry.ledger_id THEN
    RAISE EXCEPTION 'Correction relations require two posted journals in one tenant and ledger'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_relations_guard ON journal_entry_relations;
CREATE TRIGGER journal_relations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entry_relations
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_relation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_used_account_combination()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM journal_lines line
    WHERE line.account_combination_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'An account combination referenced by a journal is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS account_combinations_used_immutable ON account_combinations;
CREATE TRIGGER account_combinations_used_immutable
  BEFORE UPDATE OR DELETE ON account_combinations
  FOR EACH ROW EXECUTE FUNCTION app.guard_used_account_combination();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_used_gl_account_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM account_combinations combination
    JOIN journal_lines line ON line.account_combination_id = combination.id
    WHERE combination.account_id = OLD.id
  ) AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.ledger_id IS DISTINCT FROM OLD.ledger_id OR
    NEW.code IS DISTINCT FROM OLD.code OR
    NEW.class IS DISTINCT FROM OLD.class OR
    NEW.control_kind IS DISTINCT FROM OLD.control_kind OR
    NEW.valid_from IS DISTINCT FROM OLD.valid_from
  ) THEN
    RAISE EXCEPTION 'A general-ledger account identity is immutable after journal use'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.valid_to IS NOT NULL AND EXISTS (
    SELECT 1
    FROM account_combinations combination
    JOIN journal_lines line ON line.account_combination_id = combination.id
    JOIN journal_entries entry ON entry.id = line.journal_entry_id
    WHERE combination.account_id = OLD.id
      AND entry.accounting_date > NEW.valid_to
  ) THEN
    RAISE EXCEPTION 'Account validity cannot be ended before an existing journal date'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS gl_accounts_used_identity_immutable ON gl_accounts;
CREATE TRIGGER gl_accounts_used_identity_immutable
  BEFORE UPDATE ON gl_accounts
  FOR EACH ROW EXECUTE FUNCTION app.guard_used_gl_account_identity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_used_segment_value_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_use boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM account_combinations combination
    WHERE OLD.id IN (
      combination.subaccount_id, combination.department_id,
      combination.custom_1_id, combination.custom_2_id,
      combination.custom_3_id, combination.custom_4_id,
      combination.custom_5_id, combination.custom_6_id,
      combination.custom_7_id, combination.custom_8_id
    )
  ) INTO has_use;

  IF TG_OP = 'DELETE' THEN
    IF has_use THEN
      RAISE EXCEPTION 'A segment value identity is immutable after account-combination use'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF has_use AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.definition_id IS DISTINCT FROM OLD.definition_id OR
    NEW.code IS DISTINCT FROM OLD.code OR
    NEW.display_name IS DISTINCT FROM OLD.display_name
  ) THEN
    RAISE EXCEPTION 'A segment value identity is immutable after account-combination use'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS segment_values_used_identity_immutable ON segment_values;
CREATE TRIGGER segment_values_used_identity_immutable
  BEFORE UPDATE OR DELETE ON segment_values
  FOR EACH ROW EXECUTE FUNCTION app.guard_used_segment_value_identity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_segment_definition_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_protected_use boolean;
BEGIN
  IF TG_OP = 'UPDATE'
    AND pg_trigger_depth() > 1
    AND OLD.protected_use_at IS NULL
    AND NEW.protected_use_at IS NOT NULL
    AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
    AND NEW.key IS NOT DISTINCT FROM OLD.key
    AND NEW.ordinal IS NOT DISTINCT FROM OLD.ordinal
    AND NEW.display_name IS NOT DISTINCT FROM OLD.display_name
    AND NEW.state IS NOT DISTINCT FROM OLD.state
    AND NEW.required IS NOT DISTINCT FROM OLD.required
    AND NEW.visible IS NOT DISTINCT FROM OLD.visible THEN
    RETURN NEW;
  END IF;

  IF NOT app.current_actor_has_permission('ledger.segments.manage') THEN
    RAISE EXCEPTION 'Restricted segment administration permission is required'
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM segment_values value
    JOIN account_combinations combination ON value.id IN (
      combination.subaccount_id, combination.department_id,
      combination.custom_1_id, combination.custom_2_id,
      combination.custom_3_id, combination.custom_4_id,
      combination.custom_5_id, combination.custom_6_id,
      combination.custom_7_id, combination.custom_8_id
    )
    WHERE value.organization_id = OLD.organization_id
      AND value.definition_id = OLD.id
  ) INTO has_protected_use;

  IF TG_OP = 'DELETE' THEN
    IF has_protected_use OR OLD.protected_use_at IS NOT NULL THEN
      RAISE EXCEPTION 'A used segment definition cannot be renamed, repurposed, or deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF (has_protected_use OR OLD.protected_use_at IS NOT NULL) AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.key IS DISTINCT FROM OLD.key OR
    NEW.ordinal IS DISTINCT FROM OLD.ordinal OR
    NEW.display_name IS DISTINCT FROM OLD.display_name OR
    (OLD.protected_use_at IS NOT NULL AND NEW.protected_use_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'A used segment definition cannot be renamed, repurposed, or deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'EMPTY' AND NEW.state = 'CONFIGURED_UNBOUND') OR
    (OLD.state = 'CONFIGURED_UNBOUND' AND NEW.state = 'ACTIVE_LOCKED') OR
    (OLD.state = 'CONFIGURED_UNBOUND' AND NEW.state = 'EMPTY' AND NOT has_protected_use) OR
    (OLD.state = 'ACTIVE_LOCKED' AND NEW.state = 'INACTIVE_LOCKED') OR
    (OLD.state = 'INACTIVE_LOCKED' AND NEW.state = 'ACTIVE_LOCKED')
  ) THEN
    RAISE EXCEPTION 'Invalid protected segment-definition lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS segment_definitions_restricted_change ON segment_definitions;
CREATE TRIGGER segment_definitions_restricted_change
  BEFORE UPDATE OR DELETE ON segment_definitions
  FOR EACH ROW EXECUTE FUNCTION app.guard_segment_definition_change();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.mark_account_combination_segments_used()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE segment_definitions definition
  SET protected_use_at = coalesce(definition.protected_use_at, now())
  WHERE definition.organization_id = NEW.organization_id
    AND definition.id IN (
      SELECT value.definition_id
      FROM segment_values value
      WHERE value.organization_id = NEW.organization_id
        AND value.id = ANY (ARRAY[
          NEW.subaccount_id, NEW.department_id,
          NEW.custom_1_id, NEW.custom_2_id,
          NEW.custom_3_id, NEW.custom_4_id,
          NEW.custom_5_id, NEW.custom_6_id,
          NEW.custom_7_id, NEW.custom_8_id
        ]::uuid[])
    );

  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS account_combinations_mark_segments_used ON account_combinations;
CREATE TRIGGER account_combinations_mark_segments_used
  AFTER INSERT OR UPDATE ON account_combinations
  FOR EACH ROW EXECUTE FUNCTION app.mark_account_combination_segments_used();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_used_party_account_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_use boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM subledger_events event WHERE event.party_account_id = OLD.id
    UNION ALL
    SELECT 1 FROM journal_lines line WHERE line.party_account_id = OLD.id
  ) INTO has_use;

  IF TG_OP = 'DELETE' THEN
    IF has_use THEN
      RAISE EXCEPTION 'A customer or supplier account identity is immutable after subledger use'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF has_use AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id OR
    NEW.ledger_id IS DISTINCT FROM OLD.ledger_id OR
    NEW.party_id IS DISTINCT FROM OLD.party_id OR
    NEW.role IS DISTINCT FROM OLD.role OR
    NEW.account_number IS DISTINCT FROM OLD.account_number OR
    NEW.control_account_id IS DISTINCT FROM OLD.control_account_id OR
    NEW.transaction_currency IS DISTINCT FROM OLD.transaction_currency
  ) THEN
    RAISE EXCEPTION 'A customer or supplier account identity is immutable after subledger use'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS party_accounts_used_identity_immutable ON party_accounts;
CREATE TRIGGER party_accounts_used_identity_immutable
  BEFORE UPDATE OR DELETE ON party_accounts
  FOR EACH ROW EXECUTE FUNCTION app.guard_used_party_account_identity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_append_only_source_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; add a new version or compensating event', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;
--> statement-breakpoint
CREATE TRIGGER source_documents_append_only
  BEFORE UPDATE OR DELETE ON source_documents
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
--> statement-breakpoint
CREATE TRIGGER subledger_events_append_only
  BEFORE UPDATE OR DELETE ON subledger_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
--> statement-breakpoint
CREATE TRIGGER open_items_append_only_until_settlement_events
  BEFORE UPDATE OR DELETE ON open_items
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
--> statement-breakpoint

INSERT INTO permissions (key, description) VALUES
  ('ledger.journal.post_adjustment', 'Post an authorized adjustment in an adjustment-only period'),
  ('ledger.segments.manage', 'Perform restricted chart-segment configuration changes')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE ON audit_events, outbox_events, period_events
  FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON organization_key_versions
  FROM PUBLIC;
REVOKE UPDATE, DELETE ON source_documents, subledger_events, open_items,
  journal_entry_relations FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON segment_definitions, segment_values FROM PUBLIC;
REVOKE ALL ON users FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON organizations, organization_memberships,
  roles, membership_roles, role_permissions FROM PUBLIC;
REVOKE DELETE ON fiscal_periods FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE INSERT, UPDATE, DELETE ON audit_events, outbox_events, period_events
      FROM business_finlynq_app;
    REVOKE INSERT, UPDATE, DELETE ON organization_key_versions
      FROM business_finlynq_app;
    REVOKE UPDATE, DELETE ON source_documents, subledger_events, open_items,
      journal_entry_relations FROM business_finlynq_app;
    REVOKE INSERT, UPDATE, DELETE ON segment_definitions, segment_values
      FROM business_finlynq_app;
    REVOKE ALL ON users FROM business_finlynq_app;
    REVOKE INSERT, UPDATE, DELETE ON organizations, organization_memberships,
      roles, membership_roles, role_permissions FROM business_finlynq_app;
    REVOKE DELETE ON fiscal_periods FROM business_finlynq_app;
  END IF;
END
$$;
