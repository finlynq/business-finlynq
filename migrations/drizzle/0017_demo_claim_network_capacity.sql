-- Forward-only correction for installations that already applied 0012.
-- One network identity may claim at most 16 of the 128 sandboxes in a pool
-- cycle. Route-level per-IP and global minute limits remain the burst-control
-- layer, while this durable bound prevents one network from pinning the pool.
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
  selected_pool demo_sandbox_pool%ROWTYPE;
  selected_slot demo_sandbox_slots%ROWTYPE;
  selected_claim demo_daily_claims%ROWTYPE;
  candidate_claim demo_daily_claims%ROWTYPE;
  selected_user_id uuid;
  selected_membership_id uuid;
  selected_role_label text;
  created_session_id uuid;
  selected_daily_ip_claims integer;
  created_claim boolean := false;
BEGIN
  IF selected_token_hash !~ '^[0-9a-f]{64}$'
    OR (selected_claim_token_hash IS NOT NULL
      AND selected_claim_token_hash !~ '^[0-9a-f]{64}$')
    OR replacement_claim_token_hash !~ '^[0-9a-f]{64}$'
    OR selected_ip_hash !~ '^[0-9a-f]{64}$'
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid demo session request' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('business-finlynq-demo-sandbox-reset', 0)
  );
  SELECT * INTO selected_pool FROM demo_sandbox_pool
  WHERE singleton FOR SHARE;
  IF selected_pool.singleton IS NULL OR selected_pool.reset_after <= now() THEN
    RETURN;
  END IF;

  IF selected_claim_token_hash IS NOT NULL THEN
    SELECT * INTO candidate_claim
    FROM demo_daily_claims claim
    WHERE claim.token_hash = selected_claim_token_hash;
  END IF;

  IF candidate_claim.id IS NOT NULL THEN
    -- Match tenant-transaction/reset lock order: auth rows, claim, then slot.
    PERFORM selected_session.id FROM auth_sessions selected_session
    WHERE selected_session.organization_id = candidate_claim.organization_id
      AND selected_session.session_mode = 'DEMO'
      AND selected_session.revoked_at IS NULL
    ORDER BY selected_session.id FOR UPDATE;
    SELECT * INTO selected_claim
    FROM demo_daily_claims claim
    WHERE claim.id = candidate_claim.id
      AND claim.invalidated_at IS NULL
      AND claim.expires_at = selected_pool.reset_after
      AND claim.expires_at > now()
      AND claim.pool_cycle = selected_pool.cycle
    FOR UPDATE;
    IF selected_claim.id IS NOT NULL THEN
      SELECT * INTO selected_slot
      FROM demo_sandbox_slots slot
      WHERE slot.slot = selected_claim.slot
        AND slot.organization_id = selected_claim.organization_id
        AND slot.state = 'ASSIGNED'
        AND slot.generation = selected_claim.generation
      FOR UPDATE;
      IF selected_slot.organization_id IS NULL THEN
        selected_claim.id := NULL;
      END IF;
    END IF;
  END IF;

  IF selected_claim.id IS NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('business-finlynq-demo-daily-ip:' || selected_ip_hash, 0)
    );
    SELECT count(*)::integer INTO selected_daily_ip_claims
    FROM demo_daily_claims claim
    WHERE claim.ip_hash = selected_ip_hash
      AND claim.pool_cycle = selected_pool.cycle
      AND claim.invalidated_at IS NULL
      AND claim.expires_at = selected_pool.reset_after;
    IF selected_daily_ip_claims >= 16 THEN RETURN; END IF;

    SELECT slot.* INTO selected_slot
    FROM demo_sandbox_slots slot
    JOIN organizations organization
      ON organization.id = slot.organization_id
     AND organization.active AND organization.is_demo
     AND organization.organization_mode = 'SANDBOX'
    WHERE slot.state = 'READY'
      AND NOT EXISTS (
        SELECT 1 FROM demo_daily_claims active_claim
        WHERE active_claim.organization_id = slot.organization_id
          AND active_claim.invalidated_at IS NULL
      )
    ORDER BY slot.last_claimed_at NULLS FIRST, slot.slot
    FOR UPDATE OF slot SKIP LOCKED
    LIMIT 1;
    IF selected_slot.organization_id IS NULL THEN RETURN; END IF;

    INSERT INTO demo_daily_claims(
      token_hash, slot, organization_id, generation, pool_cycle,
      ip_hash, user_agent_hash, expires_at
    ) VALUES (
      replacement_claim_token_hash, selected_slot.slot,
      selected_slot.organization_id, selected_slot.generation,
      selected_pool.cycle, selected_ip_hash, selected_user_agent_hash,
      selected_pool.reset_after
    ) RETURNING * INTO selected_claim;
    created_claim := true;
  END IF;

  SELECT membership.id, membership.user_id,
    coalesce(string_agg(DISTINCT role.display_name, ', ' ORDER BY role.display_name), 'Demo owner')
  INTO selected_membership_id, selected_user_id, selected_role_label
  FROM organization_memberships membership
  JOIN membership_roles membership_role
    ON membership_role.organization_id = membership.organization_id
   AND membership_role.membership_id = membership.id
  JOIN roles canonical_role
    ON canonical_role.organization_id = membership_role.organization_id
   AND canonical_role.id = membership_role.role_id
   AND canonical_role.key = 'demo_accountant' AND canonical_role.active
  LEFT JOIN membership_roles display_assignment
    ON display_assignment.organization_id = membership.organization_id
   AND display_assignment.membership_id = membership.id
  LEFT JOIN roles role
    ON role.organization_id = display_assignment.organization_id
   AND role.id = display_assignment.role_id AND role.active
  WHERE membership.organization_id = selected_claim.organization_id
    AND membership.active
  GROUP BY membership.id, membership.user_id
  ORDER BY membership.id
  LIMIT 1;
  IF selected_membership_id IS NULL THEN
    RAISE EXCEPTION 'Demo sandbox has no canonical owner membership'
      USING ERRCODE = '23514';
  END IF;

  UPDATE auth_sessions AS active_demo_session
  SET revoked_at = coalesce(active_demo_session.revoked_at, now())
  WHERE active_demo_session.organization_id = selected_claim.organization_id
    AND active_demo_session.session_mode = 'DEMO'
    AND active_demo_session.revoked_at IS NULL;

  INSERT INTO auth_sessions(
    token_hash, user_id, organization_id, membership_id, auth_method, session_mode,
    ip_hash, user_agent_hash, idle_timeout_seconds, idle_expires_at, expires_at,
    demo_generation, demo_claim_id
  ) VALUES (
    selected_token_hash, selected_user_id,
    selected_claim.organization_id, selected_membership_id,
    'DEMO_LINK', 'DEMO', selected_ip_hash, selected_user_agent_hash, 900,
    least(now() + interval '15 minutes', selected_pool.reset_after),
    least(now() + interval '1 hour', selected_pool.reset_after),
    selected_claim.generation, selected_claim.id
  ) RETURNING id INTO created_session_id;

  UPDATE demo_sandbox_slots AS claimed_slot
  SET state = 'ASSIGNED',
    last_claimed_at = coalesce(claimed_slot.last_claimed_at, now())
  WHERE claimed_slot.slot = selected_claim.slot
    AND claimed_slot.organization_id = selected_claim.organization_id
    AND claimed_slot.generation = selected_claim.generation
    AND claimed_slot.state IN ('READY', 'ASSIGNED');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily demo claim lost its isolated sandbox'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome, request_id,
    metadata
  ) VALUES (
    selected_user_id, selected_claim.organization_id, created_session_id,
    'LOGIN', 'SUCCESS', selected_request_id,
    jsonb_build_object('demoClaimReused', NOT created_claim)
  );

  RETURN QUERY SELECT created_session_id, selected_user_id,
    selected_claim.organization_id, selected_membership_id,
    (SELECT display_name FROM organizations
      WHERE id = selected_claim.organization_id),
    selected_role_label, created_claim, selected_claim.expires_at;
END
$$;
REVOKE ALL ON FUNCTION app.auth_issue_demo_session(text, text, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT EXECUTE ON FUNCTION
      app.auth_issue_demo_session(text, text, text, text, text, text)
      TO business_finlynq_app;
  END IF;
END
$$;
