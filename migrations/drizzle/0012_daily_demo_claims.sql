-- A public demo workspace now belongs to one opaque browser claim for an
-- entire Toronto reset cycle. Authentication sessions may expire or be
-- revoked without making that workspace available to another visitor.
CREATE OR REPLACE FUNCTION app.next_demo_reset_after(reference_time timestamp with time zone)
RETURNS timestamp with time zone
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH local_clock AS (
    SELECT reference_time AT TIME ZONE 'America/Toronto' AS local_time
  ), next_local AS (
    SELECT CASE
      WHEN local_time < date_trunc('day', local_time) + interval '4 hours 15 minutes'
        THEN date_trunc('day', local_time) + interval '4 hours 15 minutes'
      ELSE date_trunc('day', local_time) + interval '1 day 4 hours 15 minutes'
    END AS reset_time
    FROM local_clock
  )
  SELECT reset_time AT TIME ZONE 'America/Toronto' FROM next_local
$$;
REVOKE ALL ON FUNCTION app.next_demo_reset_after(timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint

CREATE TABLE demo_sandbox_pool (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cycle bigint NOT NULL DEFAULT 1 CHECK (cycle > 0),
  reset_after timestamp with time zone NOT NULL,
  initialized_at timestamp with time zone NOT NULL DEFAULT now(),
  last_completed_reset_at timestamp with time zone
);
INSERT INTO demo_sandbox_pool(singleton, cycle, reset_after)
VALUES (true, 1, app.next_demo_reset_after(now()));
REVOKE ALL ON demo_sandbox_pool FROM PUBLIC;
--> statement-breakpoint

-- Future tenant modules register organization-owned tables here in child-first
-- purge order. The maintenance process validates every identifier and its
-- organization_id column before issuing any dynamic DELETE.
CREATE TABLE demo_sandbox_reset_tables (
  table_name text PRIMARY KEY CHECK (table_name ~ '^[a-z][a-z0-9_]*$'),
  purge_order integer NOT NULL UNIQUE CHECK (purge_order > 0)
);
INSERT INTO demo_sandbox_reset_tables(table_name, purge_order)
SELECT table_name, ordinal::integer
FROM unnest(ARRAY[
  'open_item_void_events',
  'document_settlement_allocations',
  'journal_entry_relations',
  'journal_approvals',
  'journal_lines',
  'open_items',
  'subledger_events',
  'tax_determination_snapshots',
  'journal_entries',
  'source_documents',
  'party_addresses',
  'party_accounts',
  'parties',
  'entity_tax_registrations',
  'period_events',
  'ledger_posting_policies',
  'ledger_number_sequences',
  'account_combinations',
  'segment_values',
  'segment_definitions',
  'fiscal_periods',
  'gl_accounts',
  'ledgers',
  'legal_entities',
  'audit_events',
  'outbox_events'
]::text[]) WITH ORDINALITY AS reset_table(table_name, ordinal);
REVOKE ALL ON demo_sandbox_reset_tables FROM PUBLIC;
--> statement-breakpoint

-- Later modules may replace this owner-only hook in their forward migration
-- when reset requires more than deleting organization-owned rows (for example,
-- removing synthetic members while preserving the canonical demo owner).
CREATE OR REPLACE FUNCTION app.reset_demo_sandbox_extensions(
  selected_organization_id uuid,
  canonical_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF selected_organization_id IS NULL OR canonical_user_id IS NULL THEN
    RAISE EXCEPTION 'Demo reset extension context is required'
      USING ERRCODE = '22023';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.reset_demo_sandbox_extensions(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- Preserve every existing visitor's data across this forward migration.
-- READY slots remain claimable, while leased, released, and interrupted slots
-- stay private and unavailable until the first nightly reconciliation.
ALTER TABLE demo_sandbox_slots
  DROP CONSTRAINT demo_sandbox_slots_slot_check,
  DROP CONSTRAINT demo_sandbox_slots_state_check;
UPDATE demo_sandbox_slots
SET state = CASE
  WHEN state = 'READY' THEN 'READY'
  WHEN state = 'QUARANTINED' OR state = 'RESETTING' THEN 'QUARANTINED'
  ELSE 'ASSIGNED'
END,
lease_session_id = NULL;
ALTER TABLE demo_sandbox_slots
  DROP COLUMN lease_session_id,
  ADD CONSTRAINT demo_sandbox_slots_slot_check CHECK (slot BETWEEN 1 AND 4096),
  ADD CONSTRAINT demo_sandbox_slots_state_check
    CHECK (state IN ('DIRTY', 'RESETTING', 'READY', 'ASSIGNED', 'QUARANTINED')),
  ADD CONSTRAINT demo_sandbox_slots_slot_org_unique UNIQUE (slot, organization_id);
--> statement-breakpoint

CREATE TABLE demo_daily_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  slot integer NOT NULL,
  organization_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  pool_cycle bigint NOT NULL CHECK (pool_cycle > 0),
  ip_hash text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent_hash text,
  claimed_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  invalidated_at timestamp with time zone,
  CONSTRAINT demo_daily_claims_slot_org_fk
    FOREIGN KEY (slot, organization_id)
    REFERENCES demo_sandbox_slots(slot, organization_id) ON DELETE RESTRICT,
  CONSTRAINT demo_daily_claims_expiry_check CHECK (expires_at > claimed_at)
);
CREATE UNIQUE INDEX demo_daily_claims_one_active_per_org_unique
  ON demo_daily_claims(organization_id) WHERE invalidated_at IS NULL;
CREATE INDEX demo_daily_claims_ip_cycle_idx
  ON demo_daily_claims(ip_hash, pool_cycle, invalidated_at);
REVOKE ALL ON demo_daily_claims FROM PUBLIC;
--> statement-breakpoint

ALTER TABLE auth_sessions
  ADD COLUMN demo_claim_id uuid REFERENCES demo_daily_claims(id) ON DELETE RESTRICT;
CREATE INDEX auth_sessions_demo_claim_idx
  ON auth_sessions(demo_claim_id, revoked_at, expires_at)
  WHERE session_mode = 'DEMO';
--> statement-breakpoint

-- Grow the pool additively. Existing organization IDs, keys, baselines, and
-- states are retained; only missing slots are installed as DIRTY for bootstrap.
INSERT INTO organizations (id, slug, display_name, active, is_demo, organization_mode)
SELECT
  overlay(overlay(md5('business-finlynq-demo-sandbox-org:' || slot::text)
    placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid,
  'northstar-sandbox-' || lpad(slot::text, 3, '0'),
  'Northstar Demo Sandbox ' || lpad(slot::text, 3, '0'),
  true,
  true,
  'SANDBOX'
FROM generate_series(1, 128) AS slot
ON CONFLICT (id) DO UPDATE SET active = true, is_demo = true, organization_mode = 'SANDBOX';
--> statement-breakpoint

INSERT INTO users (
  id, email_lookup_hash, email_ciphertext, display_name_ciphertext,
  password_hash, active, is_demo, mfa_required, email_verified_at
)
SELECT
  overlay(overlay(md5('business-finlynq-demo-sandbox-user:' || slot::text)
    placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid,
  'demo-sandbox-login-disabled-' || slot::text,
  'public-demo-sandbox-' || slot::text,
  NULL,
  '!demo-login-disabled!',
  true,
  true,
  false,
  now()
FROM generate_series(1, 128) AS slot
ON CONFLICT (id) DO UPDATE SET active = true, is_demo = true, mfa_required = false;
--> statement-breakpoint

INSERT INTO organization_memberships (id, organization_id, user_id, active)
SELECT
  overlay(overlay(md5('business-finlynq-demo-sandbox-membership:' || slot::text)
    placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid,
  overlay(overlay(md5('business-finlynq-demo-sandbox-org:' || slot::text)
    placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid,
  overlay(overlay(md5('business-finlynq-demo-sandbox-user:' || slot::text)
    placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid,
  true
FROM generate_series(1, 128) AS slot
ON CONFLICT (organization_id, user_id) DO UPDATE SET active = true;
--> statement-breakpoint

INSERT INTO roles (id, organization_id, key, display_name, system_template, active)
SELECT
  overlay(overlay(md5('business-finlynq-demo-sandbox-role:' || slot::text)
    placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid,
  overlay(overlay(md5('business-finlynq-demo-sandbox-org:' || slot::text)
    placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid,
  'demo_accountant',
  'Demo owner',
  true,
  true
FROM generate_series(1, 128) AS slot
ON CONFLICT (organization_id, key) DO UPDATE SET
  display_name = EXCLUDED.display_name, system_template = true, active = true;
--> statement-breakpoint

INSERT INTO demo_sandbox_slots (slot, organization_id, state)
SELECT slot, overlay(overlay(md5('business-finlynq-demo-sandbox-org:' || slot::text)
  placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid, 'DIRTY'
FROM generate_series(1, 128) AS slot
ON CONFLICT (slot) DO NOTHING;
--> statement-breakpoint

INSERT INTO membership_roles (organization_id, membership_id, role_id, assigned_by)
SELECT slot.organization_id, membership.id, role.id, membership.user_id
FROM demo_sandbox_slots slot
JOIN organization_memberships membership
  ON membership.organization_id = slot.organization_id
JOIN roles role
  ON role.organization_id = slot.organization_id AND role.key = 'demo_accountant'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The demo owner receives the same in-application authorization surface as an
-- OWNER. Organization-key recovery remains unavailable to anonymous visitors;
-- no email, bank, payment, tax-filing, webhook, or public MCP credential is
-- activated merely by a permission row.
DELETE FROM role_permissions permission_assignment
USING roles role, demo_sandbox_slots slot
WHERE role.id = permission_assignment.role_id
  AND role.organization_id = permission_assignment.organization_id
  AND slot.organization_id = role.organization_id
  AND role.key = 'demo_accountant';
INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, permission.key
FROM roles role
JOIN demo_sandbox_slots slot ON slot.organization_id = role.organization_id
CROSS JOIN permissions permission
WHERE role.key = 'demo_accountant'
  AND permission.key <> 'organization.recovery.manage'
ON CONFLICT DO NOTHING;
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
      OR selected_organization_mode <> 'SANDBOX' OR NEW.demo_generation IS NULL THEN
      RAISE EXCEPTION 'Demo session principal is not an isolated sandbox principal'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.demo_claim_id IS NULL THEN
      RAISE EXCEPTION 'New demo sessions require a daily sandbox claim'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.demo_claim_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM demo_daily_claims claim
      WHERE claim.id = NEW.demo_claim_id
        AND claim.organization_id = NEW.organization_id
        AND claim.generation = NEW.demo_generation
        AND claim.invalidated_at IS NULL AND claim.expires_at > now()
    ) THEN
      RAISE EXCEPTION 'Demo session claim does not match its sandbox generation'
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
DROP TRIGGER auth_sessions_mode_guard ON auth_sessions;
CREATE TRIGGER auth_sessions_mode_guard
  BEFORE INSERT OR UPDATE OF user_id, organization_id, membership_id,
    auth_method, session_mode, demo_generation, demo_claim_id
  ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION app.guard_auth_session_mode();
REVOKE ALL ON FUNCTION app.guard_auth_session_mode() FROM PUBLIC;
--> statement-breakpoint

DROP FUNCTION app.auth_issue_demo_session(text, text, text, text);
CREATE FUNCTION app.auth_issue_demo_session(
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
    IF selected_daily_ip_claims >= 2 THEN RETURN; END IF;

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

  UPDATE auth_sessions
  SET revoked_at = coalesce(revoked_at, now())
  WHERE organization_id = selected_claim.organization_id
    AND session_mode = 'DEMO' AND revoked_at IS NULL;

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

  UPDATE demo_sandbox_slots
  SET state = 'ASSIGNED', last_claimed_at = coalesce(last_claimed_at, now())
  WHERE slot = selected_claim.slot
    AND organization_id = selected_claim.organization_id
    AND generation = selected_claim.generation
    AND state IN ('READY', 'ASSIGNED');
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
    JOIN demo_sandbox_slots slot
      ON slot.organization_id = selected_session.organization_id
     AND slot.state = 'ASSIGNED'
     AND slot.generation = selected_session.demo_generation
    JOIN demo_sandbox_pool pool ON pool.singleton
    LEFT JOIN demo_daily_claims claim
      ON claim.id = selected_session.demo_claim_id
     AND claim.organization_id = selected_session.organization_id
     AND claim.slot = slot.slot
     AND claim.generation = slot.generation
     AND claim.pool_cycle = pool.cycle
     AND claim.invalidated_at IS NULL
     AND claim.expires_at = pool.reset_after
    JOIN organizations organization
      ON organization.id = slot.organization_id
     AND organization.active AND organization.organization_mode = 'SANDBOX'
    JOIN users selected_user
      ON selected_user.id = selected_session.user_id
     AND selected_user.active AND selected_user.is_demo
    JOIN organization_memberships membership
      ON membership.id = selected_session.membership_id
     AND membership.organization_id = selected_session.organization_id
     AND membership.user_id = selected_session.user_id AND membership.active
    WHERE selected_session.id = selected_session_id
      AND selected_session.session_mode = 'DEMO'
      AND selected_session.auth_method = 'DEMO_LINK'
      AND selected_session.revoked_at IS NULL
      AND selected_session.expires_at > now()
      AND selected_session.idle_expires_at > now()
      AND pool.reset_after > now()
      AND (
        claim.id IS NOT NULL
        OR (
          selected_session.demo_claim_id IS NULL
          AND selected_session.created_at < pool.initialized_at
        )
      )
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
  selected_claim demo_daily_claims%ROWTYPE;
  selected_slot demo_sandbox_slots%ROWTYPE;
  selected_pool demo_sandbox_pool%ROWTYPE;
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

  SELECT * INTO selected_session FROM auth_sessions
  WHERE id = selected_session_id FOR SHARE;
  IF selected_session.id IS NULL
    OR selected_session.organization_id IS DISTINCT FROM app.current_organization_id()
    OR selected_session.user_id IS DISTINCT FROM app.current_actor_id()
    OR selected_session.session_mode <> 'DEMO'
    OR selected_session.auth_method <> 'DEMO_LINK'
    OR selected_session.revoked_at IS NOT NULL
    OR selected_session.expires_at <= now()
    OR selected_session.idle_expires_at <= now() THEN
    RAISE EXCEPTION 'Demo session claim is not live' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO selected_pool FROM demo_sandbox_pool
  WHERE singleton FOR SHARE;
  IF selected_pool.reset_after <= now() THEN
    RAISE EXCEPTION 'Demo reset is due; wait for nightly reconciliation'
      USING ERRCODE = '28000';
  END IF;

  IF selected_session.demo_claim_id IS NOT NULL THEN
    SELECT * INTO selected_claim FROM demo_daily_claims
    WHERE id = selected_session.demo_claim_id FOR SHARE;
    IF selected_claim.id IS NULL
      OR selected_claim.organization_id IS DISTINCT FROM selected_session.organization_id
      OR selected_claim.generation IS DISTINCT FROM selected_session.demo_generation
      OR selected_claim.pool_cycle IS DISTINCT FROM selected_pool.cycle
      OR selected_claim.invalidated_at IS NOT NULL
      OR selected_claim.expires_at IS DISTINCT FROM selected_pool.reset_after
      OR selected_claim.expires_at <= now() THEN
      RAISE EXCEPTION 'Demo session claim is not live' USING ERRCODE = '28000';
    END IF;
  ELSIF selected_session.created_at >= selected_pool.initialized_at THEN
    RAISE EXCEPTION 'Demo session claim is not live' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO selected_slot FROM demo_sandbox_slots
  WHERE organization_id = selected_session.organization_id FOR SHARE;
  IF selected_slot.organization_id IS NULL
    OR selected_slot.state <> 'ASSIGNED'
    OR selected_slot.generation IS DISTINCT FROM selected_session.demo_generation
    OR (selected_claim.id IS NOT NULL
      AND selected_slot.slot IS DISTINCT FROM selected_claim.slot)
    OR NOT EXISTS (
      SELECT 1 FROM organizations organization
      WHERE organization.id = selected_session.organization_id
        AND organization.active AND organization.is_demo
        AND organization.organization_mode = 'SANDBOX'
    )
    OR NOT EXISTS (
      SELECT 1 FROM users selected_user
      WHERE selected_user.id = selected_session.user_id
        AND selected_user.active AND selected_user.is_demo
    )
    OR NOT EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.id = selected_session.membership_id
        AND membership.organization_id = selected_session.organization_id
        AND membership.user_id = selected_session.user_id
        AND membership.active
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
      'demoWorkspacePreserved', revoked_session.session_mode = 'DEMO'
    )
  );
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.auth_revoke_session(text, text) FROM PUBLIC;
--> statement-breakpoint

-- Sandbox privileged confirmation never accepts a REAL session and never
-- changes PASSWORD/TOTP provenance. It merely enables the isolated demo to
-- exercise reopen/seal UI until the ten-minute confirmation window expires.
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
  IF length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RETURN false;
  END IF;
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
    selected_request_id, jsonb_build_object('sandboxOnly', true)
  );
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.auth_mark_demo_step_up(uuid, text) FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON demo_sandbox_pool, demo_daily_claims FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION
      app.auth_issue_demo_session(text, text, text, text, text, text),
      app.auth_demo_session_lease_valid(uuid),
      app.assert_current_demo_session_lease(),
      app.auth_revoke_session(text, text),
      app.auth_mark_demo_step_up(uuid, text)
      TO business_finlynq_app;
  END IF;
END
$$;
