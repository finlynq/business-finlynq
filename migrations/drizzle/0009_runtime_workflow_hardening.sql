-- Application roles may deactivate party master data, but cannot erase its
-- encrypted history. An owner-operated purge is deliberately outside the
-- application release boundary.
CREATE OR REPLACE FUNCTION app.guard_tenant_party_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_organization_id uuid;
BEGIN
  target_organization_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF nullif(current_setting('app.organization_id', true), '') IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Party history cannot be hard-deleted by the application; deactivate it instead'
        USING ERRCODE = '42501';
    END IF;
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
--> statement-breakpoint

-- Never trust a caller-provided authentication label for privileged period
-- changes. The transaction must carry a live REAL session that belongs to the
-- same organization and actor and whose server-recorded step-up window remains
-- current. SECURITY DEFINER is required because the runtime role intentionally
-- has no direct auth_sessions access.
CREATE OR REPLACE FUNCTION app.guard_period_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor uuid;
  reason text;
  selected_session_id uuid;
  session_setting text;
  requires_step_up boolean := false;
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

  IF (OLD.state = 'HARD_CLOSED' AND NEW.state IN ('OPEN', 'ADJUSTMENT_ONLY'))
    OR (OLD.state = 'ADJUSTMENT_ONLY' AND NEW.state = 'OPEN') THEN
    IF NOT app.current_actor_has_permission('ledger.period.reopen') THEN
      RAISE EXCEPTION 'Period reopening permission is required'
        USING ERRCODE = '42501';
    END IF;
    requires_step_up := true;
  ELSIF OLD.state = 'HARD_CLOSED' AND NEW.state = 'SEALED' THEN
    IF NOT app.current_actor_has_permission('ledger.period.seal') THEN
      RAISE EXCEPTION 'Period sealing permission is required'
        USING ERRCODE = '42501';
    END IF;
    requires_step_up := true;
  ELSIF NOT app.current_actor_has_permission('ledger.period.close') THEN
    RAISE EXCEPTION 'Period close permission is required'
      USING ERRCODE = '42501';
  END IF;

  IF requires_step_up THEN
    session_setting := nullif(current_setting('app.session_id', true), '');
    IF session_setting IS NULL THEN
      RAISE EXCEPTION 'Period reopening or sealing requires a live stepped-up session'
        USING ERRCODE = '28000';
    END IF;
    BEGIN
      selected_session_id := session_setting::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Period reopening or sealing requires a live stepped-up session'
        USING ERRCODE = '28000';
    END;
    IF NOT EXISTS (
      SELECT 1
      FROM auth_sessions selected_session
      JOIN organization_memberships membership
        ON membership.id = selected_session.membership_id
       AND membership.organization_id = selected_session.organization_id
       AND membership.user_id = selected_session.user_id
       AND membership.active
      WHERE selected_session.id = selected_session_id
        AND selected_session.organization_id = OLD.organization_id
        AND selected_session.user_id = actor
        AND selected_session.session_mode = 'REAL'
        AND selected_session.revoked_at IS NULL
        AND selected_session.expires_at > now()
        AND selected_session.idle_expires_at > now()
        AND selected_session.step_up_expires_at > now()
    ) THEN
      RAISE EXCEPTION 'Period reopening or sealing requires a live stepped-up session'
        USING ERRCODE = '28000';
    END IF;
  END IF;

  NEW.version := OLD.version + 1;
  NEW.closed_at := CASE WHEN NEW.state IN ('HARD_CLOSED', 'SEALED') THEN now() ELSE NULL END;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE DELETE ON ledger_posting_policies, parties, party_addresses FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_tenant_party_write(), app.guard_period_transition()
  FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE DELETE ON ledger_posting_policies, parties, party_addresses
      FROM business_finlynq_app;
    REVOKE EXECUTE ON FUNCTION app.guard_tenant_party_write(), app.guard_period_transition()
      FROM business_finlynq_app;
  END IF;
END
$$;
