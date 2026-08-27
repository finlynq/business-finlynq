ALTER TABLE users
  ADD COLUMN mfa_required boolean NOT NULL DEFAULT true;
UPDATE users SET mfa_required = false WHERE is_demo;
--> statement-breakpoint

ALTER TABLE auth_sessions
  ADD COLUMN mfa_verified_at timestamp with time zone,
  ADD COLUMN step_up_expires_at timestamp with time zone;
--> statement-breakpoint

ALTER TABLE auth_one_time_tokens
  DROP CONSTRAINT auth_one_time_tokens_purpose_check,
  ADD COLUMN available_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN recovery_policy text,
  ADD COLUMN recovery_authorized_at timestamp with time zone,
  ADD COLUMN recovery_authorized_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT auth_one_time_tokens_purpose_check
    CHECK (purpose IN ('PASSWORD_RESET', 'EMAIL_VERIFICATION', 'INVITATION', 'MAGIC_LOGIN', 'MFA_SETUP')),
  ADD CONSTRAINT auth_one_time_tokens_recovery_policy_check
    CHECK (recovery_policy IS NULL OR recovery_policy IN ('EMAIL_ONLY', 'TOTP', 'CO_OWNER', 'DELAYED'));
--> statement-breakpoint

CREATE TABLE auth_mfa_factors (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recovery_token_id uuid REFERENCES auth_one_time_tokens(id) ON DELETE RESTRICT,
  factor_type text NOT NULL,
  label text NOT NULL,
  secret_ciphertext text NOT NULL,
  status text NOT NULL,
  last_accepted_counter bigint,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  verified_at timestamp with time zone,
  revoked_at timestamp with time zone,
  CONSTRAINT auth_mfa_factors_type_check CHECK (factor_type = 'TOTP'),
  CONSTRAINT auth_mfa_factors_status_check CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED'))
);
CREATE UNIQUE INDEX auth_mfa_factors_one_active_totp
  ON auth_mfa_factors(user_id, factor_type) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX auth_mfa_factors_one_pending_totp
  ON auth_mfa_factors(user_id, factor_type) WHERE status = 'PENDING';
CREATE UNIQUE INDEX auth_mfa_factors_recovery_token_unique
  ON auth_mfa_factors(recovery_token_id)
  WHERE recovery_token_id IS NOT NULL AND status = 'PENDING';
CREATE INDEX auth_mfa_factors_user_status_idx ON auth_mfa_factors(user_id, status);
--> statement-breakpoint

CREATE TABLE auth_recovery_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid NOT NULL UNIQUE REFERENCES auth_one_time_tokens(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  policy text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  approved_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT auth_recovery_requests_policy_check CHECK (policy IN ('TOTP', 'CO_OWNER', 'DELAYED')),
  CONSTRAINT auth_recovery_requests_status_check CHECK (status IN ('PENDING', 'APPROVED', 'CONSUMED', 'DENIED'))
);
CREATE INDEX auth_recovery_requests_org_status_idx ON auth_recovery_requests(organization_id, status, expires_at);
--> statement-breakpoint

CREATE TABLE auth_email_outbox (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  template_type text NOT NULL,
  payload_ciphertext text,
  template_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamp with time zone NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_expires_at timestamp with time zone,
  provider_message_id text,
  last_error_code text,
  request_id text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  sent_at timestamp with time zone,
  CONSTRAINT auth_email_outbox_template_check CHECK (template_type IN (
    'PASSWORD_RESET', 'INVITATION', 'RECOVERY_APPROVAL', 'SECURITY_PASSWORD_CHANGED',
    'SECURITY_MFA_ENABLED', 'SECURITY_MFA_REPLACED', 'SECURITY_NEW_LOGIN', 'SECURITY_RECOVERY_ESCALATED'
  )),
  CONSTRAINT auth_email_outbox_status_check CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'DEAD')),
  CONSTRAINT auth_email_outbox_attempts_check CHECK (attempts BETWEEN 0 AND 8)
);
CREATE INDEX auth_email_outbox_delivery_idx ON auth_email_outbox(status, available_at, created_at)
  WHERE status IN ('PENDING', 'SENDING');
CREATE INDEX auth_email_outbox_user_created_idx ON auth_email_outbox(user_id, created_at);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_lookup_login_v2(selected_email_hash text)
RETURNS TABLE(
  user_id uuid,
  password_hash text,
  email_ciphertext text,
  display_name_ciphertext text,
  email_verified_at timestamp with time zone,
  mfa_required boolean,
  mfa_factor_id uuid,
  mfa_secret_ciphertext text,
  mfa_last_accepted_counter bigint,
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
    selected_user.mfa_required,
    factor.id,
    factor.secret_ciphertext,
    factor.last_accepted_counter,
    organization.id,
    organization.display_name,
    membership.id,
    coalesce(role_names.label, 'Member')
  FROM users selected_user
  JOIN organization_memberships membership
    ON membership.user_id = selected_user.id AND membership.active
  JOIN organizations organization
    ON organization.id = membership.organization_id AND organization.active AND NOT organization.is_demo
  LEFT JOIN LATERAL (
    SELECT string_agg(DISTINCT role.display_name, ', ' ORDER BY role.display_name) AS label
    FROM membership_roles membership_role
    JOIN roles role
      ON role.organization_id = membership_role.organization_id
     AND role.id = membership_role.role_id
     AND role.active
    WHERE membership_role.organization_id = membership.organization_id
      AND membership_role.membership_id = membership.id
  ) role_names ON true
  LEFT JOIN LATERAL (
    SELECT candidate.id, candidate.secret_ciphertext, candidate.last_accepted_counter
    FROM auth_mfa_factors candidate
    WHERE candidate.user_id = selected_user.id
      AND candidate.factor_type = 'TOTP'
      AND candidate.status = 'ACTIVE'
    ORDER BY candidate.verified_at DESC NULLS LAST, candidate.created_at DESC
    LIMIT 1
  ) factor ON true
  WHERE selected_user.email_lookup_hash = selected_email_hash
    AND selected_user.active
    AND NOT selected_user.is_demo
  ORDER BY organization.created_at, organization.id
  LIMIT 10
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_issue_mfa_user_session(
  selected_user_id uuid,
  selected_organization_id uuid,
  selected_membership_id uuid,
  selected_factor_id uuid,
  selected_totp_counter bigint,
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
    RAISE EXCEPTION 'Invalid MFA session issuance request' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM users selected_user
  JOIN organization_memberships membership
    ON membership.id = selected_membership_id
   AND membership.user_id = selected_user.id
   AND membership.organization_id = selected_organization_id
   AND membership.active
  JOIN organizations organization
    ON organization.id = membership.organization_id AND organization.active AND NOT organization.is_demo
  WHERE selected_user.id = selected_user_id
    AND selected_user.active AND NOT selected_user.is_demo
    AND selected_user.mfa_required;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE auth_mfa_factors factor
  SET last_accepted_counter = selected_totp_counter
  WHERE factor.id = selected_factor_id
    AND factor.user_id = selected_user_id
    AND factor.status = 'ACTIVE'
    AND selected_totp_counter > coalesce(factor.last_accepted_counter, -1);
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO auth_sessions(
    token_hash, user_id, organization_id, membership_id, auth_method, session_mode,
    ip_hash, user_agent_hash, idle_timeout_seconds, idle_expires_at, expires_at,
    mfa_verified_at, step_up_expires_at
  ) VALUES (
    selected_token_hash, selected_user_id, selected_organization_id, selected_membership_id,
    'PASSWORD', 'REAL', selected_ip_hash, selected_user_agent_hash, 7200,
    now() + interval '2 hours', now() + interval '24 hours', now(), now() + interval '10 minutes'
  ) RETURNING id INTO created_session_id;

  INSERT INTO auth_security_events(user_id, organization_id, session_id, event_type, outcome, request_id)
  VALUES (selected_user_id, selected_organization_id, created_session_id, 'LOGIN_MFA', 'SUCCESS', selected_request_id);
  INSERT INTO auth_email_outbox(id, user_id, organization_id, template_type, request_id)
  VALUES (gen_random_uuid(), selected_user_id, selected_organization_id, 'SECURITY_NEW_LOGIN', selected_request_id);
  RETURN created_session_id;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_resolve_session_v2(
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
  expires_at timestamp with time zone,
  mfa_verified_at timestamp with time zone,
  step_up_expires_at timestamp with time zone
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
    selected_user.email_ciphertext, selected_user.display_name_ciphertext, selected_session.expires_at,
    selected_session.mfa_verified_at, selected_session.step_up_expires_at
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

CREATE OR REPLACE FUNCTION app.auth_queue_password_reset(
  selected_email_hash text,
  selected_token_hash text,
  selected_payload_ciphertext text,
  selected_outbox_id uuid,
  selected_ip_hash text,
  selected_request_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user users%ROWTYPE;
  selected_token_id uuid;
  selected_organization_id uuid;
  selected_policy text;
  selected_available_at timestamp with time zone := now();
  selected_expires_at timestamp with time zone := now() + interval '1 hour';
  is_recovery_manager boolean := false;
  has_totp boolean := false;
  has_co_owner boolean := false;
  recovery_request_id uuid;
BEGIN
  SELECT candidate.* INTO selected_user
  FROM users candidate
  WHERE candidate.email_lookup_hash = selected_email_hash
    AND candidate.active AND NOT candidate.is_demo AND candidate.email_verified_at IS NOT NULL
  FOR UPDATE;
  IF selected_user.id IS NULL THEN
    PERFORM count(*) FROM users WHERE active AND NOT is_demo;
    RETURN;
  END IF;

  SELECT membership.organization_id INTO selected_organization_id
  FROM organization_memberships membership
  JOIN organizations organization ON organization.id = membership.organization_id AND organization.active
  WHERE membership.user_id = selected_user.id AND membership.active
  ORDER BY membership.created_at, membership.organization_id
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1
    FROM organization_memberships membership
    JOIN membership_roles membership_role
      ON membership_role.organization_id = membership.organization_id AND membership_role.membership_id = membership.id
    JOIN roles role ON role.organization_id = membership_role.organization_id AND role.id = membership_role.role_id AND role.active
    JOIN role_permissions role_permission
      ON role_permission.organization_id = role.organization_id AND role_permission.role_id = role.id
    WHERE membership.user_id = selected_user.id
      AND membership.organization_id = selected_organization_id
      AND membership.active
      AND role_permission.permission_key = 'organization.recovery.manage'
  ) INTO is_recovery_manager;
  SELECT EXISTS (
    SELECT 1 FROM auth_mfa_factors factor
    WHERE factor.user_id = selected_user.id AND factor.factor_type = 'TOTP' AND factor.status = 'ACTIVE'
  ) INTO has_totp;
  SELECT EXISTS (
    SELECT 1
    FROM organization_memberships membership
    JOIN membership_roles membership_role
      ON membership_role.organization_id = membership.organization_id AND membership_role.membership_id = membership.id
    JOIN roles role ON role.organization_id = membership_role.organization_id AND role.id = membership_role.role_id AND role.active
    JOIN role_permissions role_permission
      ON role_permission.organization_id = role.organization_id AND role_permission.role_id = role.id
    JOIN users co_owner ON co_owner.id = membership.user_id AND co_owner.active AND NOT co_owner.is_demo
    JOIN auth_mfa_factors co_owner_factor
      ON co_owner_factor.user_id = co_owner.id
     AND co_owner_factor.factor_type = 'TOTP' AND co_owner_factor.status = 'ACTIVE'
    WHERE membership.organization_id = selected_organization_id
      AND membership.user_id <> selected_user.id AND membership.active
      AND role_permission.permission_key = 'organization.recovery.manage'
  ) INTO has_co_owner;

  IF has_totp THEN
    selected_policy := 'TOTP';
  ELSIF is_recovery_manager AND has_co_owner THEN
    selected_policy := 'CO_OWNER';
    selected_expires_at := now() + interval '24 hours';
  ELSIF is_recovery_manager THEN
    selected_policy := 'DELAYED';
    selected_available_at := now() + interval '72 hours';
    selected_expires_at := now() + interval '96 hours';
  ELSE
    selected_policy := 'EMAIL_ONLY';
  END IF;

  UPDATE auth_one_time_tokens SET consumed_at = coalesce(consumed_at, now())
  WHERE user_id = selected_user.id AND purpose = 'PASSWORD_RESET' AND consumed_at IS NULL;
  INSERT INTO auth_one_time_tokens(
    token_hash, purpose, user_id, organization_id, requested_ip_hash, available_at,
    expires_at, recovery_policy
  ) VALUES (
    selected_token_hash, 'PASSWORD_RESET', selected_user.id, selected_organization_id,
    selected_ip_hash, selected_available_at, selected_expires_at, selected_policy
  ) RETURNING id INTO selected_token_id;

  INSERT INTO auth_email_outbox(
    id, user_id, organization_id, template_type, payload_ciphertext, template_data, request_id
  ) VALUES (
    selected_outbox_id, selected_user.id, selected_organization_id, 'PASSWORD_RESET',
    selected_payload_ciphertext,
    jsonb_build_object('policy', selected_policy, 'availableAt', selected_available_at),
    selected_request_id
  );

  IF selected_policy <> 'EMAIL_ONLY' THEN
    INSERT INTO auth_recovery_requests(token_id, user_id, organization_id, policy, expires_at)
    VALUES (selected_token_id, selected_user.id, selected_organization_id, selected_policy, selected_expires_at)
    RETURNING id INTO recovery_request_id;
  END IF;

  IF selected_policy = 'CO_OWNER' THEN
    INSERT INTO auth_email_outbox(id, user_id, organization_id, template_type, template_data, request_id)
    SELECT gen_random_uuid(), co_owner.id, selected_organization_id, 'RECOVERY_APPROVAL',
      jsonb_build_object('recoveryRequestId', recovery_request_id), selected_request_id
    FROM organization_memberships membership
    JOIN membership_roles membership_role
      ON membership_role.organization_id = membership.organization_id AND membership_role.membership_id = membership.id
    JOIN roles role ON role.organization_id = membership_role.organization_id AND role.id = membership_role.role_id AND role.active
    JOIN role_permissions role_permission
      ON role_permission.organization_id = role.organization_id AND role_permission.role_id = role.id
    JOIN users co_owner ON co_owner.id = membership.user_id AND co_owner.active AND NOT co_owner.is_demo
    JOIN auth_mfa_factors co_owner_factor
      ON co_owner_factor.user_id = co_owner.id
     AND co_owner_factor.factor_type = 'TOTP' AND co_owner_factor.status = 'ACTIVE'
    WHERE membership.organization_id = selected_organization_id
      AND membership.user_id <> selected_user.id AND membership.active
      AND role_permission.permission_key = 'organization.recovery.manage'
    GROUP BY co_owner.id;
  END IF;

  INSERT INTO auth_security_events(user_id, organization_id, event_type, outcome, request_id, metadata)
  VALUES (selected_user.id, selected_organization_id, 'PASSWORD_RESET_REQUEST', 'SUCCESS', selected_request_id,
    jsonb_build_object('recoveryPolicy', selected_policy));
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_password_reset_challenge(selected_token_hash text)
RETURNS TABLE(
  recovery_policy text,
  available_at timestamp with time zone,
  recovery_status text,
  factor_id uuid,
  factor_secret_ciphertext text,
  factor_last_accepted_counter bigint,
  user_id uuid,
  email_ciphertext text,
  organization_name text,
  replacement_factor_id uuid,
  replacement_factor_secret_ciphertext text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT token.recovery_policy, token.available_at,
    coalesce(recovery.status, 'APPROVED'), factor.id, factor.secret_ciphertext, factor.last_accepted_counter,
    selected_user.id, selected_user.email_ciphertext, coalesce(organization.display_name, 'Business Finlynq'),
    replacement.id, replacement.secret_ciphertext
  FROM auth_one_time_tokens token
  JOIN users selected_user ON selected_user.id = token.user_id AND selected_user.active AND NOT selected_user.is_demo
  LEFT JOIN organizations organization ON organization.id = token.organization_id
  LEFT JOIN auth_recovery_requests recovery ON recovery.token_id = token.id
  LEFT JOIN LATERAL (
    SELECT selected_factor.id, selected_factor.secret_ciphertext, selected_factor.last_accepted_counter
    FROM auth_mfa_factors selected_factor
    WHERE selected_factor.user_id = token.user_id
      AND selected_factor.factor_type = 'TOTP' AND selected_factor.status = 'ACTIVE'
    ORDER BY selected_factor.verified_at DESC NULLS LAST
    LIMIT 1
  ) factor ON true
  LEFT JOIN LATERAL (
    SELECT selected_factor.id, selected_factor.secret_ciphertext
    FROM auth_mfa_factors selected_factor
    WHERE selected_factor.user_id = token.user_id
      AND selected_factor.recovery_token_id = token.id
      AND selected_factor.factor_type = 'TOTP' AND selected_factor.status = 'PENDING'
    LIMIT 1
  ) replacement ON true
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'PASSWORD_RESET'
    AND token.consumed_at IS NULL
    AND token.expires_at > now()
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_prepare_recovery_mfa(
  selected_token_hash text,
  selected_factor_id uuid,
  selected_secret_ciphertext text,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_token auth_one_time_tokens%ROWTYPE;
BEGIN
  IF length(selected_secret_ciphertext) NOT BETWEEN 20 AND 2000 OR
     length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid recovery MFA setup request' USING ERRCODE = '22023';
  END IF;

  SELECT token.* INTO selected_token
  FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'PASSWORD_RESET'
    AND token.recovery_policy IN ('EMAIL_ONLY', 'CO_OWNER', 'DELAYED')
    AND token.consumed_at IS NULL AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL THEN RETURN false; END IF;
  IF selected_token.recovery_policy = 'DELAYED' AND selected_token.available_at > now() THEN RETURN false; END IF;
  IF selected_token.recovery_policy = 'CO_OWNER' AND (
    selected_token.recovery_authorized_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM auth_recovery_requests recovery
      WHERE recovery.token_id = selected_token.id AND recovery.status = 'APPROVED'
    )
  ) THEN RETURN false; END IF;

  UPDATE auth_mfa_factors
  SET status = 'REVOKED', revoked_at = now()
  WHERE user_id = selected_token.user_id AND factor_type = 'TOTP' AND status = 'PENDING';
  INSERT INTO auth_mfa_factors(
    id, user_id, recovery_token_id, factor_type, label, secret_ciphertext, status
  ) VALUES (
    selected_factor_id, selected_token.user_id, selected_token.id,
    'TOTP', 'Authenticator', selected_secret_ciphertext, 'PENDING'
  );
  INSERT INTO auth_security_events(user_id, organization_id, event_type, outcome, request_id)
  VALUES (selected_token.user_id, selected_token.organization_id,
    'PASSWORD_RESET_MFA_PREPARED', 'SUCCESS', selected_request_id);
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_authorize_password_reset_totp(
  selected_token_hash text,
  selected_factor_id uuid,
  selected_totp_counter bigint,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_token_id uuid;
  selected_user_id uuid;
BEGIN
  SELECT token.id, token.user_id INTO selected_token_id, selected_user_id
  FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_token_hash AND token.purpose = 'PASSWORD_RESET'
    AND token.recovery_policy = 'TOTP' AND token.consumed_at IS NULL
    AND token.available_at <= now() AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token_id IS NULL THEN RETURN false; END IF;

  UPDATE auth_mfa_factors factor SET last_accepted_counter = selected_totp_counter
  WHERE factor.id = selected_factor_id AND factor.user_id = selected_user_id
    AND factor.status = 'ACTIVE'
    AND selected_totp_counter > coalesce(factor.last_accepted_counter, -1);
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE auth_one_time_tokens SET recovery_authorized_at = now()
  WHERE id = selected_token_id;
  UPDATE auth_recovery_requests SET status = 'APPROVED', approved_at = now()
  WHERE token_id = selected_token_id AND status = 'PENDING';
  INSERT INTO auth_security_events(user_id, event_type, outcome, request_id)
  VALUES (selected_user_id, 'PASSWORD_RESET_MFA', 'SUCCESS', selected_request_id);
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_escalate_password_reset(
  selected_token_hash text,
  selected_request_id text
)
RETURNS TABLE(recovery_policy text, available_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_token auth_one_time_tokens%ROWTYPE;
  selected_recovery_id uuid;
  selected_policy text;
  selected_available_at timestamp with time zone;
  selected_expires_at timestamp with time zone;
  has_co_owner boolean;
BEGIN
  SELECT token.* INTO selected_token
  FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_token_hash AND token.purpose = 'PASSWORD_RESET'
    AND token.recovery_policy = 'TOTP' AND token.consumed_at IS NULL AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL THEN RETURN; END IF;

  SELECT EXISTS (
    SELECT 1
    FROM organization_memberships membership
    JOIN membership_roles membership_role
      ON membership_role.organization_id = membership.organization_id AND membership_role.membership_id = membership.id
    JOIN roles role ON role.organization_id = membership_role.organization_id AND role.id = membership_role.role_id AND role.active
    JOIN role_permissions role_permission
      ON role_permission.organization_id = role.organization_id AND role_permission.role_id = role.id
    JOIN users co_owner ON co_owner.id = membership.user_id AND co_owner.active AND NOT co_owner.is_demo
    JOIN auth_mfa_factors co_owner_factor
      ON co_owner_factor.user_id = co_owner.id
     AND co_owner_factor.factor_type = 'TOTP' AND co_owner_factor.status = 'ACTIVE'
    WHERE membership.organization_id = selected_token.organization_id
      AND membership.user_id <> selected_token.user_id AND membership.active
      AND role_permission.permission_key = 'organization.recovery.manage'
  ) INTO has_co_owner;

  IF has_co_owner THEN
    selected_policy := 'CO_OWNER';
    selected_available_at := now();
    selected_expires_at := now() + interval '24 hours';
  ELSE
    selected_policy := 'DELAYED';
    selected_available_at := now() + interval '72 hours';
    selected_expires_at := now() + interval '96 hours';
  END IF;

  UPDATE auth_one_time_tokens token
  SET recovery_policy = selected_policy, available_at = selected_available_at,
      expires_at = selected_expires_at, recovery_authorized_at = NULL, recovery_authorized_by = NULL
  WHERE token.id = selected_token.id;
  UPDATE auth_recovery_requests recovery
  SET policy = selected_policy, status = 'PENDING', approved_by_user_id = NULL,
      approved_at = NULL, expires_at = selected_expires_at
  WHERE recovery.token_id = selected_token.id
  RETURNING recovery.id INTO selected_recovery_id;

  IF selected_policy = 'CO_OWNER' THEN
    INSERT INTO auth_email_outbox(id, user_id, organization_id, template_type, template_data, request_id)
    SELECT gen_random_uuid(), co_owner.id, selected_token.organization_id, 'RECOVERY_APPROVAL',
      jsonb_build_object('recoveryRequestId', selected_recovery_id), selected_request_id
    FROM organization_memberships membership
    JOIN membership_roles membership_role
      ON membership_role.organization_id = membership.organization_id AND membership_role.membership_id = membership.id
    JOIN roles role ON role.organization_id = membership_role.organization_id AND role.id = membership_role.role_id AND role.active
    JOIN role_permissions role_permission
      ON role_permission.organization_id = role.organization_id AND role_permission.role_id = role.id
    JOIN users co_owner ON co_owner.id = membership.user_id AND co_owner.active AND NOT co_owner.is_demo
    JOIN auth_mfa_factors co_owner_factor
      ON co_owner_factor.user_id = co_owner.id
     AND co_owner_factor.factor_type = 'TOTP' AND co_owner_factor.status = 'ACTIVE'
    WHERE membership.organization_id = selected_token.organization_id
      AND membership.user_id <> selected_token.user_id AND membership.active
      AND role_permission.permission_key = 'organization.recovery.manage'
    GROUP BY co_owner.id;
  END IF;
  INSERT INTO auth_email_outbox(id, user_id, organization_id, template_type, template_data, request_id)
  VALUES (gen_random_uuid(), selected_token.user_id, selected_token.organization_id,
    'SECURITY_RECOVERY_ESCALATED', jsonb_build_object('policy', selected_policy, 'availableAt', selected_available_at), selected_request_id);
  INSERT INTO auth_security_events(user_id, organization_id, event_type, outcome, request_id, metadata)
  VALUES (selected_token.user_id, selected_token.organization_id, 'PASSWORD_RESET_ESCALATED', 'SUCCESS',
    selected_request_id, jsonb_build_object('recoveryPolicy', selected_policy));
  RETURN QUERY SELECT selected_policy, selected_available_at;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_approve_recovery(
  selected_recovery_request_id uuid,
  selected_actor_session_id uuid,
  selected_factor_id uuid,
  selected_totp_counter bigint,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_actor_id uuid;
  selected_target_id uuid;
  selected_organization_id uuid;
  selected_token_id uuid;
BEGIN
  SELECT session.user_id, recovery.user_id, recovery.organization_id, recovery.token_id
    INTO selected_actor_id, selected_target_id, selected_organization_id, selected_token_id
  FROM auth_recovery_requests recovery
  JOIN auth_sessions session
    ON session.id = selected_actor_session_id
   AND session.organization_id = recovery.organization_id
   AND session.session_mode = 'REAL'
   AND session.revoked_at IS NULL AND session.idle_expires_at > now() AND session.expires_at > now()
  WHERE recovery.id = selected_recovery_request_id
    AND recovery.policy = 'CO_OWNER' AND recovery.status = 'PENDING'
    AND recovery.expires_at > now() AND session.user_id <> recovery.user_id
  FOR UPDATE OF recovery, session;
  IF selected_actor_id IS NULL THEN RETURN false; END IF;

  PERFORM 1
  FROM organization_memberships membership
  JOIN membership_roles membership_role
    ON membership_role.organization_id = membership.organization_id AND membership_role.membership_id = membership.id
  JOIN roles role ON role.organization_id = membership_role.organization_id AND role.id = membership_role.role_id AND role.active
  JOIN role_permissions role_permission
    ON role_permission.organization_id = role.organization_id AND role_permission.role_id = role.id
  WHERE membership.organization_id = selected_organization_id
    AND membership.user_id = selected_actor_id AND membership.active
    AND role_permission.permission_key = 'organization.recovery.manage';
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE auth_mfa_factors factor SET last_accepted_counter = selected_totp_counter
  WHERE factor.id = selected_factor_id AND factor.user_id = selected_actor_id
    AND factor.status = 'ACTIVE'
    AND selected_totp_counter > coalesce(factor.last_accepted_counter, -1);
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE auth_recovery_requests
  SET status = 'APPROVED', approved_by_user_id = selected_actor_id, approved_at = now()
  WHERE id = selected_recovery_request_id;
  UPDATE auth_one_time_tokens
  SET recovery_authorized_at = now(), recovery_authorized_by = selected_actor_id
  WHERE id = selected_token_id;
  UPDATE auth_sessions SET mfa_verified_at = now(), step_up_expires_at = now() + interval '10 minutes'
  WHERE id = selected_actor_session_id;
  INSERT INTO auth_security_events(user_id, organization_id, session_id, event_type, outcome, request_id,
    metadata)
  VALUES (selected_actor_id, selected_organization_id, selected_actor_session_id,
    'RECOVERY_APPROVAL', 'SUCCESS', selected_request_id,
    jsonb_build_object('targetUserId', selected_target_id, 'recoveryRequestId', selected_recovery_request_id));
  RETURN true;
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
  selected_token auth_one_time_tokens%ROWTYPE;
BEGIN
  IF length(selected_password_hash) NOT BETWEEN 40 AND 1000 OR
     selected_password_hash NOT LIKE 'scrypt-v1$32768$8$1$%' THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = '22023';
  END IF;

  SELECT token.* INTO selected_token
  FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_token_hash AND token.purpose = 'PASSWORD_RESET'
    AND token.recovery_policy = 'TOTP'
    AND token.consumed_at IS NULL AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL THEN RETURN false; END IF;
  IF selected_token.recovery_authorized_at IS NULL THEN RETURN false; END IF;

  UPDATE auth_one_time_tokens SET consumed_at = now() WHERE id = selected_token.id;
  UPDATE users SET password_hash = selected_password_hash, password_changed_at = now()
  WHERE id = selected_token.user_id AND active AND NOT is_demo;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
  WHERE user_id = selected_token.user_id AND revoked_at IS NULL;
  UPDATE auth_recovery_requests SET status = 'CONSUMED'
  WHERE token_id = selected_token.id AND status IN ('PENDING', 'APPROVED');
  INSERT INTO auth_security_events(user_id, organization_id, event_type, outcome, request_id)
  VALUES (selected_token.user_id, selected_token.organization_id, 'PASSWORD_RESET_COMPLETE', 'SUCCESS', selected_request_id);
  INSERT INTO auth_email_outbox(id, user_id, organization_id, template_type, request_id)
  VALUES (gen_random_uuid(), selected_token.user_id, selected_token.organization_id, 'SECURITY_PASSWORD_CHANGED', selected_request_id);
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_finish_password_reset_with_mfa(
  selected_token_hash text,
  selected_password_hash text,
  selected_factor_id uuid,
  selected_totp_counter bigint,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_token auth_one_time_tokens%ROWTYPE;
BEGIN
  IF length(selected_password_hash) NOT BETWEEN 40 AND 1000 OR
     selected_password_hash NOT LIKE 'scrypt-v1$32768$8$1$%' OR
     selected_totp_counter < 0 THEN
    RAISE EXCEPTION 'Invalid protected password-reset completion' USING ERRCODE = '22023';
  END IF;

  SELECT token.* INTO selected_token
  FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_token_hash AND token.purpose = 'PASSWORD_RESET'
    AND token.recovery_policy IN ('EMAIL_ONLY', 'CO_OWNER', 'DELAYED')
    AND token.consumed_at IS NULL AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL THEN RETURN false; END IF;
  IF selected_token.recovery_policy = 'DELAYED' AND selected_token.available_at > now() THEN RETURN false; END IF;
  IF selected_token.recovery_policy = 'CO_OWNER' AND (
    selected_token.recovery_authorized_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM auth_recovery_requests recovery
      WHERE recovery.token_id = selected_token.id AND recovery.status = 'APPROVED'
    )
  ) THEN RETURN false; END IF;

  PERFORM 1 FROM users selected_user
  WHERE selected_user.id = selected_token.user_id AND selected_user.active AND NOT selected_user.is_demo
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM auth_mfa_factors factor
  WHERE factor.id = selected_factor_id
    AND factor.user_id = selected_token.user_id
    AND factor.recovery_token_id = selected_token.id
    AND factor.factor_type = 'TOTP' AND factor.status = 'PENDING'
    AND selected_totp_counter > coalesce(factor.last_accepted_counter, -1)
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE auth_one_time_tokens SET consumed_at = now() WHERE id = selected_token.id;
  UPDATE auth_mfa_factors
  SET status = 'REVOKED', revoked_at = now()
  WHERE user_id = selected_token.user_id AND factor_type = 'TOTP'
    AND id <> selected_factor_id AND status IN ('ACTIVE', 'PENDING');
  UPDATE auth_mfa_factors
  SET status = 'ACTIVE', verified_at = now(), revoked_at = NULL,
      last_accepted_counter = selected_totp_counter
  WHERE id = selected_factor_id;
  UPDATE users SET password_hash = selected_password_hash, password_changed_at = now()
  WHERE id = selected_token.user_id;
  UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
  WHERE user_id = selected_token.user_id AND revoked_at IS NULL;
  UPDATE auth_recovery_requests SET status = 'CONSUMED'
  WHERE token_id = selected_token.id AND status IN ('PENDING', 'APPROVED');
  INSERT INTO auth_security_events(user_id, organization_id, event_type, outcome, request_id,
    metadata)
  VALUES (selected_token.user_id, selected_token.organization_id,
    'PASSWORD_RESET_MFA_REPLACED', 'SUCCESS', selected_request_id,
    jsonb_build_object('factorId', selected_factor_id));
  INSERT INTO auth_email_outbox(id, user_id, organization_id, template_type, request_id)
  VALUES
    (gen_random_uuid(), selected_token.user_id, selected_token.organization_id, 'SECURITY_PASSWORD_CHANGED', selected_request_id),
    (gen_random_uuid(), selected_token.user_id, selected_token.organization_id, 'SECURITY_MFA_REPLACED', selected_request_id);
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_accept_invitation(
  selected_token_hash text,
  selected_password_hash text,
  selected_factor_id uuid,
  selected_factor_secret_ciphertext text,
  selected_setup_token_hash text,
  selected_request_id text
)
RETURNS TABLE(user_id uuid, email_ciphertext text, organization_name text, factor_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_token auth_one_time_tokens%ROWTYPE;
  selected_organization_name text;
  selected_email_ciphertext text;
BEGIN
  IF selected_password_hash NOT LIKE 'scrypt-v1$32768$8$1$%' OR
     length(selected_factor_secret_ciphertext) NOT BETWEEN 40 AND 1000 OR
     length(selected_setup_token_hash) < 32 THEN
    RAISE EXCEPTION 'Invalid invitation acceptance request' USING ERRCODE = '22023';
  END IF;
  SELECT token.* INTO selected_token FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_token_hash AND token.purpose = 'INVITATION'
    AND token.consumed_at IS NULL AND token.available_at <= now() AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL OR selected_token.organization_id IS NULL THEN RETURN; END IF;

  SELECT selected_user.email_ciphertext, organization.display_name
    INTO selected_email_ciphertext, selected_organization_name
  FROM users selected_user
  JOIN organization_memberships membership
    ON membership.user_id = selected_user.id AND membership.organization_id = selected_token.organization_id
  JOIN organizations organization
    ON organization.id = membership.organization_id AND organization.active AND NOT organization.is_demo
  WHERE selected_user.id = selected_token.user_id AND NOT selected_user.is_demo;
  IF selected_email_ciphertext IS NULL THEN RETURN; END IF;

  UPDATE auth_one_time_tokens invitation_token SET consumed_at = now()
  WHERE invitation_token.id = selected_token.id;
  UPDATE auth_mfa_factors revoked_factor SET status = 'REVOKED', revoked_at = now()
  WHERE revoked_factor.user_id = selected_token.user_id AND revoked_factor.status IN ('PENDING', 'ACTIVE');
  UPDATE users invited_user SET password_hash = selected_password_hash, password_changed_at = now(),
    email_verified_at = coalesce(invited_user.email_verified_at, now()), mfa_required = true, active = false
  WHERE invited_user.id = selected_token.user_id;
  INSERT INTO auth_mfa_factors(id, user_id, factor_type, label, secret_ciphertext, status)
  VALUES (selected_factor_id, selected_token.user_id, 'TOTP', 'Primary authenticator', selected_factor_secret_ciphertext, 'PENDING');
  INSERT INTO auth_one_time_tokens(token_hash, purpose, user_id, organization_id, expires_at)
  VALUES (selected_setup_token_hash, 'MFA_SETUP', selected_token.user_id, selected_token.organization_id, now() + interval '15 minutes');
  INSERT INTO auth_security_events(user_id, organization_id, event_type, outcome, request_id)
  VALUES (selected_token.user_id, selected_token.organization_id, 'INVITATION_ACCEPTED', 'SUCCESS', selected_request_id);
  RETURN QUERY SELECT selected_token.user_id, selected_email_ciphertext, selected_organization_name, selected_factor_id;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_mfa_setup_challenge(selected_setup_token_hash text)
RETURNS TABLE(user_id uuid, organization_id uuid, factor_id uuid, factor_secret_ciphertext text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT token.user_id, token.organization_id, factor.id, factor.secret_ciphertext
  FROM auth_one_time_tokens token
  JOIN auth_mfa_factors factor ON factor.user_id = token.user_id AND factor.status = 'PENDING'
  WHERE token.token_hash = selected_setup_token_hash AND token.purpose = 'MFA_SETUP'
    AND token.consumed_at IS NULL AND token.expires_at > now()
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_finish_mfa_enrollment(
  selected_setup_token_hash text,
  selected_factor_id uuid,
  selected_totp_counter bigint,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_token auth_one_time_tokens%ROWTYPE;
BEGIN
  SELECT token.* INTO selected_token FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_setup_token_hash AND token.purpose = 'MFA_SETUP'
    AND token.consumed_at IS NULL AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL OR selected_token.organization_id IS NULL THEN RETURN false; END IF;

  UPDATE auth_mfa_factors factor
  SET status = 'ACTIVE', verified_at = now(), last_accepted_counter = selected_totp_counter
  WHERE factor.id = selected_factor_id AND factor.user_id = selected_token.user_id AND factor.status = 'PENDING';
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE auth_one_time_tokens SET consumed_at = now() WHERE id = selected_token.id;
  UPDATE users SET active = true WHERE id = selected_token.user_id AND NOT is_demo;
  UPDATE organization_memberships SET active = true
  WHERE user_id = selected_token.user_id AND organization_id = selected_token.organization_id;
  INSERT INTO auth_security_events(user_id, organization_id, event_type, outcome, request_id)
  VALUES (selected_token.user_id, selected_token.organization_id, 'MFA_ENROLLED', 'SUCCESS', selected_request_id);
  INSERT INTO auth_email_outbox(id, user_id, organization_id, template_type, request_id)
  VALUES (gen_random_uuid(), selected_token.user_id, selected_token.organization_id, 'SECURITY_MFA_ENABLED', selected_request_id);
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_totp_for_session(selected_session_id uuid)
RETURNS TABLE(factor_id uuid, factor_secret_ciphertext text, factor_last_accepted_counter bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT factor.id, factor.secret_ciphertext, factor.last_accepted_counter
  FROM auth_sessions session
  JOIN auth_mfa_factors factor ON factor.user_id = session.user_id
    AND factor.factor_type = 'TOTP' AND factor.status = 'ACTIVE'
  WHERE session.id = selected_session_id AND session.session_mode = 'REAL'
    AND session.revoked_at IS NULL AND session.idle_expires_at > now() AND session.expires_at > now()
  ORDER BY factor.verified_at DESC NULLS LAST
  LIMIT 1
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_mark_step_up(
  selected_session_id uuid,
  selected_factor_id uuid,
  selected_totp_counter bigint,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE selected_user_id uuid; selected_organization_id uuid;
BEGIN
  SELECT user_id, organization_id INTO selected_user_id, selected_organization_id
  FROM auth_sessions
  WHERE id = selected_session_id AND session_mode = 'REAL' AND revoked_at IS NULL
    AND idle_expires_at > now() AND expires_at > now()
  FOR UPDATE;
  IF selected_user_id IS NULL THEN RETURN false; END IF;
  UPDATE auth_mfa_factors SET last_accepted_counter = selected_totp_counter
  WHERE id = selected_factor_id AND user_id = selected_user_id AND status = 'ACTIVE'
    AND selected_totp_counter > coalesce(last_accepted_counter, -1);
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE auth_sessions SET mfa_verified_at = now(), step_up_expires_at = now() + interval '10 minutes'
  WHERE id = selected_session_id;
  INSERT INTO auth_security_events(user_id, organization_id, session_id, event_type, outcome, request_id)
  VALUES (selected_user_id, selected_organization_id, selected_session_id, 'MFA_STEP_UP', 'SUCCESS', selected_request_id);
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_claim_email_delivery(selected_worker_id uuid)
RETURNS TABLE(
  outbox_id uuid,
  user_id uuid,
  email_ciphertext text,
  template_type text,
  payload_ciphertext text,
  template_data jsonb,
  attempt integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE selected_outbox_id uuid;
BEGIN
  DELETE FROM auth_email_outbox
  WHERE id IN (
    SELECT id FROM auth_email_outbox WHERE status = 'SENT' AND sent_at < now() - interval '30 days'
    ORDER BY sent_at LIMIT 100
  );
  SELECT candidate.id INTO selected_outbox_id
  FROM auth_email_outbox candidate
  WHERE candidate.attempts < 8 AND candidate.available_at <= now()
    AND (candidate.status = 'PENDING' OR
      (candidate.status = 'SENDING' AND candidate.lease_expires_at < now()))
  ORDER BY candidate.created_at
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF selected_outbox_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE auth_email_outbox outbox
  SET status = 'SENDING', attempts = outbox.attempts + 1,
      lease_owner = selected_worker_id, lease_expires_at = now() + interval '2 minutes'
  FROM users selected_user
  WHERE outbox.id = selected_outbox_id AND selected_user.id = outbox.user_id
  RETURNING outbox.id, outbox.user_id, selected_user.email_ciphertext,
    outbox.template_type, outbox.payload_ciphertext, outbox.template_data, outbox.attempts;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_complete_email_delivery(
  selected_outbox_id uuid,
  selected_worker_id uuid,
  selected_provider_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE auth_email_outbox SET status = 'SENT', sent_at = now(),
    provider_message_id = left(selected_provider_message_id, 200), lease_owner = NULL,
    lease_expires_at = NULL, last_error_code = NULL
  WHERE id = selected_outbox_id AND status = 'SENDING' AND lease_owner = selected_worker_id;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_fail_email_delivery(
  selected_outbox_id uuid,
  selected_worker_id uuid,
  selected_error_code text,
  selected_retryable boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE selected_user_id uuid; selected_request_id text; selected_attempts integer;
BEGIN
  UPDATE auth_email_outbox
  SET status = CASE WHEN selected_retryable AND attempts < 8 THEN 'PENDING' ELSE 'DEAD' END,
      available_at = CASE WHEN selected_retryable AND attempts < 8
        THEN now() + make_interval(secs => least(3600, (30 * power(2, greatest(0, attempts - 1)))::integer))
        ELSE available_at END,
      lease_owner = NULL, lease_expires_at = NULL, last_error_code = left(selected_error_code, 80)
  WHERE id = selected_outbox_id AND status = 'SENDING' AND lease_owner = selected_worker_id
  RETURNING user_id, request_id, attempts INTO selected_user_id, selected_request_id, selected_attempts;
  IF selected_user_id IS NULL THEN RETURN false; END IF;
  IF NOT selected_retryable OR selected_attempts >= 8 THEN
    INSERT INTO auth_security_events(user_id, event_type, outcome, request_id, metadata)
    VALUES (selected_user_id, 'EMAIL_DELIVERY', 'FAILURE', selected_request_id,
      jsonb_build_object('outboxId', selected_outbox_id, 'errorCode', left(selected_error_code, 80)));
  END IF;
  RETURN true;
END
$$;
--> statement-breakpoint

REVOKE ALL ON auth_mfa_factors, auth_recovery_requests, auth_email_outbox FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.auth_prepare_password_reset(text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.auth_issue_user_session(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.auth_lookup_login(text), app.auth_resolve_session(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  app.auth_lookup_login_v2(text),
  app.auth_issue_mfa_user_session(uuid, uuid, uuid, uuid, bigint, text, text, text, text),
  app.auth_resolve_session_v2(text, text),
  app.auth_queue_password_reset(text, text, text, uuid, text, text),
  app.auth_password_reset_challenge(text),
  app.auth_prepare_recovery_mfa(text, uuid, text, text),
  app.auth_authorize_password_reset_totp(text, uuid, bigint, text),
  app.auth_finish_password_reset_with_mfa(text, text, uuid, bigint, text),
  app.auth_escalate_password_reset(text, text),
  app.auth_approve_recovery(uuid, uuid, uuid, bigint, text),
  app.auth_accept_invitation(text, text, uuid, text, text, text),
  app.auth_mfa_setup_challenge(text),
  app.auth_finish_mfa_enrollment(text, uuid, bigint, text),
  app.auth_totp_for_session(uuid),
  app.auth_mark_step_up(uuid, uuid, bigint, text),
  app.auth_claim_email_delivery(uuid),
  app.auth_complete_email_delivery(uuid, uuid, text),
  app.auth_fail_email_delivery(uuid, uuid, text, boolean)
FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON auth_mfa_factors, auth_recovery_requests, auth_email_outbox FROM business_finlynq_app;
    REVOKE EXECUTE ON FUNCTION app.auth_prepare_password_reset(text, text, text, text) FROM business_finlynq_app;
    REVOKE EXECUTE ON FUNCTION app.auth_issue_user_session(uuid, uuid, uuid, text, text, text, text) FROM business_finlynq_app;
    REVOKE EXECUTE ON FUNCTION app.auth_lookup_login(text), app.auth_resolve_session(text, text) FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION
      app.auth_lookup_login_v2(text),
      app.auth_issue_mfa_user_session(uuid, uuid, uuid, uuid, bigint, text, text, text, text),
      app.auth_resolve_session_v2(text, text),
      app.auth_queue_password_reset(text, text, text, uuid, text, text),
      app.auth_password_reset_challenge(text),
      app.auth_prepare_recovery_mfa(text, uuid, text, text),
      app.auth_authorize_password_reset_totp(text, uuid, bigint, text),
      app.auth_finish_password_reset_with_mfa(text, text, uuid, bigint, text),
      app.auth_escalate_password_reset(text, text),
      app.auth_approve_recovery(uuid, uuid, uuid, bigint, text),
      app.auth_accept_invitation(text, text, uuid, text, text, text),
      app.auth_mfa_setup_challenge(text),
      app.auth_finish_mfa_enrollment(text, uuid, bigint, text),
      app.auth_totp_for_session(uuid),
      app.auth_mark_step_up(uuid, uuid, bigint, text)
    TO business_finlynq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_auth_worker') THEN
    REVOKE ALL ON auth_sessions, auth_one_time_tokens, auth_rate_limits, auth_security_events,
      auth_mfa_factors, auth_recovery_requests, auth_email_outbox
    FROM business_finlynq_auth_worker;
    GRANT USAGE ON SCHEMA app TO business_finlynq_auth_worker;
    GRANT EXECUTE ON FUNCTION
      app.auth_claim_email_delivery(uuid),
      app.auth_complete_email_delivery(uuid, uuid, text),
      app.auth_fail_email_delivery(uuid, uuid, text, boolean)
    TO business_finlynq_auth_worker;
  END IF;
END
$$;
