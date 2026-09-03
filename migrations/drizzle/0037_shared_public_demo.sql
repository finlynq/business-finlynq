-- Replace the finite browser-owned sandbox pool with one shared, writable
-- PUBLIC_DEMO organization. Legacy pool/claim rows remain owner-only for a
-- one-release rollback window, but no current authentication or reset path
-- allocates them.
CREATE TABLE shared_demo_reset_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  status text NOT NULL DEFAULT 'RESETTING'
    CHECK (status IN ('READY', 'RESETTING', 'FAILED')),
  baseline_version integer NOT NULL DEFAULT 0 CHECK (baseline_version >= 0),
  reset_after timestamp with time zone NOT NULL,
  initialized_at timestamp with time zone NOT NULL DEFAULT now(),
  reset_started_at timestamp with time zone,
  last_completed_reset_at timestamp with time zone,
  last_error text CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 1000),
  CONSTRAINT shared_demo_reset_state_resetting_started_check
    CHECK ((status = 'RESETTING') = (reset_started_at IS NOT NULL)),
  CONSTRAINT shared_demo_reset_state_failed_error_check
    CHECK (status = 'FAILED' OR last_error IS NULL)
);
INSERT INTO shared_demo_reset_state(singleton, status, baseline_version, reset_after, reset_started_at)
VALUES (true, 'RESETTING', 0, now(), now());
ALTER TABLE shared_demo_reset_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_demo_reset_state FORCE ROW LEVEL SECURITY;
CREATE POLICY shared_demo_reset_state_owner_only_policy
ON shared_demo_reset_state
FOR ALL
USING (
  current_user = pg_get_userbyid((SELECT owner_relation.relowner
    FROM pg_class owner_relation
    WHERE owner_relation.oid = 'shared_demo_reset_state'::regclass))
)
WITH CHECK (
  current_user = pg_get_userbyid((SELECT owner_relation.relowner
    FROM pg_class owner_relation
    WHERE owner_relation.oid = 'shared_demo_reset_state'::regclass))
);
REVOKE ALL ON shared_demo_reset_state FROM PUBLIC;
--> statement-breakpoint

-- Every historical sandbox session is invalid before the new session
-- invariant is installed. The old synthetic tenants are retained but made
-- inactive so they cannot be selected by any legacy query during rollout.
UPDATE auth_sessions
SET revoked_at = coalesce(revoked_at, now())
WHERE session_mode = 'DEMO';
UPDATE demo_daily_claims
SET invalidated_at = coalesce(invalidated_at, now())
WHERE invalidated_at IS NULL;
UPDATE organizations
SET active = false, updated_at = now()
WHERE is_demo AND organization_mode = 'SANDBOX';
--> statement-breakpoint

-- Promote the fixed public identity from the old read-only viewer role to the
-- same in-application accounting permission surface used by demo accountants.
UPDATE organizations SET
  slug = 'northstar-demo',
  display_name = 'Northstar Demo Group',
  active = true,
  is_demo = true,
  organization_mode = 'PUBLIC_DEMO',
  updated_at = now()
WHERE id = '10000000-0000-4000-8000-000000000001'::uuid;
UPDATE users SET active = true, is_demo = true
WHERE id = '10000000-0000-4000-8000-000000000002'::uuid;
UPDATE organization_memberships SET active = true
WHERE id = '10000000-0000-4000-8000-000000000003'::uuid
  AND organization_id = '10000000-0000-4000-8000-000000000001'::uuid
  AND user_id = '10000000-0000-4000-8000-000000000002'::uuid;
UPDATE roles SET key = 'demo_accountant', display_name = 'Demo accountant',
  system_template = true, active = true
WHERE id = '10000000-0000-4000-8000-000000000004'::uuid
  AND organization_id = '10000000-0000-4000-8000-000000000001'::uuid;
DELETE FROM role_permissions
WHERE organization_id = '10000000-0000-4000-8000-000000000001'::uuid
  AND role_id = '10000000-0000-4000-8000-000000000004'::uuid;
INSERT INTO role_permissions(organization_id, role_id, permission_key)
SELECT
  '10000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000004'::uuid,
  permission.key
FROM permissions permission
WHERE permission.key <> 'organization.recovery.manage'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Shared demo sessions carry neither a slot generation nor a browser claim.
-- Revoked legacy rows remain valid historical evidence during the rollback
-- window; only live rows must satisfy the new shared-session shape.
DROP INDEX IF EXISTS auth_sessions_one_live_demo_per_org_unique;
ALTER TABLE auth_sessions DROP CONSTRAINT auth_sessions_demo_generation_check;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_demo_generation_check CHECK (
  (
    session_mode = 'DEMO' AND auth_method = 'DEMO_LINK'
    AND (
      revoked_at IS NOT NULL
      OR (demo_generation IS NULL AND demo_claim_id IS NULL)
    )
  )
  OR (
    session_mode = 'REAL' AND auth_method <> 'DEMO_LINK'
    AND demo_generation IS NULL AND demo_claim_id IS NULL
  )
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_auth_session_mode()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_is_demo boolean;
  selected_organization_mode text;
BEGIN
  SELECT is_demo INTO selected_user_is_demo FROM users WHERE id = NEW.user_id;
  SELECT organization_mode INTO selected_organization_mode
  FROM organizations WHERE id = NEW.organization_id;
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.id = NEW.membership_id
      AND membership.organization_id = NEW.organization_id
      AND membership.user_id = NEW.user_id AND membership.active
  ) THEN
    RAISE EXCEPTION 'Session principal does not match an active membership'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.session_mode = 'DEMO' THEN
    IF NEW.auth_method <> 'DEMO_LINK' OR NOT selected_user_is_demo
      OR selected_organization_mode <> 'PUBLIC_DEMO'
      OR NEW.demo_generation IS NOT NULL OR NEW.demo_claim_id IS NOT NULL THEN
      RAISE EXCEPTION 'Demo session principal is not the shared public demo principal'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.session_mode = 'REAL' THEN
    IF NEW.auth_method = 'DEMO_LINK' OR selected_user_is_demo
      OR selected_organization_mode <> 'REAL' OR NEW.demo_generation IS NOT NULL
      OR NEW.demo_claim_id IS NOT NULL THEN
      RAISE EXCEPTION 'Real session principal cannot reference demo identity or organization state'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported session mode' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_auth_session_mode() FROM PUBLIC;
--> statement-breakpoint

-- Keep the six-argument signature during the rollout so an old application
-- process can coexist with the migrated database. Claim arguments are accepted
-- only as unused, validated compatibility input and are never stored.
CREATE OR REPLACE FUNCTION app.auth_issue_demo_session(
  selected_token_hash text,
  selected_claim_token_hash text,
  replacement_claim_token_hash text,
  selected_ip_hash text,
  selected_user_agent_hash text,
  selected_request_id text
)
RETURNS TABLE(
  session_id uuid,
  user_id uuid,
  organization_id uuid,
  membership_id uuid,
  organization_name text,
  role_label text,
  claim_created boolean,
  claim_expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_state shared_demo_reset_state%ROWTYPE;
  selected_user_id uuid;
  selected_membership_id uuid;
  selected_role_label text;
  selected_organization_name text;
  created_session_id uuid;
BEGIN
  IF selected_token_hash !~ '^[0-9a-f]{64}$'
    OR (selected_claim_token_hash IS NOT NULL
      AND selected_claim_token_hash !~ '^[0-9a-f]{64}$')
    OR (replacement_claim_token_hash IS NOT NULL
      AND replacement_claim_token_hash !~ '^[0-9a-f]{64}$')
    OR selected_ip_hash !~ '^[0-9a-f]{64}$'
    OR (selected_user_agent_hash IS NOT NULL
      AND selected_user_agent_hash !~ '^[0-9a-f]{64}$')
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid demo session request' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('business-finlynq-shared-demo-reset', 0)
  );
  SELECT * INTO selected_state
  FROM shared_demo_reset_state
  WHERE singleton
  FOR SHARE;
  IF selected_state.singleton IS NULL
    OR selected_state.status <> 'READY'
    OR selected_state.reset_after <= now() THEN
    RETURN;
  END IF;

  SELECT membership.id, selected_user.id, organization.display_name,
    coalesce(string_agg(DISTINCT display_role.display_name, ', '
      ORDER BY display_role.display_name), 'Demo accountant')
  INTO selected_membership_id, selected_user_id,
    selected_organization_name, selected_role_label
  FROM organizations organization
  JOIN organization_memberships membership
    ON membership.organization_id = organization.id
   AND membership.active
  JOIN users selected_user
    ON selected_user.id = membership.user_id
   AND selected_user.active AND selected_user.is_demo
  JOIN membership_roles canonical_assignment
    ON canonical_assignment.organization_id = membership.organization_id
   AND canonical_assignment.membership_id = membership.id
  JOIN roles canonical_role
    ON canonical_role.organization_id = canonical_assignment.organization_id
   AND canonical_role.id = canonical_assignment.role_id
   AND canonical_role.key = 'demo_accountant' AND canonical_role.active
  LEFT JOIN membership_roles display_assignment
    ON display_assignment.organization_id = membership.organization_id
   AND display_assignment.membership_id = membership.id
  LEFT JOIN roles display_role
    ON display_role.organization_id = display_assignment.organization_id
   AND display_role.id = display_assignment.role_id AND display_role.active
  WHERE organization.id = '10000000-0000-4000-8000-000000000001'::uuid
    AND organization.active AND organization.is_demo
    AND organization.organization_mode = 'PUBLIC_DEMO'
    AND selected_user.id = '10000000-0000-4000-8000-000000000002'::uuid
  GROUP BY membership.id, selected_user.id, organization.display_name;
  IF selected_membership_id IS NULL THEN
    RAISE EXCEPTION 'Shared public demo has no canonical accountant membership'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO auth_sessions(
    token_hash, user_id, organization_id, membership_id, auth_method, session_mode,
    ip_hash, user_agent_hash, idle_timeout_seconds, idle_expires_at, expires_at,
    demo_generation, demo_claim_id
  ) VALUES (
    selected_token_hash, selected_user_id,
    '10000000-0000-4000-8000-000000000001'::uuid,
    selected_membership_id, 'DEMO_LINK', 'DEMO', selected_ip_hash,
    selected_user_agent_hash, 900,
    least(now() + interval '15 minutes', selected_state.reset_after),
    least(now() + interval '1 hour', selected_state.reset_after),
    NULL, NULL
  ) RETURNING id INTO created_session_id;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome, request_id,
    metadata
  ) VALUES (
    selected_user_id, '10000000-0000-4000-8000-000000000001'::uuid,
    created_session_id, 'LOGIN', 'SUCCESS', selected_request_id,
    jsonb_build_object('sharedDemo', true)
  );

  RETURN QUERY SELECT created_session_id, selected_user_id,
    '10000000-0000-4000-8000-000000000001'::uuid,
    selected_membership_id, selected_organization_name,
    selected_role_label, false, selected_state.reset_after;
END
$$;
REVOKE ALL ON FUNCTION app.auth_issue_demo_session(text, text, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_demo_session_lease_valid(selected_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth_sessions selected_session
    JOIN organizations organization
      ON organization.id = selected_session.organization_id
     AND organization.active AND organization.is_demo
     AND organization.organization_mode = 'PUBLIC_DEMO'
    JOIN users selected_user
      ON selected_user.id = selected_session.user_id
     AND selected_user.active AND selected_user.is_demo
    JOIN organization_memberships membership
      ON membership.id = selected_session.membership_id
     AND membership.organization_id = selected_session.organization_id
     AND membership.user_id = selected_session.user_id AND membership.active
    JOIN shared_demo_reset_state reset_state
      ON reset_state.singleton AND reset_state.status = 'READY'
     AND reset_state.reset_after > now()
    WHERE selected_session.id = selected_session_id
      AND selected_session.organization_id = '10000000-0000-4000-8000-000000000001'::uuid
      AND selected_session.user_id = '10000000-0000-4000-8000-000000000002'::uuid
      AND selected_session.session_mode = 'DEMO'
      AND selected_session.auth_method = 'DEMO_LINK'
      AND selected_session.demo_generation IS NULL
      AND selected_session.demo_claim_id IS NULL
      AND selected_session.revoked_at IS NULL
      AND selected_session.expires_at > now()
      AND selected_session.idle_expires_at > now()
  )
$$;
REVOKE ALL ON FUNCTION app.auth_demo_session_lease_valid(uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.assert_current_demo_session_lease()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_session_id uuid;
  selected_session auth_sessions%ROWTYPE;
  selected_state shared_demo_reset_state%ROWTYPE;
BEGIN
  IF coalesce(current_setting('app.session_mode', true), '') <> 'demo'
    OR coalesce(current_setting('app.auth_method', true), '')
      NOT IN ('demo-link', 'demo-link+mfa') THEN
    RAISE EXCEPTION 'Demo session transaction context is invalid'
      USING ERRCODE = '28000';
  END IF;
  BEGIN
    selected_session_id := nullif(current_setting('app.session_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Demo session transaction context is invalid'
      USING ERRCODE = '28000';
  END;
  IF selected_session_id IS NULL THEN
    RAISE EXCEPTION 'Demo session transaction context is invalid'
      USING ERRCODE = '28000';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('business-finlynq-shared-demo-reset', 0)
  );
  SELECT * INTO selected_session FROM auth_sessions
  WHERE id = selected_session_id FOR SHARE;
  IF selected_session.id IS NULL
    OR selected_session.organization_id IS DISTINCT FROM app.current_organization_id()
    OR selected_session.user_id IS DISTINCT FROM app.current_actor_id()
    OR selected_session.organization_id <> '10000000-0000-4000-8000-000000000001'::uuid
    OR selected_session.user_id <> '10000000-0000-4000-8000-000000000002'::uuid
    OR selected_session.session_mode <> 'DEMO'
    OR selected_session.auth_method <> 'DEMO_LINK'
    OR selected_session.demo_generation IS NOT NULL
    OR selected_session.demo_claim_id IS NOT NULL
    OR selected_session.revoked_at IS NOT NULL
    OR selected_session.expires_at <= now()
    OR selected_session.idle_expires_at <= now() THEN
    RAISE EXCEPTION 'Demo session claim is not live' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO selected_state FROM shared_demo_reset_state
  WHERE singleton FOR SHARE;
  IF selected_state.singleton IS NULL OR selected_state.status <> 'READY'
    OR selected_state.reset_after <= now()
    OR NOT EXISTS (
      SELECT 1
      FROM organizations organization
      JOIN users selected_user
        ON selected_user.id = selected_session.user_id
       AND selected_user.active AND selected_user.is_demo
      JOIN organization_memberships membership
        ON membership.id = selected_session.membership_id
       AND membership.organization_id = organization.id
       AND membership.user_id = selected_user.id AND membership.active
      WHERE organization.id = selected_session.organization_id
        AND organization.active AND organization.is_demo
        AND organization.organization_mode = 'PUBLIC_DEMO'
    ) THEN
    RAISE EXCEPTION 'Demo session claim is not live' USING ERRCODE = '28000';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.assert_current_demo_session_lease() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_revoke_session(
  selected_token_hash text,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  revoked_session auth_sessions%ROWTYPE;
BEGIN
  UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
  WHERE token_hash = selected_token_hash
  RETURNING * INTO revoked_session;
  IF revoked_session.id IS NULL THEN RETURN false; END IF;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome, request_id,
    metadata
  ) VALUES (
    revoked_session.user_id, revoked_session.organization_id,
    revoked_session.id, 'LOGOUT', 'SUCCESS', selected_request_id,
    jsonb_build_object(
      'sessionMode', revoked_session.session_mode,
      'sharedDemo', revoked_session.session_mode = 'DEMO'
    )
  );
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.auth_revoke_session(text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_mark_demo_step_up(
  selected_session_id uuid,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_session auth_sessions%ROWTYPE;
BEGIN
  IF length(selected_request_id) NOT BETWEEN 1 AND 200 THEN RETURN false; END IF;
  SELECT * INTO selected_session FROM auth_sessions
  WHERE id = selected_session_id FOR UPDATE;
  IF selected_session.session_mode <> 'DEMO'
    OR selected_session.auth_method <> 'DEMO_LINK'
    OR selected_session.revoked_at IS NOT NULL
    OR NOT app.auth_demo_session_lease_valid(selected_session_id) THEN
    RETURN false;
  END IF;
  UPDATE auth_sessions
  SET step_up_expires_at = least(expires_at, now() + interval '10 minutes')
  WHERE id = selected_session.id;
  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome, request_id,
    metadata
  ) VALUES (
    selected_session.user_id, selected_session.organization_id,
    selected_session.id, 'DEMO_PRIVILEGED_CONFIRMATION', 'SUCCESS',
    selected_request_id, jsonb_build_object('sharedDemo', true)
  );
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.auth_mark_demo_step_up(uuid, text) FROM PUBLIC;
--> statement-breakpoint

-- Synthetic members and invitations are ordinary shared-demo changes during
-- the day. Nightly maintenance retains only the canonical demo accountant.
CREATE OR REPLACE FUNCTION app.reset_shared_demo_extensions(
  selected_organization_id uuid,
  canonical_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  extra_user_ids uuid[];
BEGIN
  IF selected_organization_id <> '10000000-0000-4000-8000-000000000001'::uuid
    OR canonical_user_id <> '10000000-0000-4000-8000-000000000002'::uuid
    OR NOT EXISTS (
      SELECT 1
      FROM organizations organization
      JOIN organization_memberships membership
        ON membership.organization_id = organization.id
       AND membership.user_id = canonical_user_id AND membership.active
      JOIN membership_roles assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.membership_id = membership.id
      JOIN roles role
        ON role.organization_id = assignment.organization_id
       AND role.id = assignment.role_id
      WHERE organization.id = selected_organization_id
        AND organization.active AND organization.is_demo
        AND organization.organization_mode = 'PUBLIC_DEMO'
        AND role.key = 'demo_accountant' AND role.active
    ) THEN
    RAISE EXCEPTION 'Shared demo reset requires the canonical public-demo identity';
  END IF;

  SELECT coalesce(array_agg(membership.user_id), ARRAY[]::uuid[])
  INTO extra_user_ids
  FROM organization_memberships membership
  WHERE membership.organization_id = selected_organization_id
    AND membership.user_id <> canonical_user_id;

  DELETE FROM organization_invitations
  WHERE organization_id = selected_organization_id;
  DELETE FROM auth_recovery_requests
  WHERE organization_id = selected_organization_id
    OR user_id = ANY(extra_user_ids);
  DELETE FROM auth_email_outbox
  WHERE organization_id = selected_organization_id
    AND user_id <> canonical_user_id;
  DELETE FROM auth_mfa_factors WHERE user_id = ANY(extra_user_ids);
  DELETE FROM auth_one_time_tokens
  WHERE organization_id = selected_organization_id
    AND user_id <> canonical_user_id;
  DELETE FROM auth_sessions
  WHERE organization_id = selected_organization_id
    AND user_id <> canonical_user_id;
  DELETE FROM membership_roles
  WHERE organization_id = selected_organization_id
    AND membership_id IN (
      SELECT membership.id FROM organization_memberships membership
      WHERE membership.organization_id = selected_organization_id
        AND membership.user_id <> canonical_user_id
    );
  DELETE FROM organization_memberships
  WHERE organization_id = selected_organization_id
    AND user_id <> canonical_user_id;
  DELETE FROM users selected_user
  WHERE selected_user.id = ANY(extra_user_ids)
    AND selected_user.is_demo
    AND NOT EXISTS (
      SELECT 1 FROM organization_memberships remaining
      WHERE remaining.user_id = selected_user.id
    );

  UPDATE organizations SET
    slug = 'northstar-demo',
    display_name = 'Northstar Demo Group',
    settings_version = 1,
    active = true,
    is_demo = true,
    organization_mode = 'PUBLIC_DEMO',
    updated_at = now()
  WHERE id = selected_organization_id;
END
$$;
REVOKE ALL ON FUNCTION app.reset_shared_demo_extensions(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.shared_demo_operations_state()
RETURNS TABLE(
  active_sessions bigint,
  reset_due boolean,
  reset_status text,
  last_completed_reset_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT
    (SELECT count(*)::bigint
     FROM public.auth_sessions selected_session
     WHERE selected_session.organization_id = '10000000-0000-4000-8000-000000000001'::uuid
       AND selected_session.session_mode = 'DEMO'
       AND selected_session.revoked_at IS NULL
       AND selected_session.expires_at > pg_catalog.statement_timestamp()
       AND selected_session.idle_expires_at > pg_catalog.statement_timestamp()),
    reset_state.reset_after <= pg_catalog.statement_timestamp()
      OR reset_state.status <> 'READY',
    reset_state.status,
    reset_state.last_completed_reset_at
  FROM public.shared_demo_reset_state reset_state
  WHERE reset_state.singleton
$$;
REVOKE ALL ON FUNCTION app.shared_demo_operations_state() FROM PUBLIC;
--> statement-breakpoint

-- The final member-administration functions predate PUBLIC_DEMO writes and
-- contain one reviewed SANDBOX mode comparison each. Recreate those exact
-- functions from the installed definition after replacing only that mode
-- literal; fail migration if an earlier migration changed the expected body.
DO $shared_demo_admin_functions$
DECLARE
  selected_signature regprocedure;
  selected_definition text;
  updated_definition text;
BEGIN
  FOREACH selected_signature IN ARRAY ARRAY[
    'app.organization_admin_authorize(text,boolean)'::regprocedure,
    'app.organization_invite_member(uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,text)'::regprocedure,
    'app.organization_resend_invitation(uuid,integer,uuid,text,uuid,text)'::regprocedure
  ] LOOP
    selected_definition := pg_get_functiondef(selected_signature);
    updated_definition := replace(
      selected_definition,
      'selected_organization.organization_mode <> ''SANDBOX''',
      'selected_organization.organization_mode <> ''PUBLIC_DEMO'''
    );
    IF updated_definition = selected_definition
      OR updated_definition LIKE '%selected_organization.organization_mode <> ''SANDBOX''%' THEN
      RAISE EXCEPTION 'Shared demo migration could not update %', selected_signature;
    END IF;
    EXECUTE updated_definition;
  END LOOP;
END
$shared_demo_admin_functions$;
--> statement-breakpoint

DO $shared_demo_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON shared_demo_reset_state FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION
      app.auth_issue_demo_session(text, text, text, text, text, text),
      app.auth_demo_session_lease_valid(uuid),
      app.assert_current_demo_session_lease(),
      app.auth_revoke_session(text, text),
      app.auth_mark_demo_step_up(uuid, text),
      app.shared_demo_operations_state()
      TO business_finlynq_app;
  END IF;
END
$shared_demo_grants$;
