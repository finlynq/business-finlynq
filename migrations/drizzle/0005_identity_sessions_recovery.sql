ALTER TABLE organizations
  ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE users
  ADD COLUMN display_name_ciphertext text,
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN is_demo boolean NOT NULL DEFAULT false,
  ADD COLUMN password_changed_at timestamp with time zone;
--> statement-breakpoint

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL REFERENCES organization_memberships(id) ON DELETE RESTRICT,
  auth_method text NOT NULL,
  session_mode text NOT NULL,
  ip_hash text,
  user_agent_hash text,
  idle_timeout_seconds integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  idle_expires_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  CONSTRAINT auth_sessions_mode_check CHECK (session_mode IN ('REAL', 'DEMO')),
  CONSTRAINT auth_sessions_method_check CHECK (auth_method IN ('PASSWORD', 'DEMO_LINK', 'PASSWORD_RESET')),
  CONSTRAINT auth_sessions_idle_timeout_check CHECK (idle_timeout_seconds BETWEEN 300 AND 86400),
  CONSTRAINT auth_sessions_expiry_order_check CHECK (idle_expires_at <= expires_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX auth_sessions_token_hash_unique ON auth_sessions(token_hash);
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions(user_id, revoked_at, expires_at);
CREATE INDEX auth_sessions_demo_expiry_idx ON auth_sessions(session_mode, expires_at) WHERE session_mode = 'DEMO';
--> statement-breakpoint

CREATE TABLE auth_one_time_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  purpose text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  requested_ip_hash text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  CONSTRAINT auth_one_time_tokens_purpose_check CHECK (purpose IN ('PASSWORD_RESET', 'EMAIL_VERIFICATION', 'INVITATION', 'MAGIC_LOGIN'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX auth_one_time_tokens_hash_unique ON auth_one_time_tokens(token_hash);
CREATE INDEX auth_one_time_tokens_user_purpose_idx ON auth_one_time_tokens(user_id, purpose, expires_at);
--> statement-breakpoint

CREATE TABLE auth_rate_limits (
  scope text NOT NULL,
  key_hash text NOT NULL,
  window_started_at timestamp with time zone NOT NULL,
  attempts integer NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key_hash),
  CONSTRAINT auth_rate_limits_attempts_check CHECK (attempts > 0)
);
CREATE INDEX auth_rate_limits_updated_idx ON auth_rate_limits(updated_at);
--> statement-breakpoint

CREATE TABLE auth_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  session_id uuid REFERENCES auth_sessions(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  outcome text NOT NULL,
  request_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT auth_security_events_outcome_check CHECK (outcome IN ('SUCCESS', 'FAILURE', 'DENIED'))
);
--> statement-breakpoint
CREATE INDEX auth_security_events_created_idx ON auth_security_events(created_at);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_auth_security_event_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Authentication security events are append-only'
    USING ERRCODE = '55000';
END
$$;
--> statement-breakpoint
CREATE TRIGGER auth_security_events_append_only
  BEFORE UPDATE OR DELETE ON auth_security_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_auth_security_event_immutable();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_consume_rate_limit(
  selected_scope text,
  selected_key_hash text,
  attempt_limit integer,
  window_seconds integer
)
RETURNS TABLE(allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_attempts integer;
  current_window_started_at timestamp with time zone;
BEGIN
  IF selected_scope IS NULL OR length(selected_scope) NOT BETWEEN 1 AND 80 OR
     selected_key_hash IS NULL OR length(selected_key_hash) NOT BETWEEN 32 AND 200 OR
     attempt_limit NOT BETWEEN 1 AND 1000 OR window_seconds NOT BETWEEN 1 AND 604800 THEN
    RAISE EXCEPTION 'Invalid authentication rate-limit request' USING ERRCODE = '22023';
  END IF;

  WITH stale AS (
    SELECT scope, key_hash
    FROM auth_rate_limits
    WHERE updated_at < now() - interval '8 days'
    ORDER BY updated_at
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM auth_rate_limits target
  USING stale
  WHERE target.scope = stale.scope AND target.key_hash = stale.key_hash;

  INSERT INTO auth_rate_limits(scope, key_hash, window_started_at, attempts, updated_at)
  VALUES (selected_scope, selected_key_hash, now(), 1, now())
  ON CONFLICT (scope, key_hash) DO UPDATE SET
    attempts = CASE
      WHEN auth_rate_limits.window_started_at + make_interval(secs => window_seconds) <= now() THEN 1
      ELSE auth_rate_limits.attempts + 1
    END,
    window_started_at = CASE
      WHEN auth_rate_limits.window_started_at + make_interval(secs => window_seconds) <= now() THEN now()
      ELSE auth_rate_limits.window_started_at
    END,
    updated_at = now()
  RETURNING attempts, window_started_at INTO current_attempts, current_window_started_at;

  RETURN QUERY SELECT
    current_attempts <= attempt_limit,
    CASE WHEN current_attempts <= attempt_limit THEN 0 ELSE
      greatest(1, ceil(extract(epoch FROM current_window_started_at + make_interval(secs => window_seconds) - now()))::integer)
    END;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_lookup_login(selected_email_hash text)
RETURNS TABLE(
  user_id uuid,
  password_hash text,
  email_ciphertext text,
  display_name_ciphertext text,
  email_verified_at timestamp with time zone,
  organization_id uuid,
  organization_name text,
  membership_id uuid,
  role_label text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    selected_user.id,
    selected_user.password_hash,
    selected_user.email_ciphertext,
    selected_user.display_name_ciphertext,
    selected_user.email_verified_at,
    organization.id,
    organization.display_name,
    membership.id,
    coalesce(string_agg(DISTINCT role.display_name, ', ' ORDER BY role.display_name), 'Member')
  FROM users selected_user
  JOIN organization_memberships membership
    ON membership.user_id = selected_user.id AND membership.active
  JOIN organizations organization
    ON organization.id = membership.organization_id AND organization.active AND NOT organization.is_demo
  LEFT JOIN membership_roles membership_role
    ON membership_role.organization_id = organization.id AND membership_role.membership_id = membership.id
  LEFT JOIN roles role
    ON role.organization_id = organization.id AND role.id = membership_role.role_id AND role.active
  WHERE selected_user.email_lookup_hash = selected_email_hash
    AND selected_user.active
    AND NOT selected_user.is_demo
  GROUP BY selected_user.id, organization.id, membership.id
  ORDER BY organization.created_at, organization.id
  LIMIT 10
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_issue_user_session(
  selected_user_id uuid,
  selected_organization_id uuid,
  selected_membership_id uuid,
  selected_token_hash text,
  selected_ip_hash text,
  selected_user_agent_hash text,
  selected_request_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  created_session_id uuid;
BEGIN
  IF length(selected_token_hash) < 32 OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid session issuance request' USING ERRCODE = '22023';
  END IF;

  INSERT INTO auth_sessions(
    token_hash, user_id, organization_id, membership_id, auth_method, session_mode,
    ip_hash, user_agent_hash, idle_timeout_seconds, idle_expires_at, expires_at
  )
  SELECT
    selected_token_hash, selected_user.id, organization.id, membership.id, 'PASSWORD', 'REAL',
    selected_ip_hash, selected_user_agent_hash, 7200, now() + interval '2 hours', now() + interval '24 hours'
  FROM users selected_user
  JOIN organization_memberships membership
    ON membership.id = selected_membership_id
   AND membership.user_id = selected_user.id
   AND membership.organization_id = selected_organization_id
   AND membership.active
  JOIN organizations organization
    ON organization.id = membership.organization_id AND organization.active AND NOT organization.is_demo
  WHERE selected_user.id = selected_user_id AND selected_user.active AND NOT selected_user.is_demo
  RETURNING id INTO created_session_id;

  IF created_session_id IS NOT NULL THEN
    INSERT INTO auth_security_events(user_id, organization_id, session_id, event_type, outcome, request_id)
    VALUES (selected_user_id, selected_organization_id, created_session_id, 'LOGIN', 'SUCCESS', selected_request_id);
  END IF;
  RETURN created_session_id;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_issue_demo_session(
  selected_token_hash text,
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
  role_label text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  created_session_id uuid;
BEGIN
  IF length(selected_token_hash) < 32 OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid demo session request' USING ERRCODE = '22023';
  END IF;

  WITH stale AS (
    SELECT id
    FROM auth_sessions
    WHERE session_mode = 'DEMO'
      AND (expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day')
    ORDER BY expires_at
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM auth_sessions target
  USING stale
  WHERE target.id = stale.id;

  INSERT INTO auth_sessions(
    token_hash, user_id, organization_id, membership_id, auth_method, session_mode,
    ip_hash, user_agent_hash, idle_timeout_seconds, idle_expires_at, expires_at
  )
  SELECT
    selected_token_hash, selected_user.id, organization.id, membership.id, 'DEMO_LINK', 'DEMO',
    selected_ip_hash, selected_user_agent_hash, 7200, now() + interval '2 hours', now() + interval '8 hours'
  FROM users selected_user
  JOIN organization_memberships membership
    ON membership.user_id = selected_user.id AND membership.active
  JOIN organizations organization
    ON organization.id = membership.organization_id AND organization.active
  WHERE selected_user.id = '10000000-0000-4000-8000-000000000002'::uuid
    AND organization.id = '10000000-0000-4000-8000-000000000001'::uuid
    AND membership.id = '10000000-0000-4000-8000-000000000003'::uuid
    AND selected_user.active AND selected_user.is_demo AND organization.is_demo
  RETURNING id INTO created_session_id;

  IF created_session_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT created_session_id, selected_user.id, organization.id, membership.id,
    organization.display_name,
    coalesce(string_agg(DISTINCT role.display_name, ', ' ORDER BY role.display_name), 'Demo viewer')
  FROM users selected_user
  JOIN organization_memberships membership ON membership.user_id = selected_user.id
  JOIN organizations organization ON organization.id = membership.organization_id
  LEFT JOIN membership_roles membership_role
    ON membership_role.organization_id = organization.id AND membership_role.membership_id = membership.id
  LEFT JOIN roles role
    ON role.organization_id = organization.id AND role.id = membership_role.role_id AND role.active
  WHERE selected_user.id = '10000000-0000-4000-8000-000000000002'::uuid
    AND organization.id = '10000000-0000-4000-8000-000000000001'::uuid
    AND membership.id = '10000000-0000-4000-8000-000000000003'::uuid
  GROUP BY selected_user.id, organization.id, membership.id;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_resolve_session(
  selected_token_hash text,
  selected_user_agent_hash text
)
RETURNS TABLE(
  session_id uuid,
  user_id uuid,
  organization_id uuid,
  membership_id uuid,
  session_mode text,
  auth_method text,
  organization_name text,
  role_label text,
  email_ciphertext text,
  display_name_ciphertext text,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_session auth_sessions%ROWTYPE;
BEGIN
  SELECT session.* INTO selected_session
  FROM auth_sessions session
  JOIN users selected_user ON selected_user.id = session.user_id AND selected_user.active
  JOIN organizations organization ON organization.id = session.organization_id AND organization.active
  JOIN organization_memberships membership
    ON membership.id = session.membership_id
   AND membership.user_id = session.user_id
   AND membership.organization_id = session.organization_id
   AND membership.active
  WHERE session.token_hash = selected_token_hash
    AND session.revoked_at IS NULL
    AND session.expires_at > now()
    AND session.idle_expires_at > now()
    AND (session.user_agent_hash IS NULL OR session.user_agent_hash = selected_user_agent_hash)
  FOR UPDATE OF session;

  IF selected_session.id IS NULL THEN RETURN; END IF;

  IF selected_session.last_seen_at < now() - interval '5 minutes' THEN
    UPDATE auth_sessions AS session_to_refresh
    SET last_seen_at = now(),
        idle_expires_at = least(session_to_refresh.expires_at, now() + make_interval(secs => session_to_refresh.idle_timeout_seconds))
    WHERE session_to_refresh.id = selected_session.id;
  END IF;

  RETURN QUERY
  SELECT selected_session.id, selected_user.id, organization.id, membership.id,
    selected_session.session_mode, selected_session.auth_method, organization.display_name,
    coalesce(string_agg(DISTINCT role.display_name, ', ' ORDER BY role.display_name),
      CASE WHEN selected_session.session_mode = 'DEMO' THEN 'Demo viewer' ELSE 'Member' END),
    selected_user.email_ciphertext, selected_user.display_name_ciphertext, selected_session.expires_at
  FROM users selected_user
  JOIN organization_memberships membership ON membership.id = selected_session.membership_id
  JOIN organizations organization ON organization.id = selected_session.organization_id
  LEFT JOIN membership_roles membership_role
    ON membership_role.organization_id = organization.id AND membership_role.membership_id = membership.id
  LEFT JOIN roles role
    ON role.organization_id = organization.id AND role.id = membership_role.role_id AND role.active
  WHERE selected_user.id = selected_session.user_id
  GROUP BY selected_user.id, organization.id, membership.id;
END
$$;
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
  IF revoked_session.session_mode <> 'DEMO' THEN
    INSERT INTO auth_security_events(user_id, organization_id, session_id, event_type, outcome, request_id)
    VALUES (revoked_session.user_id, revoked_session.organization_id, revoked_session.id, 'LOGOUT', 'SUCCESS', selected_request_id);
  END IF;
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_prepare_password_reset(
  selected_email_hash text,
  selected_token_hash text,
  selected_ip_hash text,
  selected_request_id text
)
RETURNS TABLE(user_id uuid, email_ciphertext text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user users%ROWTYPE;
BEGIN
  SELECT candidate.* INTO selected_user
  FROM users candidate
  WHERE candidate.email_lookup_hash = selected_email_hash
    AND candidate.active AND NOT candidate.is_demo AND candidate.email_verified_at IS NOT NULL
  FOR UPDATE;

  IF selected_user.id IS NULL THEN RETURN; END IF;

  UPDATE auth_one_time_tokens SET consumed_at = coalesce(consumed_at, now())
  WHERE auth_one_time_tokens.user_id = selected_user.id
    AND purpose = 'PASSWORD_RESET' AND consumed_at IS NULL;

  INSERT INTO auth_one_time_tokens(token_hash, purpose, user_id, requested_ip_hash, expires_at)
  VALUES (selected_token_hash, 'PASSWORD_RESET', selected_user.id, selected_ip_hash, now() + interval '1 hour');
  INSERT INTO auth_security_events(user_id, event_type, outcome, request_id)
  VALUES (selected_user.id, 'PASSWORD_RESET_REQUEST', 'SUCCESS', selected_request_id);

  RETURN QUERY SELECT selected_user.id, selected_user.email_ciphertext;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_finish_password_reset(
  selected_token_hash text,
  selected_password_hash text,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
BEGIN
  IF length(selected_password_hash) NOT BETWEEN 40 AND 1000 OR
     selected_password_hash NOT LIKE 'scrypt-v1$32768$8$1$%' THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = '22023';
  END IF;

  UPDATE auth_one_time_tokens token
  SET consumed_at = now()
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'PASSWORD_RESET'
    AND token.consumed_at IS NULL
    AND token.expires_at > now()
  RETURNING token.user_id INTO selected_user_id;

  IF selected_user_id IS NULL THEN RETURN false; END IF;

  UPDATE users
  SET password_hash = selected_password_hash, password_changed_at = now()
  WHERE id = selected_user_id AND active AND NOT is_demo;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
  WHERE user_id = selected_user_id AND revoked_at IS NULL;
  INSERT INTO auth_security_events(user_id, event_type, outcome, request_id)
  VALUES (selected_user_id, 'PASSWORD_RESET_COMPLETE', 'SUCCESS', selected_request_id);
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_record_login_failure(selected_request_id text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO auth_security_events(event_type, outcome, request_id)
  VALUES ('LOGIN', 'FAILURE', selected_request_id)
$$;
--> statement-breakpoint

INSERT INTO organizations(id, slug, display_name, active, is_demo)
VALUES ('10000000-0000-4000-8000-000000000001', 'northstar-demo', 'Northstar Demo Group', true, true)
ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, active = true, is_demo = true;
--> statement-breakpoint
INSERT INTO users(
  id, email_lookup_hash, email_ciphertext, display_name_ciphertext, password_hash,
  active, is_demo, email_verified_at
)
VALUES (
  '10000000-0000-4000-8000-000000000002', 'demo-login-disabled', 'public-demo', NULL,
  '!demo-login-disabled!', true, true, now()
)
ON CONFLICT (id) DO UPDATE SET active = true, is_demo = true, email_verified_at = coalesce(users.email_verified_at, now());
--> statement-breakpoint
INSERT INTO organization_memberships(id, organization_id, user_id, active)
VALUES (
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  true
)
ON CONFLICT (id) DO UPDATE SET active = true;
--> statement-breakpoint
INSERT INTO roles(id, organization_id, key, display_name, system_template, active)
VALUES (
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000001',
  'demo_viewer', 'Demo viewer', true, true
)
ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, active = true;
--> statement-breakpoint
INSERT INTO membership_roles(organization_id, membership_id, role_id, assigned_by)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000002'
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

REVOKE ALL ON auth_sessions, auth_one_time_tokens, auth_rate_limits, auth_security_events FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  app.auth_consume_rate_limit(text, text, integer, integer),
  app.auth_lookup_login(text),
  app.auth_issue_user_session(uuid, uuid, uuid, text, text, text, text),
  app.auth_issue_demo_session(text, text, text, text),
  app.auth_resolve_session(text, text),
  app.auth_revoke_session(text, text),
  app.auth_prepare_password_reset(text, text, text, text),
  app.auth_finish_password_reset(text, text, text),
  app.auth_record_login_failure(text)
FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON auth_sessions, auth_one_time_tokens, auth_rate_limits, auth_security_events
      FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION
      app.auth_consume_rate_limit(text, text, integer, integer),
      app.auth_lookup_login(text),
      app.auth_issue_user_session(uuid, uuid, uuid, text, text, text, text),
      app.auth_issue_demo_session(text, text, text, text),
      app.auth_resolve_session(text, text),
      app.auth_revoke_session(text, text),
      app.auth_prepare_password_reset(text, text, text, text),
      app.auth_finish_password_reset(text, text, text),
      app.auth_record_login_failure(text)
    TO business_finlynq_app;
  END IF;
END
$$;
