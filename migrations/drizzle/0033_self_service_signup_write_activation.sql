-- A completed self-service signup owns an isolated REAL organization and an
-- active owner membership. Enable that organization's accounting writes as
-- part of the same transaction while retaining the deployment-wide emergency
-- gate and the audited per-organization disable path.

CREATE OR REPLACE FUNCTION app.enable_completed_self_service_signup_writes(
  selected_signup_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  selected_signup record;
  selected_organization record;
  transition_at timestamp with time zone;
  previous_organization_id text;
  previous_actor_id text;
  previous_request_id text;
  previous_auth_method text;
  previous_source_surface text;
  previous_reason text;
BEGIN
  IF selected_signup_id IS NULL THEN
    RAISE EXCEPTION 'Self-service signup activation target is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT signup.organization_id, signup.user_id
    INTO selected_signup
  FROM public.auth_organization_signups signup
  JOIN public.users selected_user
    ON selected_user.id = signup.user_id
   AND selected_user.active
   AND NOT selected_user.is_demo
  JOIN public.organization_memberships membership
    ON membership.organization_id = signup.organization_id
   AND membership.user_id = signup.user_id
   AND membership.active
  JOIN public.membership_roles membership_role
    ON membership_role.organization_id = membership.organization_id
   AND membership_role.membership_id = membership.id
  JOIN public.roles role
    ON role.organization_id = membership_role.organization_id
   AND role.id = membership_role.role_id
   AND role.key = 'OWNER'
   AND role.active
  WHERE signup.id = selected_signup_id
    AND signup.status = 'ACTIVE'
    AND signup.completed_at IS NOT NULL
  FOR UPDATE OF signup;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a completed owner signup can activate organization writes'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'business-finlynq:organization-write-activation:' || selected_signup.organization_id::text,
      0
    )
  );

  SELECT organization.active, organization.is_demo,
         organization.organization_mode, organization.writes_enabled_at,
         organization.updated_at
    INTO selected_organization
  FROM public.organizations organization
  WHERE organization.id = selected_signup.organization_id
  FOR UPDATE;

  IF NOT FOUND
    OR NOT selected_organization.active
    OR selected_organization.is_demo
    OR selected_organization.organization_mode <> 'REAL' THEN
    RAISE EXCEPTION 'Completed signup organization is not an active REAL organization'
      USING ERRCODE = '55000';
  END IF;

  IF selected_organization.writes_enabled_at IS NOT NULL THEN
    RETURN false;
  END IF;

  -- An explicit audited disable always wins over automatic signup policy. This
  -- keeps incident response durable across application releases and backfills.
  IF EXISTS (
    SELECT 1
    FROM public.audit_events audit
    WHERE audit.organization_id = selected_signup.organization_id
      AND audit.action = 'organization.writes-disabled'
  ) THEN
    RETURN false;
  END IF;

  previous_organization_id := current_setting('app.organization_id', true);
  previous_actor_id := current_setting('app.actor_id', true);
  previous_request_id := current_setting('app.request_id', true);
  previous_auth_method := current_setting('app.auth_method', true);
  previous_source_surface := current_setting('app.source_surface', true);
  previous_reason := current_setting('app.reason', true);

  PERFORM set_config('app.organization_id', selected_signup.organization_id::text, true);
  PERFORM set_config('app.actor_id', 'system:self-service-signup', true);
  PERFORM set_config('app.request_id', selected_signup_id::text, true);
  PERFORM set_config('app.auth_method', 'verified-owner-signup', true);
  PERFORM set_config('app.source_surface', 'SIGNUP', true);
  PERFORM set_config(
    'app.reason',
    'Automatic activation after completed self-service signup',
    true
  );

  BEGIN
    transition_at := greatest(
      clock_timestamp(),
      selected_organization.updated_at + interval '1 microsecond'
    );

    UPDATE public.organizations organization
    SET writes_enabled_at = transition_at,
        updated_at = transition_at
    WHERE organization.id = selected_signup.organization_id;

    PERFORM app.append_tenant_business_audit(
      selected_signup.organization_id,
      'organization.writes-enabled',
      'organization',
      selected_signup.organization_id::text,
      jsonb_build_object(
        'writeEnabled', true,
        'transitionedAt', transition_at,
        'previousWritesEnabledAt', selected_organization.writes_enabled_at,
        'activationPolicy', 'SELF_SERVICE_SIGNUP'
      ),
      'organization.writes-enabled'
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.organization_id', coalesce(previous_organization_id, ''), true);
    PERFORM set_config('app.actor_id', coalesce(previous_actor_id, ''), true);
    PERFORM set_config('app.request_id', coalesce(previous_request_id, ''), true);
    PERFORM set_config('app.auth_method', coalesce(previous_auth_method, ''), true);
    PERFORM set_config('app.source_surface', coalesce(previous_source_surface, ''), true);
    PERFORM set_config('app.reason', coalesce(previous_reason, ''), true);
    RAISE;
  END;

  PERFORM set_config('app.organization_id', coalesce(previous_organization_id, ''), true);
  PERFORM set_config('app.actor_id', coalesce(previous_actor_id, ''), true);
  PERFORM set_config('app.request_id', coalesce(previous_request_id, ''), true);
  PERFORM set_config('app.auth_method', coalesce(previous_auth_method, ''), true);
  PERFORM set_config('app.source_surface', coalesce(previous_source_surface, ''), true);
  PERFORM set_config('app.reason', coalesce(previous_reason, ''), true);
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.enable_completed_self_service_signup_writes(uuid)
  FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.activate_completed_self_service_signup_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'ENROLLING' AND NEW.status = 'ACTIVE' THEN
    PERFORM app.enable_completed_self_service_signup_writes(NEW.id);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.activate_completed_self_service_signup_writes()
  FROM PUBLIC;
CREATE TRIGGER organization_signup_activates_writes
  AFTER UPDATE OF status ON public.auth_organization_signups
  FOR EACH ROW EXECUTE FUNCTION app.activate_completed_self_service_signup_writes();
--> statement-breakpoint

-- Forward-only reconciliation for already-completed self-service signups. The
-- helper is idempotent and preserves any organization with an audited disable.
DO $$
DECLARE
  selected_signup_id uuid;
BEGIN
  FOR selected_signup_id IN
    SELECT signup.id
    FROM public.auth_organization_signups signup
    JOIN public.organizations organization
      ON organization.id = signup.organization_id
    WHERE signup.status = 'ACTIVE'
      AND signup.completed_at IS NOT NULL
      AND organization.active
      AND NOT organization.is_demo
      AND organization.organization_mode = 'REAL'
      AND organization.writes_enabled_at IS NULL
    ORDER BY signup.id
  LOOP
    PERFORM app.enable_completed_self_service_signup_writes(selected_signup_id);
  END LOOP;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON FUNCTION app.enable_completed_self_service_signup_writes(uuid),
      app.activate_completed_self_service_signup_writes()
      FROM business_finlynq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_auth_worker') THEN
    REVOKE ALL ON FUNCTION app.enable_completed_self_service_signup_writes(uuid),
      app.activate_completed_self_service_signup_writes()
      FROM business_finlynq_auth_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_backup') THEN
    REVOKE ALL ON FUNCTION app.enable_completed_self_service_signup_writes(uuid),
      app.activate_completed_self_service_signup_writes()
      FROM business_finlynq_backup;
  END IF;
END
$$;
