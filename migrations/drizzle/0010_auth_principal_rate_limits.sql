-- Authentication factors must never be protected only by an IP address. Each
-- function below consumes every applicable durable budget in one database
-- statement, so rotating source addresses cannot expand a session, user, or
-- opaque-token attempt allowance.

CREATE OR REPLACE FUNCTION app.auth_consume_mfa_step_up_limits(selected_session_id uuid)
RETURNS TABLE(allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  session_allowed boolean;
  session_retry integer;
  user_allowed boolean := false;
  user_retry integer := 0;
BEGIN
  IF selected_session_id IS NULL THEN
    RETURN QUERY SELECT false, 900;
    RETURN;
  END IF;

  SELECT session.user_id INTO selected_user_id
  FROM auth_sessions session
  WHERE session.id = selected_session_id AND session.session_mode = 'REAL';

  SELECT decision.allowed, decision.retry_after_seconds
    INTO session_allowed, session_retry
  FROM app.auth_consume_rate_limit(
    'mfa-step-up-session-15m',
    md5('business-finlynq|mfa-step-up|session|' || selected_session_id::text),
    8,
    900
  ) decision;

  IF selected_user_id IS NOT NULL THEN
    SELECT decision.allowed, decision.retry_after_seconds
      INTO user_allowed, user_retry
    FROM app.auth_consume_rate_limit(
      'mfa-step-up-user-day',
      md5('business-finlynq|mfa-step-up|user|' || selected_user_id::text),
      30,
      86400
    ) decision;
  END IF;

  RETURN QUERY SELECT
    coalesce(session_allowed, false) AND user_allowed,
    greatest(coalesce(session_retry, 900), user_retry);
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_consume_password_reset_limits(selected_token_hash text)
RETURNS TABLE(allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  token_allowed boolean;
  token_retry integer;
  user_allowed boolean := true;
  user_retry integer := 0;
BEGIN
  IF selected_token_hash IS NULL OR length(selected_token_hash) NOT BETWEEN 32 AND 200 THEN
    RETURN QUERY SELECT false, 3600;
    RETURN;
  END IF;

  SELECT token.user_id INTO selected_user_id
  FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_token_hash AND token.purpose = 'PASSWORD_RESET'
    AND token.consumed_at IS NULL AND token.expires_at > now();

  SELECT decision.allowed, decision.retry_after_seconds
    INTO token_allowed, token_retry
  FROM app.auth_consume_rate_limit(
    'password-reset-token-hour', selected_token_hash, 8, 3600
  ) decision;

  IF selected_user_id IS NOT NULL THEN
    SELECT decision.allowed, decision.retry_after_seconds
      INTO user_allowed, user_retry
    FROM app.auth_consume_rate_limit(
      'password-reset-user-day',
      md5('business-finlynq|password-reset|user|' || selected_user_id::text),
      20,
      86400
    ) decision;
  END IF;

  RETURN QUERY SELECT
    coalesce(token_allowed, false) AND user_allowed,
    greatest(coalesce(token_retry, 3600), user_retry);
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_consume_password_reset_escalation_limits(selected_token_hash text)
RETURNS TABLE(allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  token_allowed boolean;
  token_retry integer;
  user_allowed boolean := true;
  user_retry integer := 0;
BEGIN
  IF selected_token_hash IS NULL OR length(selected_token_hash) NOT BETWEEN 32 AND 200 THEN
    RETURN QUERY SELECT false, 86400;
    RETURN;
  END IF;

  SELECT token.user_id INTO selected_user_id
  FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_token_hash AND token.purpose = 'PASSWORD_RESET'
    AND token.consumed_at IS NULL AND token.expires_at > now();

  SELECT decision.allowed, decision.retry_after_seconds
    INTO token_allowed, token_retry
  FROM app.auth_consume_rate_limit(
    'password-reset-escalation-token-day', selected_token_hash, 3, 86400
  ) decision;

  IF selected_user_id IS NOT NULL THEN
    SELECT decision.allowed, decision.retry_after_seconds
      INTO user_allowed, user_retry
    FROM app.auth_consume_rate_limit(
      'password-reset-escalation-user-day',
      md5('business-finlynq|password-reset-escalation|user|' || selected_user_id::text),
      5,
      86400
    ) decision;
  END IF;

  RETURN QUERY SELECT
    coalesce(token_allowed, false) AND user_allowed,
    greatest(coalesce(token_retry, 86400), user_retry);
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_consume_recovery_approval_limits(
  selected_session_id uuid,
  selected_recovery_request_id uuid
)
RETURNS TABLE(allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  session_allowed boolean;
  session_retry integer;
  user_allowed boolean := false;
  user_retry integer := 0;
  request_allowed boolean;
  request_retry integer;
BEGIN
  IF selected_session_id IS NULL OR selected_recovery_request_id IS NULL THEN
    RETURN QUERY SELECT false, 3600;
    RETURN;
  END IF;

  SELECT session.user_id INTO selected_user_id
  FROM auth_sessions session
  WHERE session.id = selected_session_id AND session.session_mode = 'REAL';

  SELECT decision.allowed, decision.retry_after_seconds
    INTO session_allowed, session_retry
  FROM app.auth_consume_rate_limit(
    'recovery-approval-session-15m',
    md5('business-finlynq|recovery-approval|session|' || selected_session_id::text),
    8,
    900
  ) decision;
  SELECT decision.allowed, decision.retry_after_seconds
    INTO request_allowed, request_retry
  FROM app.auth_consume_rate_limit(
    'recovery-approval-request-hour',
    md5('business-finlynq|recovery-approval|request|' || selected_recovery_request_id::text),
    8,
    3600
  ) decision;

  IF selected_user_id IS NOT NULL THEN
    SELECT decision.allowed, decision.retry_after_seconds
      INTO user_allowed, user_retry
    FROM app.auth_consume_rate_limit(
      'recovery-approval-user-day',
      md5('business-finlynq|recovery-approval|user|' || selected_user_id::text),
      30,
      86400
    ) decision;
  END IF;

  RETURN QUERY SELECT
    coalesce(session_allowed, false) AND user_allowed AND coalesce(request_allowed, false),
    greatest(coalesce(session_retry, 900), user_retry, coalesce(request_retry, 3600));
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_consume_mfa_enrollment_limits(selected_setup_token_hash text)
RETURNS TABLE(allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  token_allowed boolean;
  token_retry integer;
  user_allowed boolean := true;
  user_retry integer := 0;
BEGIN
  IF selected_setup_token_hash IS NULL OR length(selected_setup_token_hash) NOT BETWEEN 32 AND 200 THEN
    RETURN QUERY SELECT false, 1800;
    RETURN;
  END IF;

  SELECT token.user_id INTO selected_user_id
  FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_setup_token_hash AND token.purpose = 'MFA_SETUP'
    AND token.consumed_at IS NULL AND token.expires_at > now();

  SELECT decision.allowed, decision.retry_after_seconds
    INTO token_allowed, token_retry
  FROM app.auth_consume_rate_limit(
    'mfa-enrollment-token-30m', selected_setup_token_hash, 8, 1800
  ) decision;

  IF selected_user_id IS NOT NULL THEN
    SELECT decision.allowed, decision.retry_after_seconds
      INTO user_allowed, user_retry
    FROM app.auth_consume_rate_limit(
      'mfa-enrollment-user-day',
      md5('business-finlynq|mfa-enrollment|user|' || selected_user_id::text),
      20,
      86400
    ) decision;
  END IF;

  RETURN QUERY SELECT
    coalesce(token_allowed, false) AND user_allowed,
    greatest(coalesce(token_retry, 1800), user_retry);
END
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION
  app.auth_consume_mfa_step_up_limits(uuid),
  app.auth_consume_password_reset_limits(text),
  app.auth_consume_password_reset_escalation_limits(text),
  app.auth_consume_recovery_approval_limits(uuid, uuid),
  app.auth_consume_mfa_enrollment_limits(text)
FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT EXECUTE ON FUNCTION
      app.auth_consume_mfa_step_up_limits(uuid),
      app.auth_consume_password_reset_limits(text),
      app.auth_consume_password_reset_escalation_limits(text),
      app.auth_consume_recovery_approval_limits(uuid, uuid),
      app.auth_consume_mfa_enrollment_limits(text)
    TO business_finlynq_app;
  END IF;
END
$$;
