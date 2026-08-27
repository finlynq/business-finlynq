CREATE TYPE manual_posting_mode AS ENUM ('REVIEW_REQUIRED', 'AUTO_POST');
--> statement-breakpoint

ALTER TABLE journal_entries
  ADD COLUMN command_hash text NOT NULL DEFAULT repeat('0', 64),
  ADD CONSTRAINT journal_entries_command_hash_check
    CHECK (command_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint

ALTER TABLE parties
  ADD COLUMN display_name_key_version integer NOT NULL DEFAULT 1,
  ADD COLUMN command_hash text NOT NULL DEFAULT repeat('0', 64),
  ADD CONSTRAINT parties_display_name_key_version_check
    CHECK (display_name_key_version > 0),
  ADD CONSTRAINT parties_search_token_check
    CHECK (search_token ~ '^hmac-sha256-v1:[0-9a-f]{64}$'),
  ADD CONSTRAINT parties_command_hash_check
    CHECK (command_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
CREATE INDEX parties_org_search_token_idx ON parties (organization_id, search_token);
--> statement-breakpoint
CREATE UNIQUE INDEX organization_key_versions_one_active_unique
  ON organization_key_versions (organization_id)
  WHERE active;
--> statement-breakpoint

CREATE TABLE ledger_posting_policies (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,
  manual_mode manual_posting_mode NOT NULL DEFAULT 'REVIEW_REQUIRED',
  version integer NOT NULL DEFAULT 1,
  updated_by uuid NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ledger_posting_policies_version_check CHECK (version > 0),
  CONSTRAINT ledger_posting_policies_tenant_ledger_fk
    FOREIGN KEY (organization_id, ledger_id)
    REFERENCES ledgers (organization_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX ledger_posting_policies_ledger_unique
  ON ledger_posting_policies (ledger_id);
CREATE UNIQUE INDEX ledger_posting_policies_org_ledger_unique
  ON ledger_posting_policies (organization_id, ledger_id);
--> statement-breakpoint
ALTER TABLE ledger_posting_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_posting_policies
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

CREATE UNIQUE INDEX journal_relations_one_full_reversal_unique
  ON journal_entry_relations (organization_id, to_journal_id)
  WHERE kind = 'REVERSAL_OF';
--> statement-breakpoint

INSERT INTO permissions (key, description) VALUES
  ('ledger.posting_policy.manage', 'Configure ledger-level manual journal posting policy'),
  ('ledger.period.seal', 'Irreversibly seal a hard-closed fiscal period with step-up authentication'),
  ('parties.read', 'Read decrypted party master data'),
  ('parties.manage', 'Create and maintain encrypted party master data')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;
--> statement-breakpoint

INSERT INTO journal_type_definitions (id, key, version, owner_module, display_name, correction_route)
VALUES
  ('88888888-8888-4888-8888-888888888888', 'ledger.manual', 1, 'ledger', 'Manual journal', '/app/journals'),
  ('88888888-8888-4888-8888-888888888889', 'ledger.reversal', 1, 'ledger', 'Full journal reversal', '/app/journals'),
  ('88888888-8888-4888-8888-888888888881', 'receivables.sales-invoice', 1, 'receivables', 'Sales invoice', '/app/receivables/invoices'),
  ('88888888-8888-4888-8888-888888888882', 'payables.supplier-bill', 1, 'payables', 'Supplier bill', '/app/payables/bills')
ON CONFLICT (key, version) DO UPDATE SET
  owner_module = EXCLUDED.owner_module,
  display_name = EXCLUDED.display_name,
  correction_route = EXCLUDED.correction_route;
--> statement-breakpoint

-- Runtime key installation never receives plaintext key material. The app
-- wraps the DEK with the mounted root key, then this function installs the
-- first immutable envelope for an authorized, non-demo organization.
CREATE OR REPLACE FUNCTION app.install_initial_organization_key(
  selected_provider text,
  selected_wrapped_dek text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_organization_id uuid;
  envelope jsonb;
BEGIN
  selected_organization_id := app.current_organization_id();
  IF selected_organization_id IS NULL
    OR NOT app.current_actor_has_permission('organization.recovery.manage') THEN
    RAISE EXCEPTION 'Organization key installation requires recovery-management permission'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM organizations organization
    WHERE organization.id = selected_organization_id
      AND (NOT organization.active OR organization.is_demo)
  ) THEN
    RAISE EXCEPTION 'Organization keys cannot be installed for an inactive or demo organization'
      USING ERRCODE = '42501';
  END IF;

  IF length(selected_provider) NOT BETWEEN 1 AND 100
    OR length(selected_wrapped_dek) NOT BETWEEN 40 AND 4000 THEN
    RAISE EXCEPTION 'Organization key envelope is invalid' USING ERRCODE = '22023';
  END IF;

  BEGIN
    envelope := selected_wrapped_dek::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Organization key envelope must be valid JSON' USING ERRCODE = '22023';
  END;
  IF envelope->>'format' <> 'business-finlynq-wrapped-key-v1'
    OR envelope->>'provider' <> selected_provider
    OR (envelope->>'keyVersion')::integer <> 1 THEN
    RAISE EXCEPTION 'Organization key envelope metadata is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(selected_organization_id::text || ':organization-key', 0));
  IF EXISTS (
    SELECT 1 FROM organization_key_versions
    WHERE organization_id = selected_organization_id
  ) THEN
    RAISE EXCEPTION 'Organization already has key material; use the controlled rotation workflow'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO organization_key_versions (
    organization_id, version, key_provider, wrapped_dek, active
  ) VALUES (
    selected_organization_id, 1, selected_provider, selected_wrapped_dek, true
  );
  RETURN 1;
END
$$;
REVOKE ALL ON FUNCTION app.install_initial_organization_key(text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_tenant_journal_draft_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NOT NULL THEN
    IF NOT app.current_actor_has_permission('ledger.journal.draft') THEN
      RAISE EXCEPTION 'Journal draft permission is required for an active organization member'
        USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM organizations organization
      WHERE organization.id = NEW.organization_id AND organization.is_demo
    ) THEN
      RAISE EXCEPTION 'The public demo organization is read-only' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_entries_tenant_draft_authorization
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.guard_tenant_journal_draft_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_journal_command_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.command_hash IS DISTINCT FROM OLD.command_hash THEN
    RAISE EXCEPTION 'Journal command fingerprint is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_entries_command_hash_immutable
  BEFORE UPDATE OF command_hash ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_command_hash();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_tenant_party_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_organization_id uuid;
BEGIN
  target_organization_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF nullif(current_setting('app.organization_id', true), '') IS NOT NULL THEN
    IF NOT app.current_actor_has_permission('parties.manage') THEN
      RAISE EXCEPTION 'Party-management permission is required' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM organizations organization
      WHERE organization.id = target_organization_id AND organization.is_demo
    ) THEN
      RAISE EXCEPTION 'The public demo organization is read-only' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER parties_tenant_write_authorization
  BEFORE INSERT OR UPDATE OR DELETE ON parties
  FOR EACH ROW EXECUTE FUNCTION app.guard_tenant_party_write();
CREATE TRIGGER party_addresses_tenant_write_authorization
  BEFORE INSERT OR UPDATE OR DELETE ON party_addresses
  FOR EACH ROW EXECUTE FUNCTION app.guard_tenant_party_write();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_party_command_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.command_hash IS DISTINCT FROM OLD.command_hash THEN
    RAISE EXCEPTION 'Party creation fingerprint is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER parties_command_hash_immutable
  BEFORE UPDATE OF command_hash ON parties
  FOR EACH ROW EXECUTE FUNCTION app.guard_party_command_hash();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_ledger_posting_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NOT NULL THEN
    IF NOT app.current_actor_has_permission('ledger.posting_policy.manage') THEN
      RAISE EXCEPTION 'Posting-policy management permission is required' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM organizations organization
      WHERE organization.id = NEW.organization_id AND organization.is_demo
    ) THEN
      RAISE EXCEPTION 'The public demo organization is read-only' USING ERRCODE = '42501';
    END IF;
    IF NEW.updated_by IS DISTINCT FROM app.current_actor_id() THEN
      RAISE EXCEPTION 'Posting-policy actor does not match transaction context' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.version <> 1 THEN
    RAISE EXCEPTION 'Posting-policy creation must start at version 1'
      USING ERRCODE = '40001';
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
      OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Posting-policy updates require the next optimistic version'
        USING ERRCODE = '40001';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ledger_posting_policies_guard
  BEFORE INSERT OR UPDATE ON ledger_posting_policies
  FOR EACH ROW EXECUTE FUNCTION app.guard_ledger_posting_policy();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_period_state_machine()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.state = 'OPEN' AND NEW.state = 'ADJUSTMENT_ONLY')
    OR (OLD.state = 'ADJUSTMENT_ONLY' AND NEW.state IN ('OPEN', 'HARD_CLOSED'))
    OR (OLD.state = 'HARD_CLOSED' AND NEW.state IN ('OPEN', 'ADJUSTMENT_ONLY', 'SEALED'))
  ) THEN
    RAISE EXCEPTION 'Invalid fiscal-period state transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fiscal_periods_state_machine
  BEFORE UPDATE OF state ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION app.guard_period_state_machine();
--> statement-breakpoint

-- Sealing is irreversible. Like reopening, it needs a dedicated permission
-- and live step-up MFA provenance in the transaction context.
CREATE OR REPLACE FUNCTION app.guard_period_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor uuid;
  reason text;
  auth_method text;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
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

  auth_method := lower(coalesce(current_setting('app.auth_method', true), ''));
  IF (OLD.state = 'HARD_CLOSED' AND NEW.state IN ('OPEN', 'ADJUSTMENT_ONLY'))
    OR (OLD.state = 'ADJUSTMENT_ONLY' AND NEW.state = 'OPEN') THEN
    IF NOT app.current_actor_has_permission('ledger.period.reopen') THEN
      RAISE EXCEPTION 'Period reopening permission is required'
        USING ERRCODE = '42501';
    END IF;
    IF auth_method NOT LIKE '%mfa%' THEN
      RAISE EXCEPTION 'Period reopening requires step-up MFA authentication'
        USING ERRCODE = '28000';
    END IF;
  ELSIF OLD.state = 'HARD_CLOSED' AND NEW.state = 'SEALED' THEN
    IF NOT app.current_actor_has_permission('ledger.period.seal') THEN
      RAISE EXCEPTION 'Period sealing permission is required'
        USING ERRCODE = '42501';
    END IF;
    IF auth_method NOT LIKE '%mfa%' THEN
      RAISE EXCEPTION 'Period sealing requires step-up MFA authentication'
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

-- Audit helpers are trigger-only. They serialize each organization's hash
-- chain and derive actor/request data only from transaction-local context.
CREATE OR REPLACE FUNCTION app.append_tenant_business_audit(
  selected_organization_id uuid,
  selected_action text,
  selected_entity_type text,
  selected_entity_id text,
  selected_metadata jsonb,
  selected_topic text
)
RETURNS void
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
  actor := nullif(current_setting('app.actor_id', true), '');
  request_key := nullif(current_setting('app.request_id', true), '');
  -- Owner-operated fixtures and migrations are outside the runtime audit path.
  IF actor IS NULL AND request_key IS NULL THEN RETURN; END IF;
  IF actor IS NULL OR request_key IS NULL THEN
    RAISE EXCEPTION 'Business writes require actor and request context' USING ERRCODE = '28000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(selected_organization_id::text, 0));
  SELECT event_hash INTO previous_hash
  FROM audit_events
  WHERE organization_id = selected_organization_id
  ORDER BY occurred_at DESC, id DESC
  LIMIT 1;

  next_hash := encode(digest(
    coalesce(previous_hash, '') || selected_organization_id::text || selected_entity_id ||
      request_key || selected_action || selected_metadata::text,
    'sha256'
  ), 'hex');

  INSERT INTO audit_events (
    organization_id, actor_type, actor_id, auth_method, source_surface,
    action, entity_type, entity_id, request_id, reason, safe_metadata,
    previous_event_hash, event_hash
  ) VALUES (
    selected_organization_id, 'USER_OR_SERVICE', actor,
    coalesce(nullif(current_setting('app.auth_method', true), ''), 'application'),
    coalesce(nullif(current_setting('app.source_surface', true), ''), 'UI'),
    selected_action, selected_entity_type, selected_entity_id, request_key,
    nullif(current_setting('app.reason', true), ''), selected_metadata,
    previous_hash, next_hash
  );

  IF selected_topic IS NOT NULL THEN
    INSERT INTO outbox_events (
      organization_id, topic, aggregate_type, aggregate_id, payload
    ) VALUES (
      selected_organization_id, selected_topic, selected_entity_type, selected_entity_id,
      selected_metadata
    );
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.append_tenant_business_audit(uuid, text, text, text, jsonb, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_journal_draft_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id, 'journal.draft-created', 'journal_entry', NEW.id::text,
    jsonb_build_object('ledgerId', NEW.ledger_id, 'commandHash', NEW.command_hash),
    'ledger.journal-draft-created'
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_entries_audit_draft_created
  AFTER INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.audit_journal_draft_created();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.emit_period_transition_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  INSERT INTO outbox_events (
    organization_id, topic, aggregate_type, aggregate_id, payload
  ) VALUES (
    NEW.organization_id, 'ledger.period-transitioned', 'fiscal_period', NEW.id::text,
    jsonb_build_object(
      'periodId', NEW.id,
      'ledgerId', NEW.ledger_id,
      'fromState', OLD.state,
      'toState', NEW.state,
      'version', NEW.version
    )
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER fiscal_periods_transition_outbox
  AFTER UPDATE OF state ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION app.emit_period_transition_outbox();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_full_journal_reversal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.kind = 'REVERSAL_OF' THEN
    PERFORM app.append_tenant_business_audit(
      NEW.organization_id, 'journal.reversed', 'journal_entry', NEW.to_journal_id::text,
      jsonb_build_object('reversalJournalId', NEW.from_journal_id, 'reason', NEW.reason),
      'ledger.journal-reversed'
    );
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_relations_audit_full_reversal
  AFTER INSERT ON journal_entry_relations
  FOR EACH ROW EXECUTE FUNCTION app.audit_full_journal_reversal();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_party_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id, 'party.created', 'party', NEW.id::text,
    jsonb_build_object('partyNumber', NEW.party_number), 'parties.party-created'
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER parties_audit_created
  AFTER INSERT ON parties
  FOR EACH ROW EXECUTE FUNCTION app.audit_party_created();
--> statement-breakpoint

REVOKE ALL ON ledger_posting_policies FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.audit_journal_draft_created(),
  app.audit_full_journal_reversal(), app.audit_party_created(),
  app.emit_period_transition_outbox() FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON ledger_posting_policies FROM business_finlynq_app;
    GRANT SELECT, INSERT, UPDATE ON ledger_posting_policies TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.install_initial_organization_key(text, text)
      TO business_finlynq_app;
    REVOKE EXECUTE ON FUNCTION app.append_tenant_business_audit(uuid, text, text, text, jsonb, text),
      app.audit_journal_draft_created(), app.audit_full_journal_reversal(),
      app.audit_party_created(), app.emit_period_transition_outbox()
      FROM business_finlynq_app;
  END IF;
END
$$;
