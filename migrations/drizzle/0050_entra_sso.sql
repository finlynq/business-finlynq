-- Federated sign-in produces the same opaque, revocable database session used
-- by password authentication. OIDC remains distinct authentication provenance
-- and never receives demo-session authority.
ALTER TABLE auth_sessions DROP CONSTRAINT auth_sessions_method_check;
--> statement-breakpoint
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_method_check
  CHECK (auth_method IN ('PASSWORD', 'DEMO_LINK', 'PASSWORD_RESET', 'OIDC'));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_issue_oidc_user_session(
  selected_user_id uuid,
  selected_organization_id uuid,
  selected_membership_id uuid,
  selected_token_hash text,
  selected_ip_hash text,
  selected_user_agent_hash text,
  selected_request_id text,
  selected_oidc_credential_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  created_session_id uuid;
BEGIN
  IF selected_token_hash !~ '^[0-9a-f]{64}$'
    OR length(selected_ip_hash) NOT BETWEEN 32 AND 200
    OR selected_user_agent_hash !~ '^[0-9a-f]{64}$'
    OR length(selected_request_id) NOT BETWEEN 1 AND 200
    OR selected_request_id ~ E'[\\r\\n]'
    OR selected_oidc_credential_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid OIDC session issuance request'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM users selected_user
  JOIN organization_memberships membership
    ON membership.id = selected_membership_id
   AND membership.user_id = selected_user.id
   AND membership.organization_id = selected_organization_id
   AND membership.active
  JOIN organizations organization
    ON organization.id = membership.organization_id
   AND organization.active
   AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
  WHERE selected_user.id = selected_user_id
    AND selected_user.active
    AND NOT selected_user.is_demo
    AND selected_user.email_verified_at IS NOT NULL
  FOR UPDATE OF selected_user;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO auth_sessions(
    token_hash, user_id, organization_id, membership_id,
    auth_method, session_mode, ip_hash, user_agent_hash,
    idle_timeout_seconds, idle_expires_at, expires_at,
    mfa_verified_at, step_up_expires_at
  ) VALUES (
    selected_token_hash, selected_user_id, selected_organization_id,
    selected_membership_id, 'OIDC', 'REAL', selected_ip_hash,
    selected_user_agent_hash, 7200, now() + interval '2 hours',
    now() + interval '24 hours', NULL, NULL
  ) RETURNING id INTO created_session_id;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome, request_id,
    metadata
  ) VALUES (
    selected_user_id, selected_organization_id, created_session_id,
    'LOGIN_OIDC', 'SUCCESS', selected_request_id,
    jsonb_build_object('credentialHash', selected_oidc_credential_hash)
  );
  INSERT INTO auth_email_outbox(
    id, user_id, organization_id, template_type, request_id
  ) VALUES (
    gen_random_uuid(), selected_user_id, selected_organization_id,
    'SECURITY_NEW_LOGIN', selected_request_id
  );
  RETURN created_session_id;
END
$$;
REVOKE ALL ON FUNCTION app.auth_issue_oidc_user_session(
  uuid, uuid, uuid, text, text, text, text, text
) FROM PUBLIC;
--> statement-breakpoint

-- A local TOTP step-up remains mandatory for privileged organization
-- administration. Preserve the primary sign-in provenance while accepting
-- either supported real-account primary method after that fresh step-up.
CREATE OR REPLACE FUNCTION app.organization_admin_authorize(
  selected_permission text,
  require_fresh_step_up boolean
)
RETURNS TABLE(
  organization_id uuid,
  actor_id uuid,
  session_id uuid,
  is_demo boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_organization_id uuid;
  selected_actor_id uuid;
  selected_session_id uuid;
  selected_organization organizations%ROWTYPE;
  selected_session auth_sessions%ROWTYPE;
BEGIN
  selected_organization_id := app.current_organization_id();
  selected_actor_id := app.current_actor_id();
  BEGIN
    selected_session_id := nullif(current_setting('app.session_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Organization administration requires an active session'
      USING ERRCODE = '28000';
  END;
  IF selected_session_id IS NULL THEN
    RAISE EXCEPTION 'Organization administration requires an active session'
      USING ERRCODE = '28000';
  END IF;

  IF require_fresh_step_up THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'organization-administration|' || selected_organization_id::text, 0
    ));
  END IF;

  SELECT * INTO selected_organization
  FROM organizations
  WHERE id = selected_organization_id AND active
  FOR SHARE;
  SELECT * INTO selected_session
  FROM auth_sessions
  WHERE id = selected_session_id
  FOR SHARE;
  IF selected_organization.id IS NULL
    OR selected_session.id IS NULL
    OR selected_session.user_id IS DISTINCT FROM selected_actor_id
    OR selected_session.organization_id IS DISTINCT FROM selected_organization_id
    OR selected_session.membership_id IS DISTINCT FROM (
      SELECT membership.id
      FROM organization_memberships membership
      WHERE membership.organization_id = selected_organization_id
        AND membership.user_id = selected_actor_id
        AND membership.active
      LIMIT 1
    )
    OR selected_session.revoked_at IS NOT NULL
    OR selected_session.expires_at <= now()
    OR selected_session.idle_expires_at <= now() THEN
    RAISE EXCEPTION 'Organization administration requires an active session'
      USING ERRCODE = '28000';
  END IF;

  IF selected_organization.is_demo THEN
    IF selected_organization.organization_mode <> 'PUBLIC_DEMO'
      OR selected_session.session_mode <> 'DEMO'
      OR coalesce(current_setting('app.session_mode', true), '') <> 'demo' THEN
      RAISE EXCEPTION 'Organization administration session mode is invalid'
        USING ERRCODE = '28000';
    END IF;
    PERFORM app.assert_current_demo_session_lease();
  ELSE
    IF selected_organization.organization_mode <> 'REAL'
      OR selected_session.session_mode <> 'REAL'
      OR coalesce(current_setting('app.session_mode', true), '') <> 'real' THEN
      RAISE EXCEPTION 'Organization administration session mode is invalid'
        USING ERRCODE = '28000';
    END IF;
    IF require_fresh_step_up AND (
      selected_session.step_up_expires_at IS NULL
      OR selected_session.step_up_expires_at <= now()
      OR coalesce(current_setting('app.auth_method', true), '')
        NOT IN ('password+mfa', 'oidc+mfa')
    ) THEN
      RAISE EXCEPTION 'Organization administration requires fresh MFA step-up'
        USING ERRCODE = '28000';
    END IF;
  END IF;

  IF NOT app.organization_admin_actor_has_permission(
    selected_organization_id, selected_actor_id, selected_permission
  ) THEN
    RAISE EXCEPTION 'Organization administration permission is required'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT selected_organization_id, selected_actor_id,
    selected_session_id, selected_organization.is_demo;
END
$$;
REVOKE ALL ON FUNCTION app.organization_admin_authorize(text, boolean) FROM PUBLIC;
--> statement-breakpoint

COMMENT ON FUNCTION app.auth_issue_oidc_user_session(
  uuid, uuid, uuid, text, text, text, text, text
) IS 'Issues an ordinary real-account session only after the application verifies and maps a trusted OIDC identity; provider identifiers are represented by a non-reversible credential hash in the security event.';
--> statement-breakpoint

DO $oidc_session_grant$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app'
  ) THEN
    GRANT EXECUTE ON FUNCTION app.auth_issue_oidc_user_session(
      uuid, uuid, uuid, text, text, text, text, text
    ) TO business_finlynq_app;
  END IF;
END
$oidc_session_grant$;
