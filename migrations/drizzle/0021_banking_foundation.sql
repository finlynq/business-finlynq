-- Bank feeds are observations, not accounting entries. Provider credentials
-- and descriptive data use the organization envelope key; provider identity
-- and version hashes are keyed blind indexes. Rules may create encrypted
-- manual-review suggestions only and can never create or post journals.

CREATE TABLE bank_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider = 'SIMPLEFIN'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 100),
  credentials_ciphertext text NOT NULL CHECK (length(credentials_ciphertext) BETWEEN 50 AND 20000),
  credentials_key_version integer NOT NULL CHECK (credentials_key_version > 0),
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED', 'REAUTHORIZATION_REQUIRED')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 180),
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  last_synced_at timestamp with time zone,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{2,80}$'),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_connections_org_provider_unique UNIQUE (organization_id, provider),
  CONSTRAINT bank_connections_org_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT bank_connections_org_id_unique UNIQUE (organization_id, id)
);
--> statement-breakpoint

-- Credentials remain encrypted in the retained provider row. This append-only
-- register records a non-secret hash and key version for every replacement so
-- reauthorization is idempotent and independently auditable without retaining
-- obsolete provider secrets.
CREATE TABLE bank_connection_credential_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  event_type text NOT NULL CHECK (event_type IN ('CREATED', 'REAUTHORIZED')),
  credential_ciphertext_hash text NOT NULL CHECK (credential_ciphertext_hash ~ '^[0-9a-f]{64}$'),
  credential_key_version integer NOT NULL CHECK (credential_key_version > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 180),
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_connection_credential_events_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_connection_credential_events_connection_version_unique UNIQUE (connection_id, credential_version),
  CONSTRAINT bank_connection_credential_events_org_connection_version_unique UNIQUE (organization_id, connection_id, credential_version),
  CONSTRAINT bank_connection_credential_events_org_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT bank_connection_credential_events_org_connection_fk FOREIGN KEY (organization_id, connection_id)
    REFERENCES bank_connections(organization_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE TABLE bank_external_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  provider_account_id_hash text NOT NULL CHECK (provider_account_id_hash ~ '^hmac-sha256-v1:[0-9a-f]{64}$'),
  provider_account_id_ciphertext text NOT NULL,
  display_name_ciphertext text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  currency_code text NOT NULL REFERENCES currency_definitions(code) ON DELETE RESTRICT,
  legal_entity_id uuid,
  ledger_id uuid,
  cash_account_combination_id uuid,
  active boolean NOT NULL DEFAULT true,
  last_reported_balance numeric(38,9),
  last_balance_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_external_accounts_mapping_complete CHECK (
    (legal_entity_id IS NULL AND ledger_id IS NULL AND cash_account_combination_id IS NULL)
    OR (legal_entity_id IS NOT NULL AND ledger_id IS NOT NULL AND cash_account_combination_id IS NOT NULL)
  ),
  CONSTRAINT bank_external_accounts_connection_identity_unique UNIQUE (connection_id, provider_account_id_hash),
  CONSTRAINT bank_external_accounts_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_external_accounts_org_id_currency_unique UNIQUE (organization_id, id, currency_code),
  CONSTRAINT bank_external_accounts_org_mapping_currency_unique UNIQUE (
    organization_id, id, legal_entity_id, ledger_id, cash_account_combination_id, currency_code
  ),
  CONSTRAINT bank_external_accounts_org_connection_fk FOREIGN KEY (organization_id, connection_id)
    REFERENCES bank_connections(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_external_accounts_org_entity_fk FOREIGN KEY (organization_id, legal_entity_id)
    REFERENCES legal_entities(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_external_accounts_org_ledger_fk FOREIGN KEY (organization_id, ledger_id)
    REFERENCES ledgers(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_external_accounts_org_combination_fk FOREIGN KEY (organization_id, cash_account_combination_id)
    REFERENCES account_combinations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_external_accounts_org_ledger_entity_fk FOREIGN KEY (organization_id, ledger_id, legal_entity_id)
    REFERENCES ledgers(organization_id, id, legal_entity_id) ON DELETE RESTRICT,
  CONSTRAINT bank_external_accounts_org_ledger_combination_fk FOREIGN KEY (
    organization_id, ledger_id, cash_account_combination_id
  ) REFERENCES account_combinations(organization_id, ledger_id, id) ON DELETE RESTRICT
);
CREATE INDEX bank_external_accounts_org_mapping_idx
  ON bank_external_accounts(organization_id, legal_entity_id, active);
--> statement-breakpoint

CREATE TABLE bank_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  requested_start_on date,
  requested_end_on date,
  account_count integer NOT NULL DEFAULT 0 CHECK (account_count >= 0),
  observation_count integer NOT NULL DEFAULT 0 CHECK (observation_count >= 0),
  version_count integer NOT NULL DEFAULT 0 CHECK (version_count >= 0),
  provider_warning_count integer NOT NULL DEFAULT 0 CHECK (provider_warning_count >= 0),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{2,80}$'),
  created_by uuid NOT NULL,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  CONSTRAINT bank_sync_runs_range_check CHECK (requested_end_on IS NULL OR requested_start_on IS NULL OR requested_end_on >= requested_start_on),
  CONSTRAINT bank_sync_runs_completion_check CHECK (
    (status = 'RUNNING' AND completed_at IS NULL AND error_code IS NULL)
    OR (status = 'SUCCEEDED' AND completed_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'FAILED' AND completed_at IS NOT NULL AND error_code IS NOT NULL)
  ),
  CONSTRAINT bank_sync_runs_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_sync_runs_org_connection_fk FOREIGN KEY (organization_id, connection_id)
    REFERENCES bank_connections(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_sync_runs_org_connection_credential_fk FOREIGN KEY (
    organization_id, connection_id, credential_version
  ) REFERENCES bank_connection_credential_events(
    organization_id, connection_id, credential_version
  ) ON DELETE RESTRICT
);
CREATE INDEX bank_sync_runs_connection_started_idx ON bank_sync_runs(connection_id, started_at DESC);
CREATE UNIQUE INDEX bank_sync_runs_one_running_per_connection_unique
  ON bank_sync_runs(connection_id) WHERE status = 'RUNNING';
--> statement-breakpoint

CREATE TABLE bank_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  external_account_id uuid NOT NULL,
  provider_transaction_id_hash text NOT NULL CHECK (provider_transaction_id_hash ~ '^hmac-sha256-v1:[0-9a-f]{64}$'),
  provider_transaction_id_ciphertext text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  first_seen_run_id uuid NOT NULL,
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_observations_account_transaction_unique UNIQUE (external_account_id, provider_transaction_id_hash),
  CONSTRAINT bank_observations_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_observations_org_account_fk FOREIGN KEY (organization_id, external_account_id)
    REFERENCES bank_external_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_observations_org_run_fk FOREIGN KEY (organization_id, first_seen_run_id)
    REFERENCES bank_sync_runs(organization_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE TABLE bank_observation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  observation_id uuid NOT NULL,
  sync_run_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^hmac-sha256-v1:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('POSTED', 'PENDING')),
  posted_on date NOT NULL,
  transacted_at timestamp with time zone,
  amount numeric(38,9) NOT NULL CHECK (amount <> 0),
  currency_code text NOT NULL REFERENCES currency_definitions(code) ON DELETE RESTRICT,
  details_ciphertext text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  observed_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_observation_versions_number_unique UNIQUE (observation_id, version_number),
  CONSTRAINT bank_observation_versions_content_unique UNIQUE (observation_id, content_hash),
  CONSTRAINT bank_observation_versions_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_observation_versions_org_observation_fk FOREIGN KEY (organization_id, observation_id)
    REFERENCES bank_observations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_observation_versions_org_run_fk FOREIGN KEY (organization_id, sync_run_id)
    REFERENCES bank_sync_runs(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX bank_observation_versions_org_posted_idx
  ON bank_observation_versions(organization_id, posted_on DESC, id);
--> statement-breakpoint

CREATE TABLE bank_balance_anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  external_account_id uuid NOT NULL,
  sync_run_id uuid NOT NULL,
  balance numeric(38,9) NOT NULL,
  available_balance numeric(38,9),
  currency_code text NOT NULL REFERENCES currency_definitions(code) ON DELETE RESTRICT,
  balance_at timestamp with time zone NOT NULL,
  observed_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_balance_anchors_account_run_unique UNIQUE (external_account_id, sync_run_id),
  CONSTRAINT bank_balance_anchors_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_balance_anchors_org_account_currency_fk FOREIGN KEY (organization_id, external_account_id, currency_code)
    REFERENCES bank_external_accounts(organization_id, id, currency_code) ON DELETE RESTRICT,
  CONSTRAINT bank_balance_anchors_org_run_fk FOREIGN KEY (organization_id, sync_run_id)
    REFERENCES bank_sync_runs(organization_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE TABLE bank_reconciliation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  external_account_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ledger_id uuid NOT NULL,
  cash_account_combination_id uuid NOT NULL,
  statement_start_on date NOT NULL,
  statement_end_on date NOT NULL,
  opening_balance numeric(38,9) NOT NULL,
  closing_balance numeric(38,9) NOT NULL,
  currency_code text NOT NULL REFERENCES currency_definitions(code) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'REVIEWED', 'FINALIZED', 'VOIDED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 180),
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  submitted_by uuid,
  reviewed_by uuid,
  finalized_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  submitted_at timestamp with time zone,
  reviewed_at timestamp with time zone,
  finalized_at timestamp with time zone,
  finalized_observation_total numeric(38,9),
  finalized_ledger_total numeric(38,9),
  finalized_unexplained_difference numeric(38,9),
  finalized_match_hash text,
  CONSTRAINT bank_reconciliation_sessions_date_check CHECK (statement_end_on >= statement_start_on),
  CONSTRAINT bank_reconciliation_sessions_workflow_check CHECK (
    (status = 'DRAFT' AND submitted_by IS NULL AND submitted_at IS NULL
      AND reviewed_by IS NULL AND reviewed_at IS NULL AND finalized_by IS NULL AND finalized_at IS NULL
      AND finalized_observation_total IS NULL AND finalized_ledger_total IS NULL
      AND finalized_unexplained_difference IS NULL AND finalized_match_hash IS NULL)
    OR (status = 'SUBMITTED' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL
      AND reviewed_by IS NULL AND reviewed_at IS NULL AND finalized_by IS NULL AND finalized_at IS NULL
      AND finalized_observation_total IS NULL AND finalized_ledger_total IS NULL
      AND finalized_unexplained_difference IS NULL AND finalized_match_hash IS NULL)
    OR (status = 'REVIEWED' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND finalized_by IS NULL AND finalized_at IS NULL
      AND finalized_observation_total IS NULL AND finalized_ledger_total IS NULL
      AND finalized_unexplained_difference IS NULL AND finalized_match_hash IS NULL)
    OR (status = 'FINALIZED' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND finalized_by IS NOT NULL AND finalized_at IS NOT NULL
      AND finalized_observation_total IS NOT NULL AND finalized_ledger_total IS NOT NULL
      AND finalized_observation_total = closing_balance - opening_balance
      AND finalized_ledger_total = closing_balance - opening_balance
      AND finalized_unexplained_difference = 0 AND finalized_match_hash ~ '^[0-9a-f]{64}$')
    OR (status = 'VOIDED'
      AND finalized_by IS NULL AND finalized_at IS NULL
      AND finalized_observation_total IS NULL AND finalized_ledger_total IS NULL
      AND finalized_unexplained_difference IS NULL AND finalized_match_hash IS NULL
      AND (
        (submitted_by IS NULL AND submitted_at IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
      ))
  ),
  CONSTRAINT bank_reconciliation_sessions_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_reconciliation_sessions_org_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT bank_reconciliation_sessions_org_account_currency_fk FOREIGN KEY (organization_id, external_account_id, currency_code)
    REFERENCES bank_external_accounts(organization_id, id, currency_code) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_sessions_org_account_mapping_currency_fk FOREIGN KEY (
    organization_id, external_account_id, legal_entity_id, ledger_id, cash_account_combination_id, currency_code
  ) REFERENCES bank_external_accounts(
    organization_id, id, legal_entity_id, ledger_id, cash_account_combination_id, currency_code
  ) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_sessions_org_entity_fk FOREIGN KEY (organization_id, legal_entity_id)
    REFERENCES legal_entities(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_sessions_org_ledger_fk FOREIGN KEY (organization_id, ledger_id)
    REFERENCES ledgers(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_sessions_org_combination_fk FOREIGN KEY (organization_id, cash_account_combination_id)
    REFERENCES account_combinations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_sessions_org_ledger_entity_fk FOREIGN KEY (organization_id, ledger_id, legal_entity_id)
    REFERENCES ledgers(organization_id, id, legal_entity_id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_sessions_org_ledger_combination_fk FOREIGN KEY (
    organization_id, ledger_id, cash_account_combination_id
  ) REFERENCES account_combinations(organization_id, ledger_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX bank_reconciliation_sessions_active_account_period_unique
  ON bank_reconciliation_sessions(external_account_id, statement_start_on, statement_end_on)
  WHERE status <> 'VOIDED';
ALTER TABLE bank_reconciliation_sessions
  ADD CONSTRAINT bank_reconciliation_sessions_active_account_period_exclude
  EXCLUDE USING gist (
    organization_id WITH =,
    external_account_id WITH =,
    daterange(statement_start_on, statement_end_on, '[]') WITH &&
  ) WHERE (status <> 'VOIDED');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_reconciliation_chain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor bank_reconciliation_sessions%ROWTYPE;
  successor_exists boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq:bank-reconciliation-chain:' || NEW.organization_id::text || ':' || NEW.external_account_id::text,
    0
  ));

  SELECT reconciliation.*
  INTO predecessor
  FROM bank_reconciliation_sessions reconciliation
  WHERE reconciliation.organization_id = NEW.organization_id
    AND reconciliation.external_account_id = NEW.external_account_id
    AND reconciliation.status <> 'VOIDED'
    AND reconciliation.statement_end_on < NEW.statement_start_on
  ORDER BY reconciliation.statement_end_on DESC, reconciliation.created_at DESC
  LIMIT 1;

  IF FOUND AND (
    predecessor.status <> 'FINALIZED'
    OR predecessor.statement_end_on + 1 <> NEW.statement_start_on
    OR predecessor.closing_balance <> NEW.opening_balance
  ) THEN
    RAISE EXCEPTION 'A reconciliation successor requires the next date and exact closing balance of its finalized predecessor'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM bank_reconciliation_sessions reconciliation
    WHERE reconciliation.organization_id = NEW.organization_id
      AND reconciliation.external_account_id = NEW.external_account_id
      AND reconciliation.status <> 'VOIDED'
      AND reconciliation.statement_start_on > NEW.statement_end_on
  ) INTO successor_exists;
  IF successor_exists THEN
    RAISE EXCEPTION 'Bank reconciliation periods must be created in chronological order'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_reconciliation_chain() FROM PUBLIC;
CREATE TRIGGER bank_reconciliation_chain_guard
  BEFORE INSERT ON bank_reconciliation_sessions
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_reconciliation_chain();
--> statement-breakpoint

CREATE TABLE bank_reconciliation_voids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  reconciliation_session_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_reconciliation_voids_session_unique UNIQUE (reconciliation_session_id),
  CONSTRAINT bank_reconciliation_voids_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_reconciliation_voids_org_session_fk FOREIGN KEY (organization_id, reconciliation_session_id)
    REFERENCES bank_reconciliation_sessions(organization_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE TABLE bank_match_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  reconciliation_session_id uuid NOT NULL,
  observation_version_id uuid NOT NULL,
  journal_line_id uuid NOT NULL,
  match_kind text NOT NULL CHECK (match_kind IN ('EXACT', 'SUGGESTED', 'MANUAL')),
  allocated_amount numeric(38,9) NOT NULL CHECK (allocated_amount > 0),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_match_allocations_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_match_allocations_org_session_fk FOREIGN KEY (organization_id, reconciliation_session_id)
    REFERENCES bank_reconciliation_sessions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_match_allocations_org_observation_version_fk FOREIGN KEY (organization_id, observation_version_id)
    REFERENCES bank_observation_versions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_match_allocations_org_journal_line_fk FOREIGN KEY (organization_id, journal_line_id)
    REFERENCES journal_lines(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX bank_match_allocations_session_idx ON bank_match_allocations(reconciliation_session_id, created_at);
--> statement-breakpoint

CREATE TABLE bank_match_allocation_voids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  allocation_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_match_allocation_voids_allocation_unique UNIQUE (allocation_id),
  CONSTRAINT bank_match_allocation_voids_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_match_allocation_voids_org_allocation_fk FOREIGN KEY (organization_id, allocation_id)
    REFERENCES bank_match_allocations(organization_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE TABLE bank_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 10000),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  condition_ciphertext text NOT NULL,
  action_ciphertext text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  supersedes_rule_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 180),
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_rules_org_name_version_unique UNIQUE (organization_id, name, version),
  CONSTRAINT bank_rules_org_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT bank_rules_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_rules_org_supersedes_unique UNIQUE (organization_id, supersedes_rule_id),
  CONSTRAINT bank_rules_org_supersedes_fk FOREIGN KEY (organization_id, supersedes_rule_id)
    REFERENCES bank_rules(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX bank_rules_org_state_priority_idx ON bank_rules(organization_id, state, priority, created_at);
--> statement-breakpoint

CREATE TABLE bank_rule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  sync_run_id uuid NOT NULL,
  observation_version_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  matched boolean NOT NULL,
  evaluated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_rule_runs_evaluation_unique UNIQUE (sync_run_id, observation_version_id, rule_id),
  CONSTRAINT bank_rule_runs_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_rule_runs_org_sync_fk FOREIGN KEY (organization_id, sync_run_id)
    REFERENCES bank_sync_runs(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_rule_runs_org_observation_version_fk FOREIGN KEY (organization_id, observation_version_id)
    REFERENCES bank_observation_versions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_rule_runs_org_rule_fk FOREIGN KEY (organization_id, rule_id)
    REFERENCES bank_rules(organization_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE TABLE bank_draft_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  observation_version_id uuid NOT NULL,
  rule_id uuid,
  kind text NOT NULL CHECK (kind = 'MANUAL_REVIEW'),
  payload_ciphertext text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^hmac-sha256-v1:[0-9a-f]{64}$'),
  key_version integer NOT NULL CHECK (key_version > 0),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bank_draft_proposals_identity_unique UNIQUE NULLS NOT DISTINCT (observation_version_id, rule_id, payload_hash),
  CONSTRAINT bank_draft_proposals_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT bank_draft_proposals_org_observation_version_fk FOREIGN KEY (organization_id, observation_version_id)
    REFERENCES bank_observation_versions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_draft_proposals_org_rule_fk FOREIGN KEY (organization_id, rule_id)
    REFERENCES bank_rules(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX bank_draft_proposals_org_created_idx ON bank_draft_proposals(organization_id, created_at DESC);
--> statement-breakpoint

DO $$
DECLARE tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'bank_connections', 'bank_connection_credential_events', 'bank_external_accounts', 'bank_sync_runs',
    'bank_observations', 'bank_observation_versions', 'bank_balance_anchors',
    'bank_reconciliation_sessions', 'bank_reconciliation_voids', 'bank_match_allocations', 'bank_match_allocation_voids', 'bank_rules',
    'bank_rule_runs', 'bank_draft_proposals'
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

INSERT INTO permissions(key, description) VALUES
  ('banking.read', 'Read bank-feed observations, mappings, and reconciliation state'),
  ('banking.connections.manage', 'Connect, disable, and reauthorize bank-feed providers'),
  ('banking.sync', 'Run bank-feed synchronization into immutable observations'),
  ('banking.reconcile.prepare', 'Map bank accounts and prepare, submit, correct, or void reconciliation sessions'),
  ('banking.reconcile.review', 'Review and finalize submitted bank reconciliation evidence'),
  ('banking.rules.manage', 'Version bank categorization rules that produce manual-review suggestions only')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;
--> statement-breakpoint

INSERT INTO role_permissions(organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, permission.key
FROM roles role
CROSS JOIN permissions permission
WHERE
  (role.key = 'OWNER' AND permission.key LIKE 'banking.%')
  OR (role.key = 'ORGANIZATION_ADMIN' AND permission.key IN ('banking.read', 'banking.connections.manage'))
  OR (role.key = 'ACCOUNTANT_APPROVER' AND permission.key IN ('banking.read', 'banking.sync', 'banking.reconcile.review', 'banking.rules.manage'))
  OR (role.key = 'BOOKKEEPER_MAKER' AND permission.key IN ('banking.read', 'banking.sync', 'banking.reconcile.prepare'))
  OR (role.key = 'VIEWER_AUDITOR' AND permission.key = 'banking.read')
  OR (role.key = 'demo_accountant' AND permission.key LIKE 'banking.%')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.assign_banking_template_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT NEW.system_template AND NEW.key <> 'demo_accountant' THEN
    RETURN NEW;
  END IF;
  INSERT INTO role_permissions(organization_id, role_id, permission_key)
  SELECT NEW.organization_id, NEW.id, permission.key
  FROM permissions permission
  WHERE
    (NEW.key = 'OWNER' AND permission.key LIKE 'banking.%')
    OR (NEW.key = 'ORGANIZATION_ADMIN' AND permission.key IN ('banking.read', 'banking.connections.manage'))
    OR (NEW.key = 'ACCOUNTANT_APPROVER' AND permission.key IN ('banking.read', 'banking.sync', 'banking.reconcile.review', 'banking.rules.manage'))
    OR (NEW.key = 'BOOKKEEPER_MAKER' AND permission.key IN ('banking.read', 'banking.sync', 'banking.reconcile.prepare'))
    OR (NEW.key = 'VIEWER_AUDITOR' AND permission.key = 'banking.read')
    OR (NEW.key = 'demo_accountant' AND permission.key LIKE 'banking.%')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.assign_banking_template_permissions() FROM PUBLIC;
DROP TRIGGER IF EXISTS assign_banking_template_permissions ON roles;
CREATE TRIGGER assign_banking_template_permissions
  AFTER INSERT OR UPDATE OF key, system_template ON roles
  FOR EACH ROW EXECUTE FUNCTION app.assign_banking_template_permissions();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_banking_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  required_permission text;
  new_row jsonb := to_jsonb(NEW);
  old_row jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% cannot be deleted; disable, void, or add a compensating record', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  required_permission := CASE
    WHEN TG_TABLE_NAME = 'bank_connections' AND TG_OP = 'INSERT' THEN 'banking.connections.manage'
    WHEN TG_TABLE_NAME = 'bank_connections' THEN
      CASE WHEN (new_row -> 'provider') IS NOT DISTINCT FROM (old_row -> 'provider')
        AND (new_row -> 'credentials_ciphertext') IS NOT DISTINCT FROM (old_row -> 'credentials_ciphertext')
        AND (new_row -> 'credentials_key_version') IS NOT DISTINCT FROM (old_row -> 'credentials_key_version')
        AND (new_row -> 'display_name') IS NOT DISTINCT FROM (old_row -> 'display_name')
        AND (
          (new_row ->> 'status') IS NOT DISTINCT FROM (old_row ->> 'status')
          OR ((old_row ->> 'status') = 'ACTIVE' AND (new_row ->> 'status') = 'REAUTHORIZATION_REQUIRED')
        )
        THEN 'banking.sync' ELSE 'banking.connections.manage' END
    WHEN TG_TABLE_NAME = 'bank_connection_credential_events' THEN 'banking.connections.manage'
    WHEN TG_TABLE_NAME IN ('bank_external_accounts') THEN
      CASE WHEN TG_OP = 'UPDATE' THEN 'banking.reconcile.prepare' ELSE 'banking.sync' END
    WHEN TG_TABLE_NAME IN ('bank_sync_runs', 'bank_observations', 'bank_observation_versions', 'bank_balance_anchors', 'bank_rule_runs', 'bank_draft_proposals') THEN 'banking.sync'
    WHEN TG_TABLE_NAME = 'bank_reconciliation_sessions' THEN
      CASE WHEN TG_OP = 'UPDATE' AND (
          (new_row ->> 'status') IN ('REVIEWED', 'FINALIZED')
          OR ((new_row ->> 'status') = 'VOIDED' AND (old_row ->> 'status') = 'REVIEWED')
        ) THEN 'banking.reconcile.review' ELSE 'banking.reconcile.prepare' END
    WHEN TG_TABLE_NAME = 'bank_reconciliation_voids' THEN
      CASE WHEN EXISTS (
        SELECT 1 FROM bank_reconciliation_sessions reconciliation
        WHERE reconciliation.organization_id = (new_row ->> 'organization_id')::uuid
          AND reconciliation.id = (new_row ->> 'reconciliation_session_id')::uuid
          AND reconciliation.status = 'REVIEWED'
      ) THEN 'banking.reconcile.review' ELSE 'banking.reconcile.prepare' END
    WHEN TG_TABLE_NAME IN ('bank_match_allocations', 'bank_match_allocation_voids') THEN 'banking.reconcile.prepare'
    WHEN TG_TABLE_NAME = 'bank_rules' THEN 'banking.rules.manage'
    ELSE NULL
  END;
  IF app.current_actor_id() IS NULL OR required_permission IS NULL
    OR NOT app.current_actor_has_permission(required_permission) THEN
    RAISE EXCEPTION 'Banking permission is required' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_banking_mutation() FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'bank_connections', 'bank_connection_credential_events', 'bank_external_accounts', 'bank_sync_runs',
    'bank_observations', 'bank_observation_versions', 'bank_balance_anchors',
    'bank_reconciliation_sessions', 'bank_reconciliation_voids', 'bank_match_allocations', 'bank_match_allocation_voids', 'bank_rules',
    'bank_rule_runs', 'bank_draft_proposals'
  ] LOOP
    EXECUTE format('CREATE TRIGGER banking_permission_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.guard_banking_mutation()', tenant_table);
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_immutable_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; add a new observation, version, match, or proposal', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_immutable_record() FROM PUBLIC;
DO $$
DECLARE immutable_table text;
BEGIN
  FOREACH immutable_table IN ARRAY ARRAY[
    'bank_connection_credential_events', 'bank_observations', 'bank_observation_versions', 'bank_balance_anchors',
    'bank_reconciliation_voids', 'bank_match_allocations', 'bank_match_allocation_voids', 'bank_rules', 'bank_rule_runs', 'bank_draft_proposals'
  ] LOOP
    EXECUTE format('CREATE TRIGGER bank_immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.guard_bank_immutable_record()', immutable_table);
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_connection_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.command_hash IS DISTINCT FROM OLD.command_hash
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Bank connection identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.credentials_ciphertext IS DISTINCT FROM OLD.credentials_ciphertext
    OR NEW.credentials_key_version IS DISTINCT FROM OLD.credentials_key_version THEN
    IF NEW.credential_version <> OLD.credential_version + 1 THEN
      RAISE EXCEPTION 'A credential replacement must advance exactly one append-only version'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.credential_version IS DISTINCT FROM OLD.credential_version THEN
    RAISE EXCEPTION 'Credential version cannot change without replacing the encrypted credential'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_connection_identity_immutable
  BEFORE UPDATE ON bank_connections
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_connection_identity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_connection_credential_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM bank_connection_credential_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.connection_id = NEW.id
      AND event.credential_version = NEW.credential_version
      AND event.credential_key_version = NEW.credentials_key_version
      AND event.credential_ciphertext_hash = encode(digest(NEW.credentials_ciphertext, 'sha256'), 'hex')
  ) THEN
    RAISE EXCEPTION 'Every encrypted bank credential version requires matching append-only evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_connection_credential_evidence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER bank_connection_credential_evidence_guard
  AFTER INSERT OR UPDATE ON bank_connections DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_connection_credential_evidence();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_external_account_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.provider_account_id_hash IS DISTINCT FROM OLD.provider_account_id_hash
    OR NEW.provider_account_id_ciphertext IS DISTINCT FROM OLD.provider_account_id_ciphertext
    OR NEW.key_version IS DISTINCT FROM OLD.key_version
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'External bank-account identity is immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_external_account_identity_immutable
  BEFORE UPDATE ON bank_external_accounts
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_external_account_identity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_external_account_mapping()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.legal_entity_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Serialize mapping and chart/entity state changes per organization so a
  -- concurrent deactivation cannot race this validation.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('bank-cash-mapping|' || NEW.organization_id::text, 0)
  );
  -- Share the exact currency lifecycle lock used by migration 0020. A bank
  -- account may be foreign-currency relative to its ledger, but that currency
  -- must remain explicitly enabled for the tenant while the mapping exists.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.organization_id::text || '|organization-currency|' || upper(trim(NEW.currency_code)),
    0
  ));

  PERFORM 1
  FROM account_combinations combination
  JOIN gl_accounts account
    ON account.organization_id = combination.organization_id
   AND account.ledger_id = combination.ledger_id
   AND account.id = combination.account_id
  JOIN ledgers ledger
    ON ledger.organization_id = combination.organization_id
   AND ledger.id = combination.ledger_id
   AND ledger.legal_entity_id = combination.entity_id
  JOIN legal_entities entity
    ON entity.organization_id = combination.organization_id
   AND entity.id = combination.entity_id
  JOIN organization_currencies enabled_currency
    ON enabled_currency.organization_id = combination.organization_id
   AND enabled_currency.currency_code = NEW.currency_code
   AND enabled_currency.enabled
  WHERE combination.organization_id = NEW.organization_id
    AND combination.id = NEW.cash_account_combination_id
    AND combination.entity_id = NEW.legal_entity_id
    AND combination.ledger_id = NEW.ledger_id
    AND combination.active
    AND account.active
    AND account.postable
    AND account.class = 'ASSET'
    AND account.control_kind = 'NONE'
    AND ledger.active
    AND entity.active
  FOR SHARE OF combination, account, ledger, entity, enabled_currency;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank account mapping requires an enabled bank currency, one active entity/ledger combination, and a postable non-control asset account'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_external_account_mapping() FROM PUBLIC;
CREATE TRIGGER bank_external_account_mapping_guard
  BEFORE INSERT OR UPDATE ON bank_external_accounts
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_external_account_mapping();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_combination_mapping_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_mapping boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('bank-cash-mapping|' || OLD.organization_id::text, 0)
  );

  SELECT EXISTS (
    SELECT 1
    FROM bank_external_accounts external
    WHERE external.organization_id = OLD.organization_id
      AND external.cash_account_combination_id = OLD.id
  ) INTO has_mapping;

  IF TG_OP = 'DELETE' THEN
    IF has_mapping THEN
      RAISE EXCEPTION 'A cash account combination mapped to a bank account cannot be deleted or invalidated'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF has_mapping AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
    OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.subaccount_id IS DISTINCT FROM OLD.subaccount_id
    OR NEW.department_id IS DISTINCT FROM OLD.department_id
    OR NEW.intercompany_entity_id IS DISTINCT FROM OLD.intercompany_entity_id
    OR NEW.custom_1_id IS DISTINCT FROM OLD.custom_1_id
    OR NEW.custom_2_id IS DISTINCT FROM OLD.custom_2_id
    OR NEW.custom_3_id IS DISTINCT FROM OLD.custom_3_id
    OR NEW.custom_4_id IS DISTINCT FROM OLD.custom_4_id
    OR NEW.custom_5_id IS DISTINCT FROM OLD.custom_5_id
    OR NEW.custom_6_id IS DISTINCT FROM OLD.custom_6_id
    OR NEW.custom_7_id IS DISTINCT FROM OLD.custom_7_id
    OR NEW.custom_8_id IS DISTINCT FROM OLD.custom_8_id
    OR NOT NEW.active
  ) THEN
    RAISE EXCEPTION 'A cash account combination mapped to a bank account cannot be deleted or invalidated'
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_combination_mapping_state() FROM PUBLIC;
CREATE TRIGGER bank_account_combination_mapping_guard
  BEFORE UPDATE OR DELETE ON account_combinations
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_combination_mapping_state();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_gl_account_mapping_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('bank-cash-mapping|' || OLD.organization_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM account_combinations combination
    JOIN bank_external_accounts external
      ON external.organization_id = combination.organization_id
     AND external.cash_account_combination_id = combination.id
    WHERE combination.organization_id = OLD.organization_id
      AND combination.account_id = OLD.id
  ) AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
    OR NOT NEW.active
    OR NOT NEW.postable
    OR NEW.class <> 'ASSET'
    OR NEW.control_kind <> 'NONE'
  ) THEN
    RAISE EXCEPTION 'A general-ledger account mapped to banking must remain an active postable non-control asset account'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_gl_account_mapping_state() FROM PUBLIC;
CREATE TRIGGER bank_gl_account_mapping_guard
  BEFORE UPDATE ON gl_accounts
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_gl_account_mapping_state();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_ledger_mapping_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('bank-cash-mapping|' || OLD.organization_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM bank_external_accounts external
    WHERE external.organization_id = OLD.organization_id
      AND external.ledger_id = OLD.id
      AND (
        NOT NEW.active
        OR NEW.id IS DISTINCT FROM OLD.id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
      )
  ) THEN
    RAISE EXCEPTION 'A ledger mapped to banking must remain active and in its legal entity'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_ledger_mapping_state() FROM PUBLIC;
CREATE TRIGGER bank_ledger_mapping_guard
  BEFORE UPDATE ON ledgers
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_ledger_mapping_state();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_entity_mapping_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('bank-cash-mapping|' || OLD.organization_id::text, 0)
  );

  IF NOT NEW.active AND EXISTS (
    SELECT 1
    FROM bank_external_accounts external
    WHERE external.organization_id = OLD.organization_id
      AND external.legal_entity_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'A legal entity mapped to banking must remain active'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_entity_mapping_state() FROM PUBLIC;
CREATE TRIGGER bank_entity_mapping_guard
  BEFORE UPDATE ON legal_entities
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_entity_mapping_state();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_currency_mapping_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invalidates_currency boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    OLD.organization_id::text || '|organization-currency|' || upper(trim(OLD.currency_code)),
    0
  ));

  IF TG_OP = 'DELETE' THEN
    invalidates_currency := true;
  ELSE
    invalidates_currency := NEW.id IS DISTINCT FROM OLD.id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
      OR NOT NEW.enabled;
  END IF;

  IF invalidates_currency AND EXISTS (
    SELECT 1
    FROM bank_external_accounts external
    WHERE external.organization_id = OLD.organization_id
      AND external.currency_code = OLD.currency_code
      AND external.legal_entity_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A currency used by a mapped bank account must remain enabled for the organization'
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_currency_mapping_state() FROM PUBLIC;
CREATE TRIGGER bank_currency_mapping_guard
  BEFORE UPDATE OR DELETE ON organization_currencies
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_currency_mapping_state();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_sync_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lineage_valid boolean;
BEGIN
  IF TG_TABLE_NAME = 'bank_observations' THEN
    SELECT EXISTS (
      SELECT 1
      FROM bank_external_accounts external
      JOIN bank_sync_runs sync_run
        ON sync_run.organization_id = external.organization_id
       AND sync_run.id = NEW.first_seen_run_id
       AND sync_run.connection_id = external.connection_id
       AND sync_run.status = 'RUNNING'
      WHERE external.organization_id = NEW.organization_id
        AND external.id = NEW.external_account_id
    ) INTO lineage_valid;
  ELSIF TG_TABLE_NAME = 'bank_observation_versions' THEN
    SELECT EXISTS (
      SELECT 1
      FROM bank_observations observation
      JOIN bank_external_accounts external
        ON external.organization_id = observation.organization_id
       AND external.id = observation.external_account_id
      JOIN bank_sync_runs sync_run
        ON sync_run.organization_id = observation.organization_id
       AND sync_run.id = NEW.sync_run_id
       AND sync_run.connection_id = external.connection_id
       AND sync_run.status = 'RUNNING'
      WHERE observation.organization_id = NEW.organization_id
        AND observation.id = NEW.observation_id
    ) INTO lineage_valid;
  ELSIF TG_TABLE_NAME = 'bank_balance_anchors' THEN
    SELECT EXISTS (
      SELECT 1
      FROM bank_external_accounts external
      JOIN bank_sync_runs sync_run
        ON sync_run.organization_id = external.organization_id
       AND sync_run.id = NEW.sync_run_id
       AND sync_run.connection_id = external.connection_id
       AND sync_run.status = 'RUNNING'
      WHERE external.organization_id = NEW.organization_id
        AND external.id = NEW.external_account_id
    ) INTO lineage_valid;
  ELSIF TG_TABLE_NAME = 'bank_rule_runs' THEN
    SELECT EXISTS (
      SELECT 1
      FROM bank_observation_versions version
      JOIN bank_sync_runs sync_run
        ON sync_run.organization_id = version.organization_id
       AND sync_run.id = version.sync_run_id
       AND sync_run.status = 'RUNNING'
      WHERE version.organization_id = NEW.organization_id
        AND version.id = NEW.observation_version_id
        AND version.sync_run_id = NEW.sync_run_id
    ) INTO lineage_valid;
  ELSE
    lineage_valid := false;
  END IF;

  IF NOT coalesce(lineage_valid, false) THEN
    RAISE EXCEPTION 'Bank evidence must be appended to its exact provider connection while that sync run is running'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_sync_lineage() FROM PUBLIC;
CREATE TRIGGER bank_sync_lineage_guard
  BEFORE INSERT ON bank_observations
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_sync_lineage();
CREATE TRIGGER bank_sync_lineage_guard
  BEFORE INSERT ON bank_observation_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_sync_lineage();
CREATE TRIGGER bank_sync_lineage_guard
  BEFORE INSERT ON bank_balance_anchors
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_sync_lineage();
CREATE TRIGGER bank_sync_lineage_guard
  BEFORE INSERT ON bank_rule_runs
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_sync_lineage();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_observation_currency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  external_account_id uuid;
  external_currency text;
BEGIN
  SELECT external.id, external.currency_code
  INTO external_account_id, external_currency
  FROM bank_observations observation
  JOIN bank_external_accounts external
    ON external.organization_id = observation.organization_id
   AND external.id = observation.external_account_id
  WHERE observation.organization_id = NEW.organization_id
    AND observation.id = NEW.observation_id;

  IF external_account_id IS NULL OR external_currency <> NEW.currency_code THEN
    RAISE EXCEPTION 'Bank observation currency must match its external account currency'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq:bank-evidence:' || NEW.organization_id::text || ':' || external_account_id::text,
    0
  ));
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_observation_currency() FROM PUBLIC;
CREATE TRIGGER bank_observation_currency_guard
  BEFORE INSERT ON bank_observation_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_observation_currency();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_sync_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'RUNNING' OR NEW.status NOT IN ('SUCCEEDED', 'FAILED')
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.requested_start_on IS DISTINCT FROM OLD.requested_start_on
    OR NEW.requested_end_on IS DISTINCT FROM OLD.requested_end_on THEN
    RAISE EXCEPTION 'A bank sync run may transition once from running to a terminal result'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_sync_transition_guard
  BEFORE UPDATE ON bank_sync_runs
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_sync_transition();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_reconciliation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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
CREATE TRIGGER bank_reconciliation_transition_guard
  BEFORE UPDATE ON bank_reconciliation_sessions
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_reconciliation_transition();
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

  SELECT line.debit_transaction - line.credit_transaction
  INTO journal_line_amount
  FROM bank_reconciliation_sessions reconciliation
  JOIN journal_lines line
    ON line.organization_id = reconciliation.organization_id
   AND line.id = NEW.journal_line_id
   AND line.account_combination_id = reconciliation.cash_account_combination_id
   AND line.transaction_currency = reconciliation.currency_code
  JOIN journal_entries journal
    ON journal.organization_id = line.organization_id
   AND journal.id = line.journal_entry_id
   AND journal.status = 'POSTED'
  WHERE reconciliation.organization_id = NEW.organization_id
    AND reconciliation.id = NEW.reconciliation_session_id
    AND reconciliation.status = 'DRAFT'
    AND journal.accounting_date BETWEEN reconciliation.statement_start_on AND reconciliation.statement_end_on;

  IF observation_amount IS NULL OR journal_line_amount IS NULL THEN
    RAISE EXCEPTION 'A bank match requires current posted evidence and a posted mapped cash line in a draft reconciliation'
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
CREATE TRIGGER bank_match_allocation_cap_guard
  BEFORE INSERT ON bank_match_allocations
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_match_allocation_cap();
--> statement-breakpoint

-- Banking business events join the tenant's append-only hash chain. Metadata
-- deliberately contains only stable identifiers, states, versions, and proof
-- hashes: credentials, provider descriptions, rules, proposal payloads, and
-- human-entered void reasons never enter the plaintext audit stream.
CREATE OR REPLACE FUNCTION app.audit_banking_business_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_action text;
  selected_entity_type text;
  selected_entity_id text;
  selected_organization_id uuid;
  selected_metadata jsonb;
BEGIN
  IF TG_TABLE_NAME = 'bank_connections' THEN
    selected_organization_id := NEW.organization_id;
    selected_entity_type := 'bank_connection';
    selected_entity_id := NEW.id::text;
    IF TG_OP = 'INSERT' THEN
      selected_action := 'bank.connection.created';
      selected_metadata := jsonb_build_object(
        'provider', NEW.provider, 'status', NEW.status,
        'credentialVersion', NEW.credential_version,
        'credentialKeyVersion', NEW.credentials_key_version
      );
    ELSIF NEW.credentials_ciphertext IS DISTINCT FROM OLD.credentials_ciphertext
      OR NEW.credentials_key_version IS DISTINCT FROM OLD.credentials_key_version THEN
      selected_action := 'bank.connection.reauthorized';
      selected_metadata := jsonb_build_object(
        'provider', NEW.provider, 'fromStatus', OLD.status, 'toStatus', NEW.status,
        'credentialVersion', NEW.credential_version,
        'credentialKeyVersion', NEW.credentials_key_version
      );
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      selected_action := CASE NEW.status
        WHEN 'DISABLED' THEN 'bank.connection.disabled'
        WHEN 'REAUTHORIZATION_REQUIRED' THEN 'bank.connection.reauthorization-required'
        WHEN 'ACTIVE' THEN 'bank.connection.activated'
        ELSE 'bank.connection.status-changed'
      END;
      selected_metadata := jsonb_build_object(
        'provider', NEW.provider, 'fromStatus', OLD.status, 'toStatus', NEW.status,
        'errorCode', NEW.last_error_code
      );
    ELSE
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'bank_connection_credential_events' THEN
    selected_organization_id := NEW.organization_id;
    selected_entity_type := 'bank_connection';
    selected_entity_id := NEW.connection_id::text;
    selected_action := 'bank.connection.credential-version-recorded';
    selected_metadata := jsonb_build_object(
      'credentialEventId', NEW.id, 'credentialVersion', NEW.credential_version,
      'eventType', NEW.event_type, 'credentialCiphertextHash', NEW.credential_ciphertext_hash,
      'credentialKeyVersion', NEW.credential_key_version, 'commandHash', NEW.command_hash
    );
  ELSIF TG_TABLE_NAME = 'bank_external_accounts' THEN
    IF TG_OP <> 'UPDATE' OR (
      NEW.legal_entity_id IS NOT DISTINCT FROM OLD.legal_entity_id
      AND NEW.ledger_id IS NOT DISTINCT FROM OLD.ledger_id
      AND NEW.cash_account_combination_id IS NOT DISTINCT FROM OLD.cash_account_combination_id
    ) THEN RETURN NEW; END IF;
    selected_organization_id := NEW.organization_id;
    selected_entity_type := 'bank_external_account';
    selected_entity_id := NEW.id::text;
    selected_action := 'bank.account.mapping-changed';
    selected_metadata := jsonb_build_object(
      'fromEntityId', OLD.legal_entity_id, 'toEntityId', NEW.legal_entity_id,
      'fromLedgerId', OLD.ledger_id, 'toLedgerId', NEW.ledger_id,
      'fromAccountCombinationId', OLD.cash_account_combination_id,
      'toAccountCombinationId', NEW.cash_account_combination_id,
      'currencyCode', NEW.currency_code
    );
  ELSIF TG_TABLE_NAME = 'bank_rules' THEN
    selected_organization_id := NEW.organization_id;
    selected_entity_type := 'bank_rule';
    selected_entity_id := NEW.id::text;
    selected_action := 'bank.rule.version-created';
    selected_metadata := jsonb_build_object(
      'state', NEW.state, 'priority', NEW.priority, 'version', NEW.version,
      'supersedesRuleId', NEW.supersedes_rule_id, 'commandHash', NEW.command_hash
    );
  ELSIF TG_TABLE_NAME = 'bank_match_allocations' THEN
    selected_organization_id := NEW.organization_id;
    selected_entity_type := 'bank_match_allocation';
    selected_entity_id := NEW.id::text;
    selected_action := 'bank.reconciliation.match-created';
    selected_metadata := jsonb_build_object(
      'reconciliationId', NEW.reconciliation_session_id,
      'observationVersionId', NEW.observation_version_id,
      'journalLineId', NEW.journal_line_id, 'matchKind', NEW.match_kind
    );
  ELSIF TG_TABLE_NAME = 'bank_match_allocation_voids' THEN
    selected_organization_id := NEW.organization_id;
    selected_entity_type := 'bank_match_allocation';
    selected_entity_id := NEW.allocation_id::text;
    selected_action := 'bank.reconciliation.match-voided';
    selected_metadata := jsonb_build_object('voidId', NEW.id);
  ELSIF TG_TABLE_NAME = 'bank_reconciliation_voids' THEN
    selected_organization_id := NEW.organization_id;
    selected_entity_type := 'bank_reconciliation';
    selected_entity_id := NEW.reconciliation_session_id::text;
    selected_action := 'bank.reconciliation.void-reason-recorded';
    selected_metadata := jsonb_build_object('voidId', NEW.id, 'reasonRecorded', true);
  ELSIF TG_TABLE_NAME = 'bank_reconciliation_sessions' THEN
    selected_organization_id := NEW.organization_id;
    selected_entity_type := 'bank_reconciliation';
    selected_entity_id := NEW.id::text;
    IF TG_OP = 'INSERT' THEN
      selected_action := 'bank.reconciliation.created';
      selected_metadata := jsonb_build_object(
        'externalAccountId', NEW.external_account_id,
        'entityId', NEW.legal_entity_id, 'ledgerId', NEW.ledger_id,
        'accountCombinationId', NEW.cash_account_combination_id,
        'currencyCode', NEW.currency_code, 'commandHash', NEW.command_hash
      );
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      selected_action := CASE NEW.status
        WHEN 'SUBMITTED' THEN 'bank.reconciliation.submitted'
        WHEN 'REVIEWED' THEN 'bank.reconciliation.reviewed'
        WHEN 'FINALIZED' THEN 'bank.reconciliation.finalized'
        WHEN 'VOIDED' THEN 'bank.reconciliation.voided'
        ELSE 'bank.reconciliation.status-changed'
      END;
      selected_metadata := jsonb_build_object(
        'fromStatus', OLD.status, 'toStatus', NEW.status,
        'finalizedMatchHash', NEW.finalized_match_hash
      );
    ELSE
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM app.append_tenant_business_audit(
    selected_organization_id, selected_action, selected_entity_type,
    selected_entity_id, jsonb_strip_nulls(selected_metadata), NULL
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.audit_banking_business_event() FROM PUBLIC;

CREATE TRIGGER bank_connections_business_audit
  AFTER INSERT OR UPDATE ON bank_connections
  FOR EACH ROW EXECUTE FUNCTION app.audit_banking_business_event();
CREATE TRIGGER bank_connection_credential_events_business_audit
  AFTER INSERT ON bank_connection_credential_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_banking_business_event();
CREATE TRIGGER bank_external_accounts_business_audit
  AFTER UPDATE ON bank_external_accounts
  FOR EACH ROW EXECUTE FUNCTION app.audit_banking_business_event();
CREATE TRIGGER bank_rules_business_audit
  AFTER INSERT ON bank_rules
  FOR EACH ROW EXECUTE FUNCTION app.audit_banking_business_event();
CREATE TRIGGER bank_match_allocations_business_audit
  AFTER INSERT ON bank_match_allocations
  FOR EACH ROW EXECUTE FUNCTION app.audit_banking_business_event();
CREATE TRIGGER bank_match_allocation_voids_business_audit
  AFTER INSERT ON bank_match_allocation_voids
  FOR EACH ROW EXECUTE FUNCTION app.audit_banking_business_event();
CREATE TRIGGER bank_reconciliation_voids_business_audit
  AFTER INSERT ON bank_reconciliation_voids
  FOR EACH ROW EXECUTE FUNCTION app.audit_banking_business_event();
CREATE TRIGGER bank_reconciliation_sessions_business_audit
  AFTER INSERT OR UPDATE ON bank_reconciliation_sessions
  FOR EACH ROW EXECUTE FUNCTION app.audit_banking_business_event();
--> statement-breakpoint

REVOKE ALL ON bank_connections, bank_connection_credential_events, bank_external_accounts, bank_sync_runs,
  bank_observations, bank_observation_versions, bank_balance_anchors,
  bank_reconciliation_sessions, bank_reconciliation_voids, bank_match_allocations, bank_match_allocation_voids, bank_rules,
  bank_rule_runs, bank_draft_proposals FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT SELECT ON bank_connections, bank_connection_credential_events, bank_external_accounts, bank_sync_runs,
      bank_observations, bank_observation_versions, bank_balance_anchors,
      bank_reconciliation_sessions, bank_reconciliation_voids, bank_match_allocations, bank_match_allocation_voids, bank_rules,
      bank_rule_runs, bank_draft_proposals TO business_finlynq_app;
    GRANT INSERT, UPDATE ON bank_connections, bank_external_accounts, bank_sync_runs
      TO business_finlynq_app;
    GRANT INSERT ON bank_connection_credential_events, bank_observations, bank_observation_versions, bank_balance_anchors,
      bank_reconciliation_voids, bank_match_allocations, bank_match_allocation_voids, bank_rules,
      bank_rule_runs, bank_draft_proposals TO business_finlynq_app;
    GRANT INSERT, UPDATE ON bank_reconciliation_sessions TO business_finlynq_app;
  END IF;
END
$$;
--> statement-breakpoint

INSERT INTO demo_sandbox_reset_tables(table_name, purge_order) VALUES
  ('bank_draft_proposals', 30),
  ('bank_rule_runs', 31),
  ('bank_reconciliation_voids', 32),
  ('bank_match_allocation_voids', 33),
  ('bank_match_allocations', 34),
  ('bank_reconciliation_sessions', 35),
  ('bank_observation_versions', 36),
  ('bank_observations', 37),
  ('bank_balance_anchors', 38),
  ('bank_sync_runs', 39),
  ('bank_rules', 40),
  ('bank_connection_credential_events', 41),
  ('bank_external_accounts', 42),
  ('bank_connections', 43)
ON CONFLICT (table_name) DO UPDATE SET purge_order = EXCLUDED.purge_order;
