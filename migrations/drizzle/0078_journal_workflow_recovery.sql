-- Register the workflow audit/outbox pairs before enabling their producer.
INSERT INTO public.audit_outbox_pair_contract(audit_action, outbox_topic, aggregate_type, contract_version)
VALUES
  ('journal.workflow.submit', 'ledger.journal-submit', 'journal_entry', 'business-audit-outbox-v1'),
  ('journal.workflow.withdraw', 'ledger.journal-withdraw', 'journal_entry', 'business-audit-outbox-v1'),
  ('journal.workflow.reject', 'ledger.journal-reject', 'journal_entry', 'business-audit-outbox-v1');
--> statement-breakpoint

-- Keep existing posting, administrative, line-immutability, and audit guards.
-- This final BEFORE trigger adds version-preserving workflow transitions and
-- an audited recovery path; it cannot unpost or delete a journal.
CREATE FUNCTION app.guard_journal_workflow_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  command jsonb;
  action_name text;
  selected_reason text;
  selected_period fiscal_periods%ROWTYPE;
  highest_version integer;
  canonical_hash text;
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED'
    OR OLD.status = 'SUBMITTED' AND NEW.status IN ('APPROVED', 'DRAFT') THEN
    SELECT * INTO selected_period FROM fiscal_periods period
    WHERE period.organization_id = OLD.organization_id AND period.ledger_id = OLD.ledger_id
      AND period.id = OLD.period_id FOR SHARE;
    IF selected_period.id IS NULL OR selected_period.state IN ('HARD_CLOSED', 'SEALED')
      OR (selected_period.state = 'ADJUSTMENT_ONLY'
        AND OLD.purpose NOT IN ('ADJUSTING', 'REVERSAL', 'CLOSING', 'REVALUATION', 'TAX_ADJUSTMENT')) THEN
      RAISE EXCEPTION 'Journal workflow requires an eligible accounting period' USING ERRCODE = '55000';
    END IF;
  END IF;

  IF OLD.status IN ('SUBMITTED', 'APPROVED') AND NEW.status IN ('APPROVED', 'POSTED') THEN
    canonical_hash := app.compute_journal_content_hash(OLD.id);
    IF NEW.approval_version IS DISTINCT FROM OLD.approval_version OR OLD.approval_version IS NULL
      OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
      OR OLD.content_hash IS DISTINCT FROM canonical_hash THEN
      RAISE EXCEPTION 'Journal workflow must preserve the exact frozen version and content' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'APPROVED' AND (NEW.approved_by IS DISTINCT FROM app.current_actor_id()
      OR OLD.created_by IS NOT DISTINCT FROM app.current_actor_id()) THEN
      RAISE EXCEPTION 'Maker-checker requires an independent authenticated approver' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM journal_approvals approval
      WHERE approval.organization_id = OLD.organization_id AND approval.journal_entry_id = OLD.id
        AND approval.journal_version = OLD.approval_version AND approval.content_hash = OLD.content_hash
        AND approval.decision = 'APPROVED' AND approval.actor_id IS DISTINCT FROM OLD.created_by
        AND (NEW.status = 'POSTED' OR approval.actor_id = NEW.approved_by)) THEN
      RAISE EXCEPTION 'An independent approval for the exact frozen version is required' USING ERRCODE = '55000';
    END IF;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED' THEN
    -- The original guard counts approval decisions only. A withdrawn version
    -- also consumed its number, even when its content is unchanged on resubmit.
    SELECT coalesce(max((event.safe_metadata->>'approvalVersion')::integer), 0)
      INTO highest_version FROM audit_events event
    WHERE event.organization_id = OLD.organization_id AND event.entity_type = 'journal_entry'
      AND event.entity_id = OLD.id::text
      AND event.action IN ('journal.workflow.submit', 'journal.workflow.withdraw', 'journal.workflow.reject');
    NEW.approval_version := greatest(NEW.approval_version, highest_version + 1);
    PERFORM app.append_tenant_business_audit(OLD.organization_id, 'journal.workflow.submit',
      'journal_entry', OLD.id::text, jsonb_build_object(
        'previousStatus', OLD.status, 'status', NEW.status, 'contentHash', NEW.content_hash,
        'approvalVersion', NEW.approval_version, 'sessionId', nullif(current_setting('app.session_id', true), '')
      ), 'ledger.journal-submit');
  END IF;

  IF OLD.status = 'APPROVED' AND NEW.status = 'DRAFT' THEN
    RAISE EXCEPTION 'Approved journals cannot be withdrawn or rejected' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'SUBMITTED' OR NEW.status <> 'DRAFT' THEN RETURN NEW; END IF;

  command := nullif(current_setting('app.journal_workflow_command', true), '')::jsonb;
  action_name := command->>'action';
  selected_reason := nullif(current_setting('app.reason', true), '');
  IF command IS NULL OR action_name IS NULL OR action_name NOT IN ('withdraw', 'reject')
    OR selected_reason IS NULL OR length(btrim(selected_reason)) NOT BETWEEN 5 AND 500
    OR selected_reason ~ '[[:cntrl:]]'
    OR coalesce(command->>'idempotencyKey', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR coalesce(command->>'commandHash', '') !~ '^[0-9a-f]{64}$'
    OR nullif(current_setting('app.request_id', true), '') IS NULL THEN
    RAISE EXCEPTION 'Recovery requires an explicit reason, idempotency key, and audit context' USING ERRCODE = '22023';
  END IF;
  IF command->>'expectedContentHash' IS DISTINCT FROM OLD.content_hash
    OR (command->>'expectedApprovalVersion')::integer IS DISTINCT FROM OLD.approval_version
    OR OLD.approval_version IS NULL
    OR OLD.content_hash IS DISTINCT FROM app.compute_journal_content_hash(OLD.id) THEN
    RAISE EXCEPTION 'Recovery must match the exact frozen journal version and content' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','content_hash','approval_version','approved_by','approved_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','content_hash','approval_version','approved_by','approved_at']) THEN
    RAISE EXCEPTION 'Recovery cannot change journal content or source linkage' USING ERRCODE = '55000';
  END IF;
  IF OLD.source_document_id IS NOT NULL OR OLD.journal_type_key <> 'ledger.manual'
    OR NOT EXISTS (SELECT 1 FROM journal_type_definitions type WHERE type.id = OLD.journal_type_definition_id
      AND type.key = OLD.journal_type_key AND type.version = OLD.journal_type_version AND type.owner_module = 'ledger')
    OR EXISTS (SELECT 1 FROM journal_entry_relations relation WHERE relation.organization_id = OLD.organization_id
      AND (relation.from_journal_id = OLD.id OR relation.to_journal_id = OLD.id))
    OR EXISTS (SELECT 1 FROM journal_lines line WHERE line.organization_id = OLD.organization_id AND line.journal_entry_id = OLD.id
      AND (line.party_account_id IS NOT NULL OR line.subledger_event_id IS NOT NULL OR line.tax_snapshot_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM bank_match_allocations allocation WHERE allocation.organization_id = line.organization_id AND allocation.journal_line_id = line.id))) THEN
    RAISE EXCEPTION 'Recovery is unavailable for journals with accounting dependencies' USING ERRCODE = '55000';
  END IF;
  IF action_name = 'withdraw' THEN
    IF OLD.created_by IS DISTINCT FROM app.current_actor_id()
      OR NOT app.current_actor_has_permission('ledger.journal.submit') THEN
      RAISE EXCEPTION 'Withdrawal requires the creator and submission permission' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF OLD.created_by IS NOT DISTINCT FROM app.current_actor_id()
      OR NOT app.current_actor_has_permission('ledger.journal.approve') THEN
      RAISE EXCEPTION 'Rejection requires an independent approver' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM journal_approvals approval
      WHERE approval.organization_id = OLD.organization_id AND approval.journal_entry_id = OLD.id
        AND approval.journal_version = OLD.approval_version AND approval.content_hash = OLD.content_hash
        AND approval.decision = 'REJECTED' AND approval.actor_id = app.current_actor_id()) THEN
      RAISE EXCEPTION 'Rejection requires an immutable decision for the frozen journal' USING ERRCODE = '55000';
    END IF;
  END IF;
  -- The service serializes this key before the journal row lock; this check also
  -- prevents direct SQL from reusing a completed command to recover a new version.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'journal-workflow:' || OLD.organization_id::text || ':' || (command->>'idempotencyKey'), 0));
  IF EXISTS (SELECT 1 FROM audit_events event WHERE event.organization_id = OLD.organization_id
    AND event.action IN ('journal.workflow.withdraw', 'journal.workflow.reject')
    AND event.safe_metadata->>'idempotencyKey' = command->>'idempotencyKey') THEN
    RAISE EXCEPTION 'Journal recovery idempotency key was already consumed' USING ERRCODE = '23505';
  END IF;
  PERFORM app.append_tenant_business_audit(OLD.organization_id, 'journal.workflow.' || action_name,
    'journal_entry', OLD.id::text, jsonb_build_object(
      'previousStatus', OLD.status, 'status', NEW.status, 'contentHash', OLD.content_hash,
      'approvalVersion', OLD.approval_version, 'idempotencyKey', command->>'idempotencyKey',
      'commandHash', command->>'commandHash', 'sessionId', nullif(current_setting('app.session_id', true), '')
    ), 'ledger.journal-' || action_name);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_journal_workflow_transition() FROM PUBLIC;
CREATE TRIGGER journal_entries_workflow_guard
  BEFORE UPDATE OF status ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_workflow_transition();
--> statement-breakpoint

-- Decisions remain immutable and version-bound under the existing insert
-- validator; additionally enforce independent actors at the database boundary.
CREATE FUNCTION app.guard_independent_journal_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries entry WHERE entry.organization_id = NEW.organization_id
    AND entry.id = NEW.journal_entry_id AND entry.created_by = NEW.actor_id) THEN
    RAISE EXCEPTION 'Maker-checker requires an independent journal reviewer' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_independent_journal_decision() FROM PUBLIC;
CREATE TRIGGER journal_approvals_independent_actor
  BEFORE INSERT ON journal_approvals
  FOR EACH ROW EXECUTE FUNCTION app.guard_independent_journal_decision();
--> statement-breakpoint

-- Runtime has no general audit_events read access. Reveal only whether this
-- actor's exact command already completed, never the underlying audit row.
CREATE FUNCTION app.journal_workflow_recovery_replayed(
  selected_journal_id uuid, selected_action text, selected_idempotency_key text, selected_command_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  selected_organization_id uuid := app.current_organization_id();
  selected_actor_id uuid := app.current_actor_id();
  receipt record;
BEGIN
  IF selected_journal_id IS NULL OR selected_action IS NULL OR selected_action NOT IN ('withdraw', 'reject')
    OR selected_idempotency_key IS NULL OR selected_idempotency_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR selected_command_hash IS NULL OR selected_command_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid journal recovery replay request' USING ERRCODE = '22023';
  END IF;
  IF selected_organization_id IS NULL OR selected_actor_id IS NULL
    OR NOT app.current_actor_has_permission(CASE selected_action WHEN 'reject' THEN 'ledger.journal.approve' ELSE 'ledger.journal.submit' END)
    OR NOT EXISTS (SELECT 1 FROM journal_entries entry
      WHERE entry.organization_id = selected_organization_id AND entry.id = selected_journal_id) THEN
    RAISE EXCEPTION 'Journal recovery replay requires an authorized tenant actor' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'journal-workflow:' || selected_organization_id::text || ':' || selected_idempotency_key, 0));
  SELECT event.entity_id, event.actor_id, event.action, event.safe_metadata->>'commandHash' AS command_hash INTO receipt
  FROM audit_events event
  WHERE event.organization_id = selected_organization_id
    AND event.action IN ('journal.workflow.withdraw', 'journal.workflow.reject')
    AND event.safe_metadata->>'idempotencyKey' = selected_idempotency_key;
  IF NOT FOUND THEN RETURN false; END IF;
  IF receipt.entity_id IS DISTINCT FROM selected_journal_id::text
    OR receipt.actor_id IS DISTINCT FROM selected_actor_id::text
    OR receipt.action IS DISTINCT FROM 'journal.workflow.' || selected_action
    OR receipt.command_hash IS DISTINCT FROM selected_command_hash THEN
    RAISE EXCEPTION 'Journal recovery idempotency key was reused for a different command' USING ERRCODE = '23505';
  END IF;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.journal_workflow_recovery_replayed(uuid, text, text, text) FROM PUBLIC;
DO $runtime_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT EXECUTE ON FUNCTION app.journal_workflow_recovery_replayed(uuid, text, text, text) TO business_finlynq_app;
  END IF;
END
$runtime_grant$;
