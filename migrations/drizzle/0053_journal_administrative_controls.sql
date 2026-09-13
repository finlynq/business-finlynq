-- Owner/admin-only unposting and user-visible deletion. Journals and lines are
-- retained permanently; deletion is represented by an append-only tombstone.

INSERT INTO permissions(key, description) VALUES
  ('ledger.journal.administer', 'Unpost and tombstone manual general-ledger transactions')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;
--> statement-breakpoint
INSERT INTO role_permissions(organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, 'ledger.journal.administer'
FROM roles role
WHERE role.active AND role.key IN ('OWNER', 'ORGANIZATION_ADMIN')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Keep the entitlement attached to every active reserved owner/admin role,
-- regardless of whether it was created or reactivated by application code,
-- self-service signup, an upgrade, or an operator-reviewed SQL workflow.
CREATE OR REPLACE FUNCTION app.assign_journal_admin_template_permission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.active AND NEW.key IN ('OWNER', 'ORGANIZATION_ADMIN') THEN
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key)
    VALUES (NEW.organization_id, NEW.id, 'ledger.journal.administer')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.assign_journal_admin_template_permission() FROM PUBLIC;
DROP TRIGGER IF EXISTS assign_journal_admin_template_permission ON roles;
CREATE CONSTRAINT TRIGGER assign_journal_admin_template_permission
  AFTER INSERT OR UPDATE OF organization_id, key, active ON roles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assign_journal_admin_template_permission();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_journal_admin_template_permission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE selected_organization_id uuid;
DECLARE selected_role_id uuid;
DECLARE selected_permission_key text;
BEGIN
  selected_organization_id := OLD.organization_id;
  selected_role_id := OLD.role_id;
  selected_permission_key := OLD.permission_key;
  IF selected_permission_key = 'ledger.journal.administer' AND EXISTS (
    SELECT 1 FROM public.roles role
    WHERE role.organization_id = selected_organization_id
      AND role.id = selected_role_id
      AND role.active
      AND role.key IN ('OWNER', 'ORGANIZATION_ADMIN')
  ) THEN
    RAISE EXCEPTION 'Active owner and organization administrator roles must retain ledger.journal.administer'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION app.guard_journal_admin_template_permission() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_journal_admin_template_permission ON role_permissions;
CREATE TRIGGER guard_journal_admin_template_permission
  BEFORE DELETE OR UPDATE OF organization_id, role_id, permission_key ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_admin_template_permission();
--> statement-breakpoint

INSERT INTO audit_outbox_pair_contract(
  audit_action, outbox_topic, aggregate_type, contract_version
) VALUES
  ('journal.unpost', 'ledger.journal-unpost', 'journal_entry', 'business-audit-outbox-v1'),
  ('journal.delete', 'ledger.journal-delete', 'journal_entry', 'business-audit-outbox-v1');
--> statement-breakpoint

CREATE TABLE journal_transaction_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL CONSTRAINT journal_transaction_controls_organization_id_organizations_id_fk REFERENCES organizations(id) ON DELETE RESTRICT,
  journal_entry_id uuid NOT NULL CONSTRAINT journal_transaction_controls_journal_entry_id_journal_entries_id_fk REFERENCES journal_entries(id) ON DELETE RESTRICT,
  action text NOT NULL CONSTRAINT journal_transaction_controls_action_check CHECK (action IN ('UNPOST', 'DELETE')),
  previous_status journal_status NOT NULL,
  previous_journal_number integer,
  outcome text NOT NULL CONSTRAINT journal_transaction_controls_outcome_check CHECK (outcome IN ('UNPOSTED', 'DELETED')),
  reason text NOT NULL CONSTRAINT journal_transaction_controls_reason_check CHECK (
    length(reason) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'
  ),
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  request_id text NOT NULL CONSTRAINT journal_transaction_controls_request_id_check CHECK (
    length(request_id) BETWEEN 1 AND 200 AND request_id !~ '[[:cntrl:]]'
  ),
  idempotency_key text NOT NULL CONSTRAINT journal_transaction_controls_idempotency_key_check CHECK (
    idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  command_hash text NOT NULL CONSTRAINT journal_transaction_controls_command_hash_check CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX journal_transaction_controls_org_idempotency_unique
  ON journal_transaction_controls(organization_id, idempotency_key);
CREATE UNIQUE INDEX journal_transaction_controls_org_id_unique
  ON journal_transaction_controls(organization_id, id);
CREATE INDEX journal_transaction_controls_journal_created_idx
  ON journal_transaction_controls(organization_id, journal_entry_id, created_at);
ALTER TABLE journal_transaction_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_transaction_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_transaction_controls
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE TRIGGER journal_transaction_controls_append_only
  BEFORE UPDATE OR DELETE ON journal_transaction_controls
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();
REVOKE ALL ON journal_transaction_controls FROM PUBLIC;
--> statement-breakpoint

-- Retain every existing workflow guard and admit one exact owner-executed
-- transition used by the SECURITY DEFINER command below.
CREATE OR REPLACE FUNCTION app.guard_posted_journal_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM journal_transaction_controls control
    WHERE control.organization_id = OLD.organization_id
      AND control.journal_entry_id = OLD.id
      AND control.outcome = 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Deleted journal tombstones are immutable' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED'
    AND current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'public.journal_entries'::pg_catalog.regclass
    ))
    AND current_setting('app.journal_control_action', true) = 'UNPOST:' || OLD.id::text THEN
    IF NEW.status <> 'DRAFT'
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
      OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
      OR NEW.period_id IS DISTINCT FROM OLD.period_id
      OR NEW.journal_type_definition_id IS DISTINCT FROM OLD.journal_type_definition_id
      OR NEW.journal_type_key IS DISTINCT FROM OLD.journal_type_key
      OR NEW.journal_type_version IS DISTINCT FROM OLD.journal_type_version
      OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
      OR NEW.source_event_key IS DISTINCT FROM OLD.source_event_key
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.command_hash IS DISTINCT FROM OLD.command_hash
      OR NEW.origin IS DISTINCT FROM OLD.origin
      OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.accounting_date IS DISTINCT FROM OLD.accounting_date
      OR NEW.functional_currency IS DISTINCT FROM OLD.functional_currency
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.journal_number IS NOT NULL
      OR NEW.content_hash IS NOT NULL
      OR NEW.approval_version IS NOT NULL
      OR NEW.approved_by IS NOT NULL
      OR NEW.approved_at IS NOT NULL
      OR NEW.posted_by IS NOT NULL
      OR NEW.posted_at IS NOT NULL
      OR NEW.total_debit_functional <> 0
      OR NEW.total_credit_functional <> 0 THEN
      RAISE EXCEPTION 'Invalid controlled journal unpost transition' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

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
    RAISE EXCEPTION 'Submitted journal content is frozen; return it to draft before editing' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'APPROVED' AND NEW.status NOT IN ('DRAFT', 'POSTED') THEN
    RAISE EXCEPTION 'Approved journal content is frozen; return it to draft before editing' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT', 'SUBMITTED', 'POSTED') THEN
    RAISE EXCEPTION 'Invalid journal workflow transition from draft' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status = 'APPROVED'
    AND NOT app.current_actor_has_permission('ledger.journal.approve') THEN
    RAISE EXCEPTION 'Approval permission is required' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED'
    AND NOT app.current_actor_has_permission('ledger.journal.submit') THEN
    RAISE EXCEPTION 'Submission permission is required' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED' THEN
    NEW.content_hash := app.compute_journal_content_hash(OLD.id);
    SELECT coalesce(max(approval.journal_version), 0) + 1 INTO NEW.approval_version
    FROM journal_approvals approval
    WHERE approval.organization_id = OLD.organization_id
      AND approval.ledger_id = OLD.ledger_id
      AND approval.journal_entry_id = OLD.id;
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status = 'APPROVED' AND (
    NEW.approval_version IS NULL OR NOT EXISTS (
      SELECT 1 FROM journal_approvals approval
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

CREATE OR REPLACE FUNCTION app.guard_deleted_journal_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE selected_journal_id uuid;
DECLARE selected_organization_id uuid;
BEGIN
  selected_journal_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.journal_entry_id ELSE OLD.journal_entry_id END;
  selected_organization_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.organization_id ELSE OLD.organization_id END;
  IF EXISTS (
    SELECT 1 FROM journal_transaction_controls control
    WHERE control.organization_id = selected_organization_id
      AND control.journal_entry_id = selected_journal_id
      AND control.outcome = 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Deleted journal lines are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER journal_lines_deleted_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_deleted_journal_line();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.admin_control_journal_transaction(
  selected_action text,
  selected_journal_id uuid,
  selected_reason text,
  selected_idempotency_key text
)
RETURNS TABLE(
  journal_id uuid,
  result_status text,
  journal_number integer,
  idempotent_replay boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  selected_authorization record;
  selected_entry journal_entries%ROWTYPE;
  selected_owner_module text;
  selected_period_state text;
  selected_command_hash text;
  existing_control journal_transaction_controls%ROWTYPE;
  selected_request_id text;
  selected_audit_metadata jsonb;
BEGIN
  IF selected_action NOT IN ('UNPOST', 'DELETE')
    OR selected_idempotency_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR length(selected_reason) NOT BETWEEN 10 AND 500
    OR selected_reason ~ '[[:cntrl:]]'
    OR selected_reason IS DISTINCT FROM nullif(current_setting('app.reason', true), '') THEN
    RAISE EXCEPTION 'Invalid journal administration request' USING ERRCODE = '22023';
  END IF;
  selected_request_id := nullif(current_setting('app.request_id', true), '');
  IF selected_request_id IS NULL THEN
    RAISE EXCEPTION 'Journal administration requires request context' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO selected_authorization
  FROM app.organization_admin_authorize('ledger.journal.administer', true);
  IF selected_authorization.is_demo THEN
    RAISE EXCEPTION 'Journal administration is unavailable in the public demo' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM organization_memberships membership
    JOIN membership_roles membership_role
      ON membership_role.organization_id = membership.organization_id
     AND membership_role.membership_id = membership.id
    JOIN roles role
      ON role.organization_id = membership_role.organization_id
     AND role.id = membership_role.role_id
    WHERE membership.organization_id = selected_authorization.organization_id
      AND membership.user_id = selected_authorization.actor_id
      AND membership.active AND role.active
      AND role.key IN ('OWNER', 'ORGANIZATION_ADMIN')
  ) THEN
    RAISE EXCEPTION 'Journal administration requires an owner or organization administrator'
      USING ERRCODE = '42501';
  END IF;
  selected_command_hash := encode(digest(
    convert_to(selected_action || chr(31) || selected_journal_id::text || chr(31) || selected_reason, 'UTF8'),
    'sha256'
  ), 'hex');

  -- Serialize every idempotency key before checking its durable result. A
  -- concurrent retry waits, observes the committed control row, and returns
  -- the same result instead of racing the journal-state transition.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    selected_authorization.organization_id::text || chr(31) || selected_idempotency_key,
    0
  ));

  SELECT * INTO existing_control
  FROM journal_transaction_controls control
  WHERE control.organization_id = selected_authorization.organization_id
    AND control.idempotency_key = selected_idempotency_key;
  IF existing_control.id IS NOT NULL THEN
    IF existing_control.journal_entry_id IS DISTINCT FROM selected_journal_id
      OR existing_control.action IS DISTINCT FROM selected_action
      OR existing_control.command_hash IS DISTINCT FROM selected_command_hash THEN
      RAISE EXCEPTION 'Journal administration idempotency key was reused for a different command'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing_control.journal_entry_id,
      CASE existing_control.outcome WHEN 'UNPOSTED' THEN 'DRAFT' ELSE 'DELETED' END,
      NULL::integer, true;
    RETURN;
  END IF;

  SELECT entry.* INTO selected_entry
  FROM journal_entries entry
  WHERE entry.organization_id = selected_authorization.organization_id
    AND entry.id = selected_journal_id
  FOR UPDATE OF entry;
  IF selected_entry.id IS NOT NULL THEN
    SELECT journal_type.owner_module, period.state::text
    INTO selected_owner_module, selected_period_state
    FROM journal_type_definitions journal_type
    JOIN fiscal_periods period
      ON period.organization_id = selected_entry.organization_id
     AND period.ledger_id = selected_entry.ledger_id
     AND period.id = selected_entry.period_id
    WHERE journal_type.id = selected_entry.journal_type_definition_id
      AND journal_type.key = selected_entry.journal_type_key
      AND journal_type.version = selected_entry.journal_type_version;
  END IF;
  IF selected_entry.id IS NULL OR selected_owner_module <> 'ledger'
    OR selected_entry.journal_type_key <> 'ledger.manual'
    OR selected_entry.source_document_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only source-free manual general-ledger journals can be administered'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_transaction_controls control
    WHERE control.organization_id = selected_authorization.organization_id
      AND control.journal_entry_id = selected_entry.id
      AND control.outcome = 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Journal is already deleted' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_entry_relations relation
    WHERE relation.organization_id = selected_authorization.organization_id
      AND (relation.from_journal_id = selected_entry.id OR relation.to_journal_id = selected_entry.id)
  ) OR EXISTS (
    SELECT 1 FROM bank_match_allocations allocation
    JOIN journal_lines line
      ON line.organization_id = allocation.organization_id
     AND line.id = allocation.journal_line_id
    WHERE line.organization_id = selected_authorization.organization_id
      AND line.journal_entry_id = selected_entry.id
  ) OR EXISTS (
    SELECT 1 FROM journal_lines line
    WHERE line.organization_id = selected_authorization.organization_id
      AND line.journal_entry_id = selected_entry.id
      AND (line.party_account_id IS NOT NULL
        OR line.subledger_event_id IS NOT NULL
        OR line.tax_snapshot_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Journal has a reversal, reconciliation, subledger, party, or tax dependency'
      USING ERRCODE = '55000';
  END IF;

  IF selected_action = 'UNPOST' THEN
    IF selected_entry.status <> 'POSTED' THEN
      RAISE EXCEPTION 'Only a posted journal can be unposted' USING ERRCODE = '55000';
    END IF;
    IF selected_period_state <> 'OPEN' THEN
      RAISE EXCEPTION 'A journal can be unposted only while its accounting period is open'
        USING ERRCODE = '55000';
    END IF;
    PERFORM set_config('app.journal_control_action', 'UNPOST:' || selected_entry.id::text, true);
    UPDATE journal_entries entry SET
      status = 'DRAFT', journal_number = NULL,
      total_debit_functional = 0, total_credit_functional = 0,
      content_hash = NULL, approval_version = NULL,
      approved_by = NULL, approved_at = NULL,
      posted_by = NULL, posted_at = NULL
    WHERE entry.organization_id = selected_authorization.organization_id
      AND entry.id = selected_entry.id AND entry.status = 'POSTED';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Journal changed during unposting' USING ERRCODE = '40001';
    END IF;
  ELSE
    IF selected_entry.status IN ('POSTED', 'REVERSED') THEN
      RAISE EXCEPTION 'Posted journals must be unposted before deletion'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  INSERT INTO journal_transaction_controls(
    organization_id, journal_entry_id, action, previous_status,
    previous_journal_number, outcome, reason, actor_id, session_id,
    request_id, idempotency_key, command_hash
  ) VALUES (
    selected_authorization.organization_id, selected_entry.id, selected_action,
    selected_entry.status, selected_entry.journal_number,
    CASE selected_action WHEN 'UNPOST' THEN 'UNPOSTED' ELSE 'DELETED' END,
    selected_reason, selected_authorization.actor_id, selected_authorization.session_id,
    selected_request_id, selected_idempotency_key, selected_command_hash
  );

  selected_audit_metadata := jsonb_build_object(
    'journalId', selected_entry.id,
    'sessionId', selected_authorization.session_id,
    'previousStatus', selected_entry.status,
    'previousJournalNumber', selected_entry.journal_number,
    'outcome', CASE selected_action WHEN 'UNPOST' THEN 'UNPOSTED' ELSE 'DELETED' END
  );
  PERFORM app.append_tenant_business_audit(
    selected_authorization.organization_id,
    'journal.' || lower(selected_action),
    'journal_entry',
    selected_entry.id::text,
    selected_audit_metadata,
    'ledger.journal-' || lower(selected_action)
  );

  RETURN QUERY SELECT selected_entry.id,
    CASE selected_action WHEN 'UNPOST' THEN 'DRAFT' ELSE 'DELETED' END,
    NULL::integer, false;
END
$$;
REVOKE ALL ON FUNCTION app.admin_control_journal_transaction(text, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint

DO $journal_admin_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON journal_transaction_controls FROM business_finlynq_app;
    GRANT SELECT ON journal_transaction_controls TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.admin_control_journal_transaction(text, uuid, text, text)
      TO business_finlynq_app;
  END IF;
END
$journal_admin_grants$;

COMMENT ON TABLE journal_transaction_controls IS
  'Append-only owner/admin journal control log and user-visible deletion tombstone; original journal evidence is never removed.';
COMMENT ON FUNCTION app.admin_control_journal_transaction(text, uuid, text, text) IS
  'Requires a live real MFA session and ledger.journal.administer permission; safely unposts or tombstones dependency-free manual journals with idempotent audit.';
