ALTER TABLE "organizations" ADD COLUMN "writes_enabled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_real_writes_enabled_check"
  CHECK (
    "organizations"."writes_enabled_at" IS NULL
    OR (
      "organizations"."active"
      AND NOT "organizations"."is_demo"
      AND "organizations"."organization_mode" = 'REAL'
    )
  );
--> statement-breakpoint

-- Freeze inserts from old artifacts for the complete validation-and-cutover
-- sequence. Drizzle applies this migration transactionally, so this lock is
-- retained until the graph validator, helper, trigger, and all active writers
-- below have been installed together.
LOCK TABLE public.audit_events IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint

-- A valid nonempty organization graph has exactly one root, one leaf, no
-- missing parent, no branch, and every event reachable from that root. The
-- reachability count is necessary because a disconnected cycle can otherwise
-- satisfy the root/leaf/branch checks.
DO $audit_graph_validation$
DECLARE
  invalid_organization_id uuid;
BEGIN
  WITH RECURSIVE
  event_counts AS (
    SELECT event.organization_id, count(*)::bigint AS event_count
    FROM public.audit_events event
    GROUP BY event.organization_id
  ),
  root_counts AS (
    SELECT event.organization_id, count(*)::bigint AS root_count
    FROM public.audit_events event
    WHERE event.previous_event_hash IS NULL
    GROUP BY event.organization_id
  ),
  leaf_counts AS (
    SELECT event.organization_id, count(*)::bigint AS leaf_count
    FROM public.audit_events event
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.audit_events child
      WHERE child.organization_id = event.organization_id
        AND child.previous_event_hash = event.event_hash
    )
    GROUP BY event.organization_id
  ),
  reachable(organization_id, event_hash) AS (
    SELECT root.organization_id, root.event_hash
    FROM public.audit_events root
    WHERE root.previous_event_hash IS NULL
    UNION
    SELECT child.organization_id, child.event_hash
    FROM reachable parent
    JOIN public.audit_events child
      ON child.organization_id = parent.organization_id
     AND child.previous_event_hash = parent.event_hash
  ),
  reachable_counts AS (
    SELECT reachable.organization_id, count(*)::bigint AS reachable_count
    FROM reachable
    GROUP BY reachable.organization_id
  ),
  orphaned_organizations AS (
    SELECT DISTINCT event.organization_id
    FROM public.audit_events event
    LEFT JOIN public.audit_events parent
      ON parent.organization_id = event.organization_id
     AND parent.event_hash = event.previous_event_hash
    WHERE event.previous_event_hash IS NOT NULL
      AND parent.id IS NULL
  ),
  branched_organizations AS (
    SELECT event.organization_id
    FROM public.audit_events event
    WHERE event.previous_event_hash IS NOT NULL
    GROUP BY event.organization_id, event.previous_event_hash
    HAVING count(*) > 1
  ),
  nonfinite_organizations AS (
    SELECT DISTINCT event.organization_id
    FROM public.audit_events event
    WHERE NOT isfinite(event.occurred_at)
  )
  SELECT counts.organization_id
    INTO invalid_organization_id
  FROM event_counts counts
  LEFT JOIN root_counts roots USING (organization_id)
  LEFT JOIN leaf_counts leaves USING (organization_id)
  LEFT JOIN reachable_counts visited USING (organization_id)
  WHERE coalesce(roots.root_count, 0) <> 1
     OR coalesce(leaves.leaf_count, 0) <> 1
     OR coalesce(visited.reachable_count, 0) <> counts.event_count
     OR EXISTS (
       SELECT 1 FROM orphaned_organizations orphan
       WHERE orphan.organization_id = counts.organization_id
     )
     OR EXISTS (
       SELECT 1 FROM branched_organizations branch
       WHERE branch.organization_id = counts.organization_id
     )
     OR EXISTS (
       SELECT 1 FROM nonfinite_organizations nonfinite
       WHERE nonfinite.organization_id = counts.organization_id
     )
  LIMIT 1;

  IF invalid_organization_id IS NOT NULL THEN
    RAISE EXCEPTION 'Existing business audit history is not one finite linear chain per organization'
      USING ERRCODE = '23514';
  END IF;
END
$audit_graph_validation$;
--> statement-breakpoint

-- Serialize and return the graph leaf, never a timestamp-selected row. The
-- maximum timestamp is returned separately because a repaired/restored chain
-- may be logically linear while its historical occurrence times are not.
CREATE OR REPLACE FUNCTION app.locked_audit_graph_leaf(
  selected_organization_id uuid
)
RETURNS TABLE(
  leaf_event_hash text,
  maximum_occurred_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  selected_event_count bigint;
  selected_leaf_count bigint;
  selected_leaf_hash text;
  selected_maximum_occurred_at timestamp with time zone;
BEGIN
  IF selected_organization_id IS NULL THEN
    RAISE EXCEPTION 'Business audit graph requires an organization'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(selected_organization_id::text, 0));

  SELECT count(DISTINCT event.id)::bigint,
         count(*) FILTER (WHERE child.id IS NULL)::bigint,
         min(event.event_hash) FILTER (WHERE child.id IS NULL),
         max(event.occurred_at)
    INTO selected_event_count, selected_leaf_count,
         selected_leaf_hash, selected_maximum_occurred_at
  FROM public.audit_events event
  LEFT JOIN public.audit_events child
    ON child.organization_id = event.organization_id
   AND child.previous_event_hash = event.event_hash
  WHERE event.organization_id = selected_organization_id;

  IF selected_event_count = 0 THEN
    RETURN QUERY SELECT NULL::text, NULL::timestamp with time zone;
    RETURN;
  END IF;
  IF selected_leaf_count <> 1 OR NOT isfinite(selected_maximum_occurred_at) THEN
    RAISE EXCEPTION 'Business audit history does not have exactly one finite graph leaf'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY SELECT selected_leaf_hash, selected_maximum_occurred_at;
END
$$;
REVOKE ALL ON FUNCTION app.locked_audit_graph_leaf(uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.enforce_audit_event_chain_tip()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  expected_previous_hash text;
  maximum_historical_time timestamp with time zone;
  observed_at timestamp with time zone;
BEGIN
  SELECT leaf.leaf_event_hash, leaf.maximum_occurred_at
    INTO expected_previous_hash, maximum_historical_time
  FROM app.locked_audit_graph_leaf(NEW.organization_id) leaf;

  IF expected_previous_hash IS NULL THEN
    IF NEW.previous_event_hash IS NOT NULL THEN
      RAISE EXCEPTION 'The first business audit event cannot reference a previous hash'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.previous_event_hash IS DISTINCT FROM expected_previous_hash THEN
    RAISE EXCEPTION 'Business audit event does not extend the current organization graph leaf'
      USING ERRCODE = '23514';
  END IF;

  observed_at := clock_timestamp();
  IF maximum_historical_time IS NULL THEN
    NEW.occurred_at := observed_at;
  ELSE
    NEW.occurred_at := greatest(
      observed_at,
      maximum_historical_time + interval '1 microsecond'
    );
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.enforce_audit_event_chain_tip() FROM PUBLIC;
CREATE TRIGGER audit_events_enforce_chain_tip
  BEFORE INSERT ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.enforce_audit_event_chain_tip();
--> statement-breakpoint

-- Redefine every active audit writer to derive its predecessor from the
-- locked graph leaf. Selecting ORDER BY occurred_at is unsafe when an earlier
-- transaction waits behind a later-started transaction on the chain lock.
CREATE OR REPLACE FUNCTION app.append_tenant_business_audit(
  selected_organization_id uuid,
  selected_action text,
  selected_entity_type text,
  selected_entity_id text,
  selected_metadata jsonb,
  selected_topic text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor text;
  request_key text;
  previous_hash text;
  next_hash text;
BEGIN
  actor := nullif(current_setting('app.actor_id', true), '');
  request_key := nullif(current_setting('app.request_id', true), '');
  -- Owner-operated fixtures and migrations are outside the runtime audit path.
  IF actor IS NULL AND request_key IS NULL THEN RETURN; END IF;
  IF actor IS NULL OR request_key IS NULL THEN
    RAISE EXCEPTION 'Business writes require actor and request context'
      USING ERRCODE = '28000';
  END IF;

  SELECT leaf.leaf_event_hash INTO previous_hash
  FROM app.locked_audit_graph_leaf(selected_organization_id) leaf;

  next_hash := encode(public.digest(
    coalesce(previous_hash, '') || selected_organization_id::text || selected_entity_id ||
      request_key || selected_action || selected_metadata::text,
    'sha256'
  ), 'hex');

  INSERT INTO public.audit_events (
    organization_id, actor_type, actor_id, auth_method, source_surface,
    action, entity_type, entity_id, request_id, reason, safe_metadata,
    previous_event_hash, event_hash
  ) VALUES (
    selected_organization_id, 'USER_OR_SERVICE', actor,
    coalesce(nullif(current_setting('app.auth_method', true), ''), 'application'),
    coalesce(nullif(current_setting('app.source_surface', true), ''), 'UI'),
    selected_action, selected_entity_type, selected_entity_id, request_key,
    nullif(current_setting('app.reason', true), ''), selected_metadata,
    previous_hash, next_hash
  );

  IF selected_topic IS NOT NULL THEN
    INSERT INTO public.outbox_events (
      organization_id, topic, aggregate_type, aggregate_id, payload
    ) VALUES (
      selected_organization_id, selected_topic, selected_entity_type, selected_entity_id,
      selected_metadata
    );
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.append_tenant_business_audit(uuid, text, text, text, jsonb, text)
  FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_successful_posting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor text;
  request_key text;
  previous_hash text;
  next_hash text;
BEGIN
  IF NEW.status <> 'POSTED' OR OLD.status = 'POSTED' THEN
    RETURN NEW;
  END IF;

  actor := nullif(current_setting('app.actor_id', true), '');
  request_key := coalesce(
    nullif(current_setting('app.request_id', true), ''),
    NEW.idempotency_key
  );
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Posting requires transaction-local actor context'
      USING ERRCODE = '28000';
  END IF;

  SELECT leaf.leaf_event_hash INTO previous_hash
  FROM app.locked_audit_graph_leaf(NEW.organization_id) leaf;

  next_hash := encode(public.digest(
    coalesce(previous_hash, '') || NEW.organization_id::text || NEW.id::text ||
      request_key || 'journal.posted',
    'sha256'
  ), 'hex');

  INSERT INTO public.audit_events (
    organization_id, actor_type, actor_id, auth_method, source_surface,
    action, entity_type, entity_id, request_id, safe_metadata,
    previous_event_hash, event_hash
  ) VALUES (
    NEW.organization_id, 'USER_OR_SERVICE', actor,
    coalesce(nullif(current_setting('app.auth_method', true), ''), 'application'),
    coalesce(nullif(current_setting('app.source_surface', true), ''), NEW.origin::text),
    'journal.posted', 'journal_entry', NEW.id::text, request_key,
    jsonb_build_object('journalNumber', NEW.journal_number, 'contentHash', NEW.content_hash),
    previous_hash, next_hash
  );

  INSERT INTO public.outbox_events (
    organization_id, topic, aggregate_type, aggregate_id, payload
  ) VALUES (
    NEW.organization_id, 'ledger.journal-posted', 'journal_entry', NEW.id::text,
    jsonb_build_object(
      'journalId', NEW.id,
      'journalNumber', NEW.journal_number,
      'contentHash', NEW.content_hash
    )
  );

  UPDATE public.ledgers ledger
  SET first_posted_at = coalesce(ledger.first_posted_at, NEW.posted_at)
  WHERE ledger.organization_id = NEW.organization_id
    AND ledger.id = NEW.ledger_id;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.audit_successful_posting() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_period_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor uuid;
  reason text;
  request_key text;
  previous_hash text;
  next_hash text;
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  actor := app.current_actor_id();
  reason := nullif(current_setting('app.reason', true), '');
  request_key := nullif(current_setting('app.request_id', true), '');

  IF actor IS NULL OR reason IS NULL OR request_key IS NULL THEN
    RAISE EXCEPTION 'Period transitions require actor, reason, and request context'
      USING ERRCODE = '28000';
  END IF;

  INSERT INTO public.period_events (
    organization_id, ledger_id, period_id, from_state, to_state,
    reason, actor_id, request_id
  ) VALUES (
    NEW.organization_id, NEW.ledger_id, NEW.id, OLD.state, NEW.state,
    reason, actor, request_key
  );

  SELECT leaf.leaf_event_hash INTO previous_hash
  FROM app.locked_audit_graph_leaf(NEW.organization_id) leaf;

  next_hash := encode(public.digest(
    coalesce(previous_hash, '') || NEW.organization_id::text || NEW.id::text ||
      request_key || 'period.transition',
    'sha256'
  ), 'hex');

  INSERT INTO public.audit_events (
    organization_id, actor_type, actor_id, auth_method, source_surface,
    action, entity_type, entity_id, request_id, reason, safe_metadata,
    previous_event_hash, event_hash
  ) VALUES (
    NEW.organization_id, 'USER', actor::text,
    coalesce(nullif(current_setting('app.auth_method', true), ''), 'application'),
    coalesce(nullif(current_setting('app.source_surface', true), ''), 'UI'),
    'period.transition', 'fiscal_period', NEW.id::text, request_key, reason,
    jsonb_build_object('from', OLD.state, 'to', NEW.state, 'version', NEW.version),
    previous_hash, next_hash
  );

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.audit_period_transition() FROM PUBLIC;
--> statement-breakpoint

-- Session resolution exposes the tenant activation bit without weakening the
-- independent deployment and demo gates. Keep v2 for a one-release compatible
-- rollback window; current application artifacts use v3.
CREATE OR REPLACE FUNCTION app.auth_resolve_session_v3(
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
  step_up_expires_at timestamp with time zone,
  organization_writes_enabled boolean
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
        idle_expires_at = least(
          session_to_refresh.expires_at,
          now() + make_interval(secs => session_to_refresh.idle_timeout_seconds)
        )
    WHERE session_to_refresh.id = selected_session.id;
  END IF;

  RETURN QUERY
  SELECT selected_session.id, selected_user.id, organization.id, membership.id,
    selected_session.session_mode, selected_session.auth_method, organization.display_name,
    coalesce(
      string_agg(DISTINCT role.display_name, ', ' ORDER BY role.display_name),
      CASE WHEN selected_session.session_mode = 'DEMO' THEN 'Demo viewer' ELSE 'Member' END
    ),
    selected_user.email_ciphertext, selected_user.display_name_ciphertext,
    selected_session.expires_at, selected_session.mfa_verified_at,
    selected_session.step_up_expires_at,
    organization.writes_enabled_at IS NOT NULL
  FROM users selected_user
  JOIN organization_memberships membership ON membership.id = selected_session.membership_id
  JOIN organizations organization ON organization.id = selected_session.organization_id
  LEFT JOIN membership_roles membership_role
    ON membership_role.organization_id = organization.id
   AND membership_role.membership_id = membership.id
  LEFT JOIN roles role
    ON role.organization_id = organization.id
   AND role.id = membership_role.role_id
   AND role.active
  WHERE selected_user.id = selected_session.user_id
  GROUP BY selected_user.id, organization.id, membership.id;
END
$$;
REVOKE ALL ON FUNCTION app.auth_resolve_session_v3(text, text) FROM PUBLIC;
--> statement-breakpoint

-- This activation control is intentionally absent from the web/runtime ACL.
-- It is callable only through the migration-owner operator path. The separate
-- advisory-lock namespace lets ordinary writes hold a shared fence while an
-- enable/disable operation takes the exclusive fence; it must not reuse the
-- audit-chain lock because business audit triggers promote that lock to an
-- exclusive acquisition later in the same transaction.
CREATE OR REPLACE FUNCTION app.operator_set_organization_writes(
  selected_organization_id uuid,
  selected_enabled boolean,
  selected_operator_id text,
  selected_reason text,
  selected_request_id text
)
RETURNS TABLE(
  organization_id uuid,
  active boolean,
  organization_mode text,
  writes_enabled_at timestamp with time zone,
  changed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  selected_organization record;
  transition_at timestamp with time zone;
BEGIN
  IF selected_organization_id IS NULL THEN
    RAISE EXCEPTION 'Organization write activation target is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF selected_enabled IS NULL THEN
    RAISE EXCEPTION 'Organization write activation requires an explicit state'
      USING ERRCODE = '22023';
  END IF;
  IF selected_operator_id IS NULL
    OR length(btrim(selected_operator_id)) NOT BETWEEN 3 AND 100
    OR selected_operator_id ~ '[[:cntrl:]]'
    OR btrim(selected_operator_id) !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' THEN
    RAISE EXCEPTION 'Organization write activation operator is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF selected_reason IS NULL
    OR length(btrim(selected_reason)) NOT BETWEEN 10 AND 500
    OR selected_reason ~ '[[:cntrl:]]'
    OR btrim(selected_reason) ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}' THEN
    RAISE EXCEPTION 'Organization write activation reason is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF selected_request_id IS NULL
    OR btrim(selected_request_id) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Organization write activation request identifier is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.organization_id', selected_organization_id::text, true);
  PERFORM set_config('app.actor_id', btrim(selected_operator_id), true);
  PERFORM set_config('app.request_id', btrim(selected_request_id), true);
  PERFORM set_config('app.auth_method', 'operator-database', true);
  PERFORM set_config('app.source_surface', 'OPERATOR_CLI', true);
  PERFORM set_config('app.reason', btrim(selected_reason), true);

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'business-finlynq:organization-write-activation:' || selected_organization_id::text,
      0
    )
  );

  SELECT organization.active, organization.is_demo,
         organization.organization_mode, organization.writes_enabled_at,
         organization.updated_at
    INTO selected_organization
  FROM public.organizations organization
  WHERE organization.id = selected_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization write activation target was not found'
      USING ERRCODE = '22023';
  END IF;
  IF selected_organization.is_demo
    OR selected_organization.organization_mode <> 'REAL' THEN
    RAISE EXCEPTION 'Only a real organization can receive business-write activation'
      USING ERRCODE = '22023';
  END IF;
  IF selected_enabled AND NOT selected_organization.active THEN
    RAISE EXCEPTION 'An inactive organization cannot receive business-write activation'
      USING ERRCODE = '55000';
  END IF;

  IF selected_enabled = (selected_organization.writes_enabled_at IS NOT NULL) THEN
    RETURN QUERY
    SELECT selected_organization_id, selected_organization.active,
           selected_organization.organization_mode,
           selected_organization.writes_enabled_at,
           false;
    RETURN;
  END IF;

  transition_at := greatest(
    clock_timestamp(),
    selected_organization.updated_at + interval '1 microsecond'
  );

  UPDATE public.organizations organization
  SET writes_enabled_at = CASE WHEN selected_enabled THEN transition_at ELSE NULL END,
      updated_at = transition_at
  WHERE organization.id = selected_organization_id;

  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    CASE WHEN selected_enabled
      THEN 'organization.writes-enabled'
      ELSE 'organization.writes-disabled'
    END,
    'organization',
    selected_organization_id::text,
    jsonb_build_object(
      'writeEnabled', selected_enabled,
      'transitionedAt', transition_at,
      'previousWritesEnabledAt', selected_organization.writes_enabled_at
    ),
    CASE WHEN selected_enabled
      THEN 'organization.writes-enabled'
      ELSE 'organization.writes-disabled'
    END
  );

  RETURN QUERY
  SELECT organization.id, organization.active, organization.organization_mode,
         organization.writes_enabled_at, true
  FROM public.organizations organization
  WHERE organization.id = selected_organization_id;
END
$$;
REVOKE ALL ON FUNCTION app.operator_set_organization_writes(uuid, boolean, text, text, text)
  FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON FUNCTION app.locked_audit_graph_leaf(uuid),
      app.enforce_audit_event_chain_tip(),
      app.append_tenant_business_audit(uuid, text, text, text, jsonb, text),
      app.audit_successful_posting(),
      app.audit_period_transition()
      FROM business_finlynq_app;
    REVOKE ALL ON FUNCTION app.operator_set_organization_writes(uuid, boolean, text, text, text)
      FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.auth_resolve_session_v3(text, text)
      TO business_finlynq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_auth_worker') THEN
    REVOKE ALL ON FUNCTION app.locked_audit_graph_leaf(uuid),
      app.enforce_audit_event_chain_tip(),
      app.append_tenant_business_audit(uuid, text, text, text, jsonb, text),
      app.audit_successful_posting(),
      app.audit_period_transition(),
      app.auth_resolve_session_v3(text, text),
      app.operator_set_organization_writes(uuid, boolean, text, text, text)
      FROM business_finlynq_auth_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_backup') THEN
    REVOKE ALL ON FUNCTION app.locked_audit_graph_leaf(uuid),
      app.enforce_audit_event_chain_tip(),
      app.append_tenant_business_audit(uuid, text, text, text, jsonb, text),
      app.audit_successful_posting(),
      app.audit_period_transition(),
      app.auth_resolve_session_v3(text, text),
      app.operator_set_organization_writes(uuid, boolean, text, text, text)
      FROM business_finlynq_backup;
  END IF;
END
$$;
