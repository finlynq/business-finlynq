CREATE TABLE auth_email_worker_status (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  worker_id uuid NOT NULL,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  last_heartbeat_at timestamp with time zone NOT NULL DEFAULT now(),
  last_success_at timestamp with time zone,
  last_error_code text
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_email_worker_heartbeat(selected_worker_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF selected_worker_id IS NULL THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;

  INSERT INTO auth_email_worker_status(singleton, worker_id, started_at, last_heartbeat_at)
  VALUES (true, selected_worker_id, now(), now())
  ON CONFLICT (singleton) DO UPDATE
    SET worker_id = excluded.worker_id,
        started_at = CASE
          WHEN auth_email_worker_status.worker_id = excluded.worker_id
            THEN auth_email_worker_status.started_at
          ELSE excluded.started_at
        END,
        last_heartbeat_at = excluded.last_heartbeat_at;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_email_delivery_readiness(
  selected_max_heartbeat_age_seconds integer DEFAULT 15
)
RETURNS TABLE(
  worker_ready boolean,
  last_heartbeat_at timestamp with time zone,
  oldest_pending_at timestamp with time zone,
  dead_count bigint,
  stuck_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH latest_worker AS (
    SELECT max(status.last_heartbeat_at) AS last_heartbeat_at
    FROM auth_email_worker_status status
  ), queue_state AS (
    SELECT
      min(outbox.created_at) FILTER (
        WHERE (outbox.status = 'PENDING' AND outbox.available_at <= now())
           OR (outbox.status = 'SENDING' AND outbox.lease_expires_at < now())
      ) AS oldest_pending_at,
      count(*) FILTER (WHERE outbox.status = 'DEAD')::bigint AS dead_count,
      count(*) FILTER (
        WHERE outbox.status = 'SENDING' AND outbox.lease_expires_at < now()
      )::bigint AS stuck_count
    FROM auth_email_outbox outbox
  )
  SELECT
    coalesce(latest_worker.last_heartbeat_at >= now() - make_interval(
      secs => greatest(5, least(300, coalesce(selected_max_heartbeat_age_seconds, 15)))
    ), false)
      AND queue_state.stuck_count = 0
      AND (
        queue_state.oldest_pending_at IS NULL
        OR queue_state.oldest_pending_at >= now() - interval '5 minutes'
      ) AS worker_ready,
    latest_worker.last_heartbeat_at,
    queue_state.oldest_pending_at,
    queue_state.dead_count,
    queue_state.stuck_count
  FROM latest_worker CROSS JOIN queue_state
$$;
--> statement-breakpoint

-- Reclaim an expired lease without consuming another attempt. The provider
-- idempotency key is stable per outbox id, so a worker crash after provider
-- acceptance can safely re-drive even when the final numbered attempt was 8.
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
  WHERE candidate.available_at <= now()
    AND (
      (candidate.status = 'PENDING' AND candidate.attempts < 8)
      OR (
        candidate.status = 'SENDING'
        AND candidate.attempts BETWEEN 1 AND 8
        AND candidate.lease_expires_at < now()
      )
    )
  ORDER BY candidate.created_at
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF selected_outbox_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE auth_email_outbox outbox
  SET status = 'SENDING',
      attempts = CASE WHEN outbox.status = 'PENDING' THEN outbox.attempts + 1 ELSE outbox.attempts END,
      lease_owner = selected_worker_id,
      lease_expires_at = now() + interval '2 minutes'
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
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE auth_email_worker_status
  SET last_heartbeat_at = now(), last_success_at = now(), last_error_code = NULL
  WHERE worker_id = selected_worker_id;
  RETURN true;
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

  UPDATE auth_email_worker_status
  SET last_heartbeat_at = now(), last_error_code = left(selected_error_code, 80)
  WHERE worker_id = selected_worker_id;
  IF NOT selected_retryable OR selected_attempts >= 8 THEN
    INSERT INTO auth_security_events(user_id, event_type, outcome, request_id, metadata)
    VALUES (selected_user_id, 'EMAIL_DELIVERY', 'FAILURE', selected_request_id,
      jsonb_build_object('outboxId', selected_outbox_id, 'errorCode', left(selected_error_code, 80)));
  END IF;
  RETURN true;
END
$$;
--> statement-breakpoint

REVOKE ALL ON auth_email_worker_status FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.auth_email_worker_heartbeat(uuid),
  app.auth_email_delivery_readiness(integer)
FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON auth_email_worker_status FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.auth_email_delivery_readiness(integer)
      TO business_finlynq_app;
    -- The deployed preview may be rolled back while account login is disabled.
    -- Preserve only its read-only login/session lookups; the password-only
    -- legacy session issuer remains revoked so it cannot bypass MFA.
    GRANT EXECUTE ON FUNCTION app.auth_lookup_login(text), app.auth_resolve_session(text, text)
      TO business_finlynq_app;
    REVOKE EXECUTE ON FUNCTION app.auth_issue_user_session(uuid, uuid, uuid, text, text, text, text)
      FROM business_finlynq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_auth_worker') THEN
    REVOKE ALL ON auth_email_worker_status FROM business_finlynq_auth_worker;
    GRANT EXECUTE ON FUNCTION
      app.auth_email_worker_heartbeat(uuid),
      app.auth_claim_email_delivery(uuid),
      app.auth_complete_email_delivery(uuid, uuid, text),
      app.auth_fail_email_delivery(uuid, uuid, text, boolean)
    TO business_finlynq_auth_worker;
  END IF;
END
$$;
