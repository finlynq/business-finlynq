-- Custom SQL migration file, put your code below! --
ALTER TABLE mcp_agent_self_approval_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_agent_self_approval_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_agent_self_approval_policy
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
REVOKE ALL ON mcp_agent_self_approval_policy FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION app.mcp_agent_self_approval_allowed(selected_organization_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE selected_connection_id uuid;
BEGIN
  IF selected_organization_id IS DISTINCT FROM app.current_organization_id()
    OR current_setting('app.source_surface', true) IS DISTINCT FROM 'MCP'
    OR current_setting('app.session_mode', true) IS DISTINCT FROM 'real'
    OR app.current_actor_id() IS NULL THEN
    RETURN false;
  END IF;
  BEGIN
    selected_connection_id := nullif(current_setting('app.session_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RETURN false;
  END;
  IF selected_connection_id IS NULL THEN RETURN false; END IF;
  -- The shared row lock makes owner revocation wait for an in-flight approval.
  RETURN EXISTS (
    SELECT 1 FROM mcp_agent_self_approval_policy policy
    JOIN mcp_connections connection
      ON connection.organization_id = policy.organization_id
     AND connection.id = selected_connection_id
     AND connection.user_id = app.current_actor_id()
     AND connection.revoked_at IS NULL
    JOIN organizations organization
      ON organization.id = policy.organization_id
     AND organization.active AND NOT organization.is_demo
    WHERE policy.organization_id = selected_organization_id
      AND policy.enabled
    FOR SHARE OF policy
  );
END $$;
REVOKE ALL ON FUNCTION app.mcp_agent_self_approval_allowed(uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION app.set_mcp_agent_self_approval(selected_enabled boolean, expected_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  selected_organization_id uuid := app.current_organization_id();
  selected_actor_id uuid := app.current_actor_id();
  selected_session_id uuid;
  current_policy mcp_agent_self_approval_policy%ROWTYPE;
  saved_policy mcp_agent_self_approval_policy%ROWTYPE;
BEGIN
  IF selected_organization_id IS NULL OR selected_actor_id IS NULL
    OR selected_enabled IS NULL OR expected_version IS NULL OR expected_version < 0
    OR current_setting('app.source_surface', true) IS DISTINCT FROM 'UI'
    OR current_setting('app.session_mode', true) IS DISTINCT FROM 'real'
    OR NOT EXISTS (
      SELECT 1 FROM organizations organization
      JOIN organization_memberships membership
        ON membership.organization_id = organization.id
       AND membership.user_id = selected_actor_id AND membership.active
      JOIN membership_roles membership_role
        ON membership_role.organization_id = membership.organization_id
       AND membership_role.membership_id = membership.id
      JOIN roles role
        ON role.organization_id = membership_role.organization_id
       AND role.id = membership_role.role_id
       AND role.active AND role.key = 'OWNER'
      WHERE organization.id = selected_organization_id
        AND organization.active AND NOT organization.is_demo
    ) THEN
    RAISE EXCEPTION 'An active organization owner must change agent approval policy'
      USING ERRCODE = '42501';
  END IF;
  BEGIN
    selected_session_id := nullif(current_setting('app.session_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'A live owner session is required' USING ERRCODE = '42501';
  END;
  IF selected_session_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM auth_sessions session
    WHERE session.id = selected_session_id AND session.user_id = selected_actor_id
      AND session.organization_id = selected_organization_id
      AND session.session_mode = 'REAL' AND session.revoked_at IS NULL
      AND session.expires_at > now()
      AND (NOT selected_enabled OR session.step_up_expires_at > now())
  ) THEN
    RAISE EXCEPTION 'Enabling agent self-approval requires a recent owner MFA step-up'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO current_policy FROM mcp_agent_self_approval_policy
    WHERE organization_id = selected_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    IF expected_version <> 0 THEN RAISE EXCEPTION 'Agent approval policy changed; reload before retrying' USING ERRCODE = '40001'; END IF;
    IF NOT selected_enabled THEN
      RETURN jsonb_build_object('enabled',false,'version',0,'enabledBy',NULL,'enabledAt',NULL);
    END IF;
    INSERT INTO mcp_agent_self_approval_policy
      (organization_id,enabled,version,enabled_by,enabled_at,changed_by)
      VALUES (selected_organization_id,true,1,selected_actor_id,now(),selected_actor_id)
      RETURNING * INTO saved_policy;
  ELSE
    IF current_policy.version <> expected_version THEN
      RAISE EXCEPTION 'Agent approval policy changed; reload before retrying' USING ERRCODE = '40001';
    END IF;
    IF current_policy.enabled = selected_enabled THEN
      RETURN jsonb_build_object('enabled',current_policy.enabled,'version',current_policy.version,
        'enabledBy',current_policy.enabled_by,'enabledAt',current_policy.enabled_at);
    END IF;
    UPDATE mcp_agent_self_approval_policy
       SET enabled = selected_enabled, version = version + 1,
         enabled_by = CASE WHEN selected_enabled THEN selected_actor_id ELSE enabled_by END,
         enabled_at = CASE WHEN selected_enabled THEN now() ELSE enabled_at END,
         changed_by = selected_actor_id, changed_at = now()
     WHERE organization_id = selected_organization_id RETURNING * INTO saved_policy;
  END IF;
  PERFORM app.append_tenant_business_audit(selected_organization_id,
    CASE WHEN selected_enabled THEN 'mcp.agent-self-approval.enabled' ELSE 'mcp.agent-self-approval.revoked' END,
    'organization', selected_organization_id::text,
    jsonb_build_object('enabled',saved_policy.enabled,'version',saved_policy.version,
      'enabledBy',saved_policy.enabled_by,'scope','ALL_MCP_CONNECTIONS'), NULL);
  RETURN jsonb_build_object('enabled',saved_policy.enabled,'version',saved_policy.version,
    'enabledBy',saved_policy.enabled_by,'enabledAt',saved_policy.enabled_at);
END $$;
REVOKE ALL ON FUNCTION app.set_mcp_agent_self_approval(boolean,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_independent_journal_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The connection provenance is set only by this trigger, never by callers.
  NEW.mcp_self_approval_connection_id := NULL;
  IF EXISTS (SELECT 1 FROM journal_entries entry
    WHERE entry.organization_id = NEW.organization_id
      AND entry.id = NEW.journal_entry_id AND entry.created_by = NEW.actor_id) THEN
    IF NEW.decision <> 'APPROVED'
      OR NOT app.mcp_agent_self_approval_allowed(NEW.organization_id) THEN
      RAISE EXCEPTION 'Maker-checker requires an independent journal reviewer'
        USING ERRCODE = '42501';
    END IF;
    NEW.mcp_self_approval_connection_id := nullif(current_setting('app.session_id', true), '')::uuid;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_independent_journal_decision() FROM PUBLIC;
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT SELECT ON mcp_agent_self_approval_policy TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.mcp_agent_self_approval_allowed(uuid) TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.set_mcp_agent_self_approval(boolean,integer) TO business_finlynq_app;
  END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_journal_workflow_transition()
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
      OR (OLD.created_by IS NOT DISTINCT FROM app.current_actor_id()
        AND NOT app.mcp_agent_self_approval_allowed(OLD.organization_id))) THEN
      RAISE EXCEPTION 'Maker-checker requires an independent authenticated approver' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM journal_approvals approval
      WHERE approval.organization_id = OLD.organization_id AND approval.journal_entry_id = OLD.id
        AND approval.journal_version = OLD.approval_version AND approval.content_hash = OLD.content_hash
        AND approval.decision = 'APPROVED' AND (approval.actor_id IS DISTINCT FROM OLD.created_by
          OR approval.mcp_self_approval_connection_id IS NOT NULL)
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
