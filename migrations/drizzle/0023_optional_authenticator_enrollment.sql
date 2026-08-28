-- Make TOTP enrollment optional for ordinary sign-in while preserving the
-- existing MFA-only step-up boundary for privileged accounting operations.
-- Password-only activation and session issuance remain atomic, audited, and
-- unavailable to users who already have an active authenticator.

CREATE OR REPLACE FUNCTION app.auth_skip_mfa_enrollment(
  selected_setup_token_hash text,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_token auth_one_time_tokens%ROWTYPE;
  selected_user users%ROWTYPE;
  completed_signup_id uuid;
  selected_email_hash text;
BEGIN
  IF length(selected_setup_token_hash) NOT BETWEEN 32 AND 200
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid MFA skip request' USING ERRCODE = '22023';
  END IF;

  SELECT selected_identity.email_lookup_hash INTO selected_email_hash
  FROM auth_one_time_tokens token
  JOIN users selected_identity ON selected_identity.id = token.user_id
  WHERE token.token_hash = selected_setup_token_hash
    AND token.purpose = 'MFA_SETUP'
    AND token.consumed_at IS NULL
    AND token.expires_at > now();
  IF selected_email_hash IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_hash, 0
  ));

  SELECT token.* INTO selected_token
  FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_setup_token_hash
    AND token.purpose = 'MFA_SETUP'
    AND token.consumed_at IS NULL
    AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL OR selected_token.organization_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT selected_identity.* INTO selected_user
  FROM users selected_identity
  WHERE selected_identity.id = selected_token.user_id
    AND NOT selected_identity.active
    AND NOT selected_identity.is_demo
    AND selected_identity.email_verified_at IS NOT NULL
    AND selected_identity.password_hash LIKE 'scrypt-v1$32768$8$1$%'
  FOR UPDATE;
  IF selected_user.id IS NULL OR EXISTS (
    SELECT 1 FROM auth_mfa_factors factor
    WHERE factor.user_id = selected_token.user_id
      AND factor.status = 'ACTIVE'
  ) THEN
    RETURN false;
  END IF;

  PERFORM 1 FROM organization_memberships membership
  WHERE membership.user_id = selected_token.user_id
  ORDER BY membership.organization_id, membership.id
  FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.user_id = selected_token.user_id
      AND membership.organization_id = selected_token.organization_id
      AND NOT membership.active
  ) OR EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.user_id = selected_token.user_id
      AND membership.organization_id <> selected_token.organization_id
      AND membership.active
  ) THEN
    RETURN false;
  END IF;

  UPDATE auth_mfa_factors factor SET
    status = 'REVOKED', revoked_at = coalesce(factor.revoked_at, now())
  WHERE factor.user_id = selected_token.user_id
    AND factor.status = 'PENDING';
  UPDATE auth_one_time_tokens SET consumed_at = now()
  WHERE id = selected_token.id;
  UPDATE users SET active = true, mfa_required = false
  WHERE id = selected_token.user_id
    AND NOT active AND NOT is_demo;
  UPDATE organization_memberships SET active = true
  WHERE user_id = selected_token.user_id
    AND organization_id = selected_token.organization_id
    AND NOT active;
  UPDATE auth_organization_signups SET
    status = 'ACTIVE', completed_at = now()
  WHERE user_id = selected_token.user_id
    AND organization_id = selected_token.organization_id
    AND status = 'ENROLLING'
  RETURNING id INTO completed_signup_id;

  INSERT INTO auth_security_events(
    user_id, organization_id, event_type, outcome, request_id, metadata
  ) VALUES (
    selected_token.user_id, selected_token.organization_id,
    'MFA_ENROLLMENT_SKIPPED', 'SUCCESS', selected_request_id,
    jsonb_build_object('passwordOnly', true)
  );
  IF completed_signup_id IS NOT NULL THEN
    INSERT INTO auth_security_events(
      user_id, organization_id, event_type, outcome, request_id, metadata
    ) VALUES (
      selected_token.user_id, selected_token.organization_id,
      'ORGANIZATION_SIGNUP_ACTIVATED', 'SUCCESS', selected_request_id,
      jsonb_build_object(
        'signupId', completed_signup_id,
        'authentication', 'PASSWORD_ONLY'
      )
    );
  END IF;
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_issue_password_user_session(
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
  IF length(selected_token_hash) < 32
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid password session issuance request'
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
    AND NOT selected_user.mfa_required
    AND NOT EXISTS (
      SELECT 1 FROM auth_mfa_factors factor
      WHERE factor.user_id = selected_user.id
        AND factor.factor_type = 'TOTP'
        AND factor.status = 'ACTIVE'
    )
  FOR UPDATE OF selected_user;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO auth_sessions(
    token_hash, user_id, organization_id, membership_id,
    auth_method, session_mode, ip_hash, user_agent_hash,
    idle_timeout_seconds, idle_expires_at, expires_at,
    mfa_verified_at, step_up_expires_at
  ) VALUES (
    selected_token_hash, selected_user_id, selected_organization_id,
    selected_membership_id, 'PASSWORD', 'REAL', selected_ip_hash,
    selected_user_agent_hash, 7200, now() + interval '2 hours',
    now() + interval '24 hours', NULL, NULL
  ) RETURNING id INTO created_session_id;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome, request_id,
    metadata
  ) VALUES (
    selected_user_id, selected_organization_id, created_session_id,
    'LOGIN_PASSWORD', 'SUCCESS', selected_request_id,
    jsonb_build_object('mfaEnabled', false)
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_mfa_status_for_session(
  selected_session_id uuid
)
RETURNS TABLE(
  mfa_required boolean,
  active_factor boolean,
  pending_enrollment boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    selected_user.mfa_required,
    EXISTS (
      SELECT 1 FROM auth_mfa_factors factor
      WHERE factor.user_id = selected_user.id
        AND factor.factor_type = 'TOTP'
        AND factor.status = 'ACTIVE'
    ),
    EXISTS (
      SELECT 1 FROM auth_mfa_factors factor
      WHERE factor.user_id = selected_user.id
        AND factor.factor_type = 'TOTP'
        AND factor.status = 'PENDING'
    )
  FROM auth_sessions selected_session
  JOIN users selected_user
    ON selected_user.id = selected_session.user_id
   AND selected_user.active
   AND NOT selected_user.is_demo
  JOIN organization_memberships membership
    ON membership.id = selected_session.membership_id
   AND membership.user_id = selected_session.user_id
   AND membership.organization_id = selected_session.organization_id
   AND membership.active
  JOIN organizations organization
    ON organization.id = selected_session.organization_id
   AND organization.active
   AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
  WHERE selected_session.id = selected_session_id
    AND selected_session.session_mode = 'REAL'
    AND selected_session.revoked_at IS NULL
    AND selected_session.expires_at > now()
    AND selected_session.idle_expires_at > now()
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_begin_session_mfa_enrollment(
  selected_session_id uuid,
  selected_factor_id uuid,
  selected_factor_secret_ciphertext text,
  selected_setup_token_hash text,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  selected_organization_id uuid;
  selected_email_hash text;
BEGIN
  IF length(selected_factor_secret_ciphertext) NOT BETWEEN 40 AND 1000
    OR length(selected_setup_token_hash) NOT BETWEEN 32 AND 200
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid session MFA enrollment request'
      USING ERRCODE = '22023';
  END IF;

  SELECT selected_user.id, selected_user.email_lookup_hash,
    selected_session.organization_id
  INTO selected_user_id, selected_email_hash, selected_organization_id
  FROM auth_sessions selected_session
  JOIN users selected_user ON selected_user.id = selected_session.user_id
  WHERE selected_session.id = selected_session_id
    AND selected_session.session_mode = 'REAL'
    AND selected_session.auth_method = 'PASSWORD'
    AND selected_session.revoked_at IS NULL
    AND selected_session.expires_at > now()
    AND selected_session.idle_expires_at > now();
  IF selected_user_id IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_hash, 0
  ));

  PERFORM 1
  FROM auth_sessions selected_session
  JOIN users selected_user
    ON selected_user.id = selected_session.user_id
   AND selected_user.active
   AND NOT selected_user.is_demo
   AND NOT selected_user.mfa_required
  JOIN organization_memberships membership
    ON membership.id = selected_session.membership_id
   AND membership.user_id = selected_session.user_id
   AND membership.organization_id = selected_session.organization_id
   AND membership.active
  JOIN organizations organization
    ON organization.id = selected_session.organization_id
   AND organization.active
   AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
  WHERE selected_session.id = selected_session_id
    AND selected_session.session_mode = 'REAL'
    AND selected_session.auth_method = 'PASSWORD'
    AND selected_session.revoked_at IS NULL
    AND selected_session.expires_at > now()
    AND selected_session.idle_expires_at > now()
    AND NOT EXISTS (
      SELECT 1 FROM auth_mfa_factors active_factor
      WHERE active_factor.user_id = selected_user.id
        AND active_factor.factor_type = 'TOTP'
        AND active_factor.status = 'ACTIVE'
    )
  FOR UPDATE OF selected_session, selected_user;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE auth_one_time_tokens SET consumed_at = coalesce(consumed_at, now())
  WHERE user_id = selected_user_id
    AND purpose = 'MFA_SETUP'
    AND consumed_at IS NULL;
  UPDATE auth_mfa_factors SET
    status = 'REVOKED', revoked_at = coalesce(revoked_at, now())
  WHERE user_id = selected_user_id
    AND status = 'PENDING';
  INSERT INTO auth_mfa_factors(
    id, user_id, factor_type, label, secret_ciphertext, status
  ) VALUES (
    selected_factor_id, selected_user_id, 'TOTP',
    'Primary authenticator', selected_factor_secret_ciphertext, 'PENDING'
  );
  INSERT INTO auth_one_time_tokens(
    token_hash, purpose, user_id, organization_id, expires_at
  ) VALUES (
    selected_setup_token_hash, 'MFA_SETUP', selected_user_id,
    selected_organization_id, now() + interval '30 minutes'
  );
  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome, request_id
  ) VALUES (
    selected_user_id, selected_organization_id, selected_session_id,
    'MFA_ENROLLMENT_STARTED', 'SUCCESS', selected_request_id
  );
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_finish_session_mfa_enrollment(
  selected_session_id uuid,
  selected_setup_token_hash text,
  selected_factor_id uuid,
  selected_totp_counter bigint,
  selected_replacement_session_token_hash text,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_token auth_one_time_tokens%ROWTYPE;
  selected_user_id uuid;
  selected_organization_id uuid;
  selected_email_hash text;
  invalidated_password_reset_count bigint := 0;
  denied_recovery_count bigint := 0;
BEGIN
  IF length(selected_setup_token_hash) NOT BETWEEN 32 AND 200
    OR selected_totp_counter < 0
    OR length(selected_replacement_session_token_hash) NOT BETWEEN 32 AND 200
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid session MFA confirmation request'
      USING ERRCODE = '22023';
  END IF;

  SELECT token.user_id, token.organization_id, selected_user.email_lookup_hash
  INTO selected_user_id, selected_organization_id, selected_email_hash
  FROM auth_one_time_tokens token
  JOIN users selected_user ON selected_user.id = token.user_id
  WHERE token.token_hash = selected_setup_token_hash
    AND token.purpose = 'MFA_SETUP'
    AND token.consumed_at IS NULL
    AND token.expires_at > now();
  IF selected_user_id IS NULL OR selected_organization_id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_hash, 0
  ));

  SELECT token.* INTO selected_token
  FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_setup_token_hash
    AND token.purpose = 'MFA_SETUP'
    AND token.user_id = selected_user_id
    AND token.organization_id = selected_organization_id
    AND token.consumed_at IS NULL
    AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL THEN RETURN false; END IF;

  PERFORM 1
  FROM auth_sessions selected_session
  JOIN users selected_user
    ON selected_user.id = selected_session.user_id
   AND selected_user.id = selected_user_id
   AND selected_user.active
   AND NOT selected_user.is_demo
   AND NOT selected_user.mfa_required
  JOIN organization_memberships membership
    ON membership.id = selected_session.membership_id
   AND membership.user_id = selected_user_id
   AND membership.organization_id = selected_organization_id
   AND membership.active
  WHERE selected_session.id = selected_session_id
    AND selected_session.organization_id = selected_organization_id
    AND selected_session.session_mode = 'REAL'
    AND selected_session.auth_method = 'PASSWORD'
    AND selected_session.revoked_at IS NULL
    AND selected_session.expires_at > now()
    AND selected_session.idle_expires_at > now()
  FOR UPDATE OF selected_session, selected_user;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM auth_mfa_factors active_factor
    WHERE active_factor.user_id = selected_user_id
      AND active_factor.factor_type = 'TOTP'
      AND active_factor.status = 'ACTIVE'
  ) THEN
    RETURN false;
  END IF;

  UPDATE auth_mfa_factors factor SET
    status = 'ACTIVE', verified_at = now(),
    last_accepted_counter = selected_totp_counter
  WHERE factor.id = selected_factor_id
    AND factor.user_id = selected_user_id
    AND factor.factor_type = 'TOTP'
    AND factor.status = 'PENDING';
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE auth_one_time_tokens SET consumed_at = now()
  WHERE id = selected_token.id;
  UPDATE users SET mfa_required = true
  WHERE id = selected_user_id AND active AND NOT is_demo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA user state changed during enrollment'
      USING ERRCODE = '40001';
  END IF;
  UPDATE auth_one_time_tokens reset_token SET consumed_at = now()
  WHERE reset_token.user_id = selected_user_id
    AND reset_token.purpose = 'PASSWORD_RESET'
    AND reset_token.consumed_at IS NULL;
  GET DIAGNOSTICS invalidated_password_reset_count = ROW_COUNT;
  UPDATE auth_recovery_requests recovery SET status = 'DENIED'
  WHERE recovery.user_id = selected_user_id
    AND recovery.status IN ('PENDING', 'APPROVED');
  GET DIAGNOSTICS denied_recovery_count = ROW_COUNT;
  UPDATE auth_mfa_factors other_factor SET
    status = 'REVOKED', revoked_at = coalesce(other_factor.revoked_at, now())
  WHERE other_factor.user_id = selected_user_id
    AND other_factor.id <> selected_factor_id
    AND other_factor.factor_type = 'TOTP'
    AND other_factor.status = 'PENDING';
  UPDATE auth_email_outbox reset_message SET
    status = 'DEAD', lease_owner = NULL, lease_expires_at = NULL,
    last_error_code = 'INVALIDATED_BY_MFA_ENROLLMENT'
  WHERE reset_message.user_id = selected_user_id
    AND reset_message.template_type = 'PASSWORD_RESET'
    AND reset_message.status IN ('PENDING', 'SENDING');
  UPDATE auth_sessions SET
    revoked_at = coalesce(revoked_at, now())
  WHERE user_id = selected_user_id
    AND id <> selected_session_id
    AND revoked_at IS NULL;
  UPDATE auth_sessions SET
    token_hash = selected_replacement_session_token_hash,
    mfa_verified_at = now(),
    step_up_expires_at = now() + interval '10 minutes'
  WHERE id = selected_session_id AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA session state changed during token rotation'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome, request_id,
    metadata
  ) VALUES (
    selected_user_id, selected_organization_id, selected_session_id,
    'MFA_ENROLLED', 'SUCCESS', selected_request_id,
    jsonb_build_object(
      'sessionTokenRotated', true,
      'invalidatedPasswordResets', invalidated_password_reset_count,
      'deniedRecoveryRequests', denied_recovery_count
    )
  );
  INSERT INTO auth_email_outbox(
    id, user_id, organization_id, template_type, request_id
  ) VALUES (
    gen_random_uuid(), selected_user_id, selected_organization_id,
    'SECURITY_MFA_ENABLED', selected_request_id
  );
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_password_for_session(
  selected_session_id uuid
)
RETURNS TABLE(user_id uuid, password_hash text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT selected_user.id, selected_user.password_hash
  FROM auth_sessions selected_session
  JOIN users selected_user
    ON selected_user.id = selected_session.user_id
   AND selected_user.active
   AND NOT selected_user.is_demo
   AND NOT selected_user.mfa_required
  JOIN organization_memberships membership
    ON membership.id = selected_session.membership_id
   AND membership.user_id = selected_session.user_id
   AND membership.organization_id = selected_session.organization_id
   AND membership.active
  JOIN organizations organization
    ON organization.id = selected_session.organization_id
   AND organization.active
   AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
  WHERE selected_session.id = selected_session_id
    AND selected_session.session_mode = 'REAL'
    AND selected_session.auth_method = 'PASSWORD'
    AND selected_session.revoked_at IS NULL
    AND selected_session.expires_at > now()
    AND selected_session.idle_expires_at > now()
    AND NOT EXISTS (
      SELECT 1 FROM auth_mfa_factors factor
      WHERE factor.user_id = selected_user.id
        AND factor.factor_type = 'TOTP'
        AND factor.status = 'ACTIVE'
    )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_record_session_reauthentication_failure(
  selected_session_id uuid,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  selected_organization_id uuid;
BEGIN
  IF length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid session reauthentication event'
      USING ERRCODE = '22023';
  END IF;
  SELECT selected_session.user_id, selected_session.organization_id
  INTO selected_user_id, selected_organization_id
  FROM auth_sessions selected_session
  JOIN users selected_user
    ON selected_user.id = selected_session.user_id
   AND selected_user.active
   AND NOT selected_user.is_demo
  WHERE selected_session.id = selected_session_id
    AND selected_session.session_mode = 'REAL'
    AND selected_session.revoked_at IS NULL
    AND selected_session.expires_at > now()
    AND selected_session.idle_expires_at > now();
  IF selected_user_id IS NULL THEN RETURN false; END IF;
  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome, request_id
  ) VALUES (
    selected_user_id, selected_organization_id, selected_session_id,
    'MFA_ENROLLMENT_REAUTH', 'FAILURE', selected_request_id
  );
  RETURN true;
END
$$;
--> statement-breakpoint

-- Factorless recovery always provisions and verifies a replacement TOTP.
-- Restore the MFA-required flag atomically so the active factor and login
-- policy cannot diverge for users who originally chose password-only access.
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
  selected_email_hash text;
BEGIN
  IF length(selected_password_hash) NOT BETWEEN 40 AND 1000
    OR selected_password_hash NOT LIKE 'scrypt-v1$32768$8$1$%'
    OR selected_totp_counter < 0
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid protected password-reset completion'
      USING ERRCODE = '22023';
  END IF;

  SELECT selected_user.email_lookup_hash INTO selected_email_hash
  FROM auth_one_time_tokens token
  JOIN users selected_user ON selected_user.id = token.user_id
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'PASSWORD_RESET'
    AND token.recovery_policy IN ('EMAIL_ONLY', 'CO_OWNER', 'DELAYED')
    AND token.consumed_at IS NULL
    AND token.expires_at > now();
  IF selected_email_hash IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_hash, 0
  ));

  SELECT token.* INTO selected_token
  FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'PASSWORD_RESET'
    AND token.recovery_policy IN ('EMAIL_ONLY', 'CO_OWNER', 'DELAYED')
    AND token.consumed_at IS NULL
    AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL THEN RETURN false; END IF;
  IF selected_token.recovery_policy = 'DELAYED'
    AND selected_token.available_at > now() THEN
    RETURN false;
  END IF;
  IF selected_token.recovery_policy = 'CO_OWNER' AND (
    selected_token.recovery_authorized_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM auth_recovery_requests recovery
      WHERE recovery.token_id = selected_token.id
        AND recovery.status = 'APPROVED'
    )
  ) THEN
    RETURN false;
  END IF;

  PERFORM 1 FROM users selected_user
  WHERE selected_user.id = selected_token.user_id
    AND selected_user.active
    AND NOT selected_user.is_demo
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM auth_mfa_factors factor
  WHERE factor.id = selected_factor_id
    AND factor.user_id = selected_token.user_id
    AND factor.recovery_token_id = selected_token.id
    AND factor.factor_type = 'TOTP'
    AND factor.status = 'PENDING'
    AND selected_totp_counter > coalesce(factor.last_accepted_counter, -1)
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE auth_one_time_tokens token SET consumed_at = now()
  WHERE token.user_id = selected_token.user_id
    AND token.purpose IN ('PASSWORD_RESET', 'MFA_SETUP')
    AND token.consumed_at IS NULL;
  UPDATE auth_recovery_requests recovery SET
    status = CASE
      WHEN recovery.token_id = selected_token.id THEN 'CONSUMED'
      ELSE 'DENIED'
    END
  WHERE recovery.user_id = selected_token.user_id
    AND recovery.status IN ('PENDING', 'APPROVED');
  UPDATE auth_mfa_factors factor SET
    status = 'REVOKED', revoked_at = coalesce(factor.revoked_at, now())
  WHERE factor.user_id = selected_token.user_id
    AND factor.factor_type = 'TOTP'
    AND factor.id <> selected_factor_id
    AND factor.status IN ('ACTIVE', 'PENDING');
  UPDATE auth_mfa_factors factor SET
    status = 'ACTIVE', verified_at = now(), revoked_at = NULL,
    last_accepted_counter = selected_totp_counter
  WHERE factor.id = selected_factor_id
    AND factor.user_id = selected_token.user_id
    AND factor.status = 'PENDING';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recovery factor state changed during activation'
      USING ERRCODE = '40001';
  END IF;
  UPDATE users selected_user SET
    password_hash = selected_password_hash,
    password_changed_at = now(),
    mfa_required = true
  WHERE selected_user.id = selected_token.user_id
    AND selected_user.active
    AND NOT selected_user.is_demo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recovery user state changed during activation'
      USING ERRCODE = '40001';
  END IF;
  UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
  WHERE user_id = selected_token.user_id AND revoked_at IS NULL;

  INSERT INTO auth_security_events(
    user_id, organization_id, event_type, outcome, request_id, metadata
  ) VALUES (
    selected_token.user_id, selected_token.organization_id,
    'PASSWORD_RESET_MFA_REPLACED', 'SUCCESS', selected_request_id,
    jsonb_build_object('factorId', selected_factor_id, 'mfaRequired', true)
  );
  INSERT INTO auth_email_outbox(
    id, user_id, organization_id, template_type, request_id
  ) VALUES
    (gen_random_uuid(), selected_token.user_id, selected_token.organization_id,
      'SECURITY_PASSWORD_CHANGED', selected_request_id),
    (gen_random_uuid(), selected_token.user_id, selected_token.organization_id,
      'SECURITY_MFA_REPLACED', selected_request_id);
  RETURN true;
END
$$;
--> statement-breakpoint

-- A real member may use either the reviewed MFA posture or the explicit
-- password-only posture introduced above. Keep the administrator behind the
-- existing fresh-MFA authorization boundary while rejecting any target whose
-- mfa_required flag and active-factor state disagree.
CREATE OR REPLACE FUNCTION app.organization_set_member_active(
  selected_membership_id uuid,
  expected_version integer,
  selected_active boolean
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
  selected_membership organization_memberships%ROWTYPE;
  selected_user users%ROWTYPE;
  selected_organization organizations%ROWTYPE;
  member_invitation organization_invitations%ROWTYPE;
  next_version integer;
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.members.manage', true);
  SELECT * INTO selected_organization FROM organizations
  WHERE id = administrator.organization_id FOR SHARE;
  SELECT * INTO selected_membership
  FROM organization_memberships
  WHERE id = selected_membership_id
    AND organization_id = administrator.organization_id
  FOR UPDATE;
  IF selected_membership.id IS NULL THEN
    RAISE EXCEPTION 'The organization member is unavailable' USING ERRCODE = '22023';
  END IF;
  IF selected_membership.user_id = administrator.actor_id THEN
    RAISE EXCEPTION 'Administrators cannot change their own active membership'
      USING ERRCODE = '42501';
  END IF;
  IF NOT administrator.is_demo AND EXISTS (
    SELECT 1
    FROM membership_roles assignment
    JOIN role_permissions permission_assignment
      ON permission_assignment.organization_id = assignment.organization_id
     AND permission_assignment.role_id = assignment.role_id
     AND permission_assignment.permission_key = 'organization.recovery.manage'
    WHERE assignment.organization_id = administrator.organization_id
      AND assignment.membership_id = selected_membership.id
  ) AND NOT app.organization_admin_actor_has_permission(
    administrator.organization_id, administrator.actor_id,
    'organization.recovery.manage'
  ) THEN
    RAISE EXCEPTION 'Recovery-administration permission is required for this member status change'
      USING ERRCODE = '42501';
  END IF;
  IF selected_membership.administration_version <> expected_version THEN
    RAISE EXCEPTION 'Member administration version changed by another administrator'
      USING ERRCODE = '40001';
  END IF;
  IF selected_membership.active = selected_active THEN
    RETURN selected_membership.administration_version;
  END IF;

  SELECT * INTO selected_user FROM users
  WHERE id = selected_membership.user_id FOR SHARE;
  SELECT * INTO member_invitation
  FROM organization_invitations
  WHERE organization_id = administrator.organization_id
    AND membership_id = selected_membership.id
  FOR UPDATE;

  IF NOT selected_active THEN
    IF app.organization_member_is_last_owner(
      administrator.organization_id, selected_membership.id
    ) THEN
      RAISE EXCEPTION 'The last active owner cannot be suspended'
        USING ERRCODE = '23514';
    END IF;
    IF app.organization_member_is_last_recovery_admin(
      administrator.organization_id, selected_membership.id
    ) THEN
      RAISE EXCEPTION 'The last active recovery administrator cannot be suspended'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF member_invitation.id IS NOT NULL
      AND member_invitation.status <> 'ACCEPTED' THEN
      RAISE EXCEPTION 'Only an accepted invitation membership can be reactivated'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM organization_memberships other_membership
      WHERE other_membership.user_id = selected_user.id
        AND other_membership.organization_id <> administrator.organization_id
        AND other_membership.active
    ) THEN
      RAISE EXCEPTION 'The identity already has active access to another organization'
        USING ERRCODE = '23505';
    END IF;
    IF NOT selected_user.active THEN
      RAISE EXCEPTION 'The member identity is not ready for reactivation'
        USING ERRCODE = '23514';
    END IF;
    IF selected_organization.is_demo THEN
      IF NOT selected_user.is_demo THEN
        RAISE EXCEPTION 'A real identity cannot be activated in a demo sandbox'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF selected_user.email_verified_at IS NULL THEN
        RAISE EXCEPTION 'The member must complete invitation verification first'
          USING ERRCODE = '23514';
      END IF;
      IF selected_user.mfa_required IS TRUE THEN
        IF NOT EXISTS (
          SELECT 1 FROM auth_mfa_factors factor
          WHERE factor.user_id = selected_user.id
            AND factor.factor_type = 'TOTP'
            AND factor.status = 'ACTIVE'
            AND factor.verified_at IS NOT NULL
            AND factor.revoked_at IS NULL
        ) THEN
          RAISE EXCEPTION 'The member authentication state is inconsistent'
            USING ERRCODE = '23514';
        END IF;
      ELSIF selected_user.mfa_required IS FALSE THEN
        IF selected_user.password_hash IS NULL
          OR selected_user.password_hash NOT LIKE 'scrypt-v1$32768$8$1$%'
          OR EXISTS (
            SELECT 1 FROM auth_mfa_factors factor
            WHERE factor.user_id = selected_user.id
              AND factor.factor_type = 'TOTP'
              AND factor.status = 'ACTIVE'
          ) THEN
          RAISE EXCEPTION 'The member authentication state is inconsistent'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        RAISE EXCEPTION 'The member authentication state is inconsistent'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  UPDATE organization_memberships SET
    active = selected_active,
    administration_version = administration_version + 1
  WHERE id = selected_membership.id
  RETURNING administration_version INTO next_version;
  -- Every status transition revokes the affected member's live sessions.
  UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
  WHERE organization_id = administrator.organization_id
    AND membership_id = selected_membership.id
    AND revoked_at IS NULL;

  PERFORM app.append_tenant_business_audit(
    administrator.organization_id,
    CASE WHEN selected_active
      THEN 'organization.member-reactivated'
      ELSE 'organization.member-suspended' END,
    'organization_membership',
    selected_membership.id::text,
    jsonb_build_object(
      'active', selected_active,
      'version', next_version,
      'sessionsRevoked', true
    ),
    CASE WHEN selected_active
      THEN 'organization.member-reactivated'
      ELSE 'organization.member-suspended' END
  );
  RETURN next_version;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
  app.auth_skip_mfa_enrollment(text, text),
  app.auth_issue_password_user_session(uuid, uuid, uuid, text, text, text, text),
  app.auth_mfa_status_for_session(uuid),
  app.auth_begin_session_mfa_enrollment(uuid, uuid, text, text, text),
  app.auth_finish_session_mfa_enrollment(uuid, text, uuid, bigint, text, text),
  app.auth_password_for_session(uuid),
  app.auth_record_session_reauthentication_failure(uuid, text),
  app.auth_finish_password_reset_with_mfa(text, text, uuid, bigint, text),
  app.organization_set_member_active(uuid, integer, boolean)
FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT EXECUTE ON FUNCTION
      app.auth_skip_mfa_enrollment(text, text),
      app.auth_issue_password_user_session(uuid, uuid, uuid, text, text, text, text),
      app.auth_mfa_status_for_session(uuid),
      app.auth_begin_session_mfa_enrollment(uuid, uuid, text, text, text),
      app.auth_finish_session_mfa_enrollment(uuid, text, uuid, bigint, text, text),
      app.auth_password_for_session(uuid),
      app.auth_record_session_reauthentication_failure(uuid, text),
      app.auth_finish_password_reset_with_mfa(text, text, uuid, bigint, text),
      app.organization_set_member_active(uuid, integer, boolean)
    TO business_finlynq_app;
  END IF;
END
$$;
--> statement-breakpoint
