-- Writable public demos use a bounded pool of isolated organizations. A live
-- demo session exclusively claims one slot; no visitor shares mutable state.
ALTER TABLE organizations
  ADD COLUMN organization_mode text NOT NULL DEFAULT 'REAL';
UPDATE organizations
SET organization_mode = CASE WHEN is_demo THEN 'PUBLIC_DEMO' ELSE 'REAL' END;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_mode_check
    CHECK (organization_mode IN ('REAL', 'PUBLIC_DEMO', 'SANDBOX')),
  ADD CONSTRAINT organizations_demo_mode_check CHECK (
    (is_demo AND organization_mode IN ('PUBLIC_DEMO', 'SANDBOX'))
    OR (NOT is_demo AND organization_mode = 'REAL')
  );
--> statement-breakpoint

CREATE TABLE currency_definitions (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  minor_units integer NOT NULL CHECK (minor_units BETWEEN 0 AND 3),
  active boolean NOT NULL DEFAULT true
);
INSERT INTO currency_definitions(code, minor_units) VALUES
  ('USD',2),('CAD',2),('EUR',2),('GBP',2),('AUD',2),('NZD',2),('CHF',2),
  ('CNY',2),('HKD',2),('SGD',2),('INR',2),('MXN',2),('BRL',2),('ZAR',2),
  ('AED',2),('SAR',2),('ILS',2),('TRY',2),('THB',2),('MYR',2),('PHP',2),
  ('SEK',2),('NOK',2),('DKK',2),('PLN',2),('CZK',2),('HUF',2),('IDR',2),
  ('JPY',0),('KRW',0),('VND',0),('CLP',0),('ISK',0),('XAF',0),('XOF',0),
  ('KWD',3),('BHD',3),('OMR',3),('JOD',3),('TND',3)
ON CONFLICT (code) DO UPDATE SET minor_units = EXCLUDED.minor_units, active = true;
CREATE OR REPLACE FUNCTION app.currency_minor_units(currency_code text)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT minor_units FROM currency_definitions
  WHERE code = upper(currency_code) AND active
$$;
REVOKE ALL ON currency_definitions FROM PUBLIC;
--> statement-breakpoint

-- One request may legitimately create several allocations with the same
-- action. Idempotency remains exact per affected entity rather than rejecting
-- the second row in a multi-allocation settlement.
DROP INDEX audit_events_org_request_action_unique;
CREATE UNIQUE INDEX audit_events_org_request_action_entity_unique
  ON audit_events(organization_id, request_id, action, entity_type, entity_id);
--> statement-breakpoint

ALTER TABLE ledgers
  ADD CONSTRAINT ledgers_functional_currency_fk
    FOREIGN KEY (functional_currency) REFERENCES currency_definitions(code) ON DELETE RESTRICT;
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_functional_currency_fk
    FOREIGN KEY (functional_currency) REFERENCES currency_definitions(code) ON DELETE RESTRICT;
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_transaction_currency_fk
    FOREIGN KEY (transaction_currency) REFERENCES currency_definitions(code) ON DELETE RESTRICT;
ALTER TABLE party_accounts
  ADD CONSTRAINT party_accounts_transaction_currency_fk
    FOREIGN KEY (transaction_currency) REFERENCES currency_definitions(code) ON DELETE RESTRICT;
ALTER TABLE open_items
  ADD CONSTRAINT open_items_transaction_currency_fk
    FOREIGN KEY (transaction_currency) REFERENCES currency_definitions(code) ON DELETE RESTRICT;
ALTER TABLE tax_determination_snapshots
  ADD CONSTRAINT tax_snapshots_currency_fk
    FOREIGN KEY (currency) REFERENCES currency_definitions(code) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE TABLE demo_sandbox_slots (
  slot integer PRIMARY KEY CHECK (slot BETWEEN 1 AND 32),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'DIRTY' CHECK (state IN ('DIRTY', 'RESETTING', 'READY', 'LEASED', 'QUARANTINED')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  lease_session_id uuid UNIQUE REFERENCES auth_sessions(id) ON DELETE RESTRICT,
  baseline_version integer NOT NULL DEFAULT 1 CHECK (baseline_version > 0),
  last_claimed_at timestamp with time zone,
  last_reset_at timestamp with time zone
);
--> statement-breakpoint

INSERT INTO organizations (id, slug, display_name, active, is_demo, organization_mode)
SELECT
  overlay(overlay(md5('business-finlynq-demo-sandbox-org:' || slot::text)
    placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid,
  'northstar-sandbox-' || lpad(slot::text, 2, '0'),
  'Northstar Demo Sandbox ' || lpad(slot::text, 2, '0'),
  true,
  true,
  'SANDBOX'
FROM generate_series(1, 32) AS slot
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
FROM generate_series(1, 32) AS slot
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
FROM generate_series(1, 32) AS slot
ON CONFLICT (organization_id, user_id) DO UPDATE SET active = true;
--> statement-breakpoint

INSERT INTO roles (id, organization_id, key, display_name, system_template, active)
SELECT
  overlay(overlay(md5('business-finlynq-demo-sandbox-role:' || slot::text)
    placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid,
  overlay(overlay(md5('business-finlynq-demo-sandbox-org:' || slot::text)
    placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid,
  'demo_accountant',
  'Demo accountant',
  true,
  true
FROM generate_series(1, 32) AS slot
ON CONFLICT (organization_id, key) DO UPDATE SET
  display_name = EXCLUDED.display_name, system_template = true, active = true;
--> statement-breakpoint

INSERT INTO demo_sandbox_slots (slot, organization_id)
SELECT slot, overlay(overlay(md5('business-finlynq-demo-sandbox-org:' || slot::text)
  placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid
FROM generate_series(1, 32) AS slot
ON CONFLICT (slot) DO UPDATE SET organization_id = EXCLUDED.organization_id;
--> statement-breakpoint

INSERT INTO membership_roles (organization_id, membership_id, role_id, assigned_by)
SELECT slot.organization_id, membership.id, role.id,
  membership.user_id
FROM demo_sandbox_slots slot
JOIN organization_memberships membership
  ON membership.organization_id = slot.organization_id
JOIN roles role
  ON role.organization_id = slot.organization_id AND role.key = 'demo_accountant'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO permissions (key, description) VALUES
  ('receivables.read', 'Read customer invoices, receipts, and allocations'),
  ('receivables.manage', 'Create and revise receivable document drafts'),
  ('receivables.post', 'Issue receivable documents into the ledger'),
  ('receivables.settle', 'Record and allocate customer receipts'),
  ('receivables.void', 'Void receivable documents through controlled reversals'),
  ('payables.read', 'Read supplier bills, payments, and allocations'),
  ('payables.manage', 'Create and revise payable document drafts'),
  ('payables.post', 'Post supplier documents into the ledger'),
  ('payables.settle', 'Record and allocate supplier payments'),
  ('payables.void', 'Void payable documents through controlled reversals'),
  ('tax.read', 'Read deterministic tax decisions and exception evidence')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;
--> statement-breakpoint

INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, permission.key
FROM roles role
CROSS JOIN permissions permission
WHERE role.key = 'demo_accountant'
  AND EXISTS (
    SELECT 1 FROM demo_sandbox_slots slot
    WHERE slot.organization_id = role.organization_id
  )
  AND permission.key IN (
    'ledger.journal.draft', 'ledger.journal.submit', 'ledger.journal.post',
    'ledger.journal.post_adjustment', 'ledger.journal.reverse',
    'ledger.posting_policy.manage', 'ledger.period.close',
    'mcp.ledger.read',
    'parties.read', 'parties.manage',
    'receivables.read', 'receivables.manage', 'receivables.post',
    'receivables.settle', 'receivables.void',
    'payables.read', 'payables.manage', 'payables.post',
    'payables.settle', 'payables.void', 'tax.read'
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, permission.key
FROM roles role
CROSS JOIN permissions permission
WHERE (role.key = 'OWNER' AND permission.key IN (
    'receivables.read', 'receivables.manage', 'receivables.post', 'receivables.settle', 'receivables.void',
    'payables.read', 'payables.manage', 'payables.post', 'payables.settle', 'payables.void', 'tax.read'
  )) OR (role.key = 'ACCOUNTANT_APPROVER' AND permission.key IN (
    'receivables.read', 'receivables.manage', 'receivables.post', 'receivables.settle', 'receivables.void',
    'payables.read', 'payables.manage', 'payables.post', 'payables.settle', 'payables.void', 'tax.read'
  )) OR (role.key = 'BOOKKEEPER_MAKER' AND permission.key IN (
    'receivables.read', 'receivables.manage', 'payables.read', 'payables.manage', 'tax.read'
  )) OR (role.key = 'VIEWER_AUDITOR' AND permission.key IN (
    'receivables.read', 'payables.read', 'tax.read'
  ))
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- End every legacy shared demo session before enforcing one live session per
-- isolated sandbox organization.
ALTER TABLE auth_sessions
  ADD COLUMN demo_generation integer,
  ADD CONSTRAINT auth_sessions_tenant_membership_fk
    FOREIGN KEY (organization_id, membership_id)
    REFERENCES organization_memberships(organization_id, id) ON DELETE RESTRICT;
UPDATE auth_sessions
SET revoked_at = coalesce(revoked_at, now()), demo_generation = 0
WHERE session_mode = 'DEMO';
ALTER TABLE auth_sessions
  ADD CONSTRAINT auth_sessions_demo_generation_check CHECK (
    (session_mode = 'DEMO' AND auth_method = 'DEMO_LINK' AND demo_generation IS NOT NULL)
    OR (session_mode = 'REAL' AND auth_method <> 'DEMO_LINK' AND demo_generation IS NULL)
  );
CREATE UNIQUE INDEX auth_sessions_one_live_demo_per_org_unique
  ON auth_sessions (organization_id)
  WHERE session_mode = 'DEMO' AND revoked_at IS NULL;
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
  ELSIF NEW.session_mode = 'REAL' THEN
    IF NEW.auth_method = 'DEMO_LINK' OR selected_user_is_demo
      OR selected_organization_mode <> 'REAL' OR NEW.demo_generation IS NOT NULL THEN
      RAISE EXCEPTION 'Real session principal cannot reference demo identity or organization state'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported session mode' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER auth_sessions_mode_guard
  BEFORE INSERT OR UPDATE OF user_id, organization_id, membership_id,
    auth_method, session_mode, demo_generation
  ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION app.guard_auth_session_mode();
REVOKE ALL ON FUNCTION app.guard_auth_session_mode() FROM PUBLIC;
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
  selected_slot demo_sandbox_slots%ROWTYPE;
  selected_user_id uuid;
  selected_membership_id uuid;
  selected_role_label text;
  created_session_id uuid;
  selected_live_ip_leases integer;
BEGIN
  IF length(selected_token_hash) < 32
    OR selected_ip_hash !~ '^[0-9a-f]{64}$'
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid demo session request' USING ERRCODE = '22023';
  END IF;

  -- Reset holds the exclusive form of this lock while it drains and rebuilds
  -- slots. Issuers share it, so independent visitors can still lease in
  -- parallel whenever maintenance is not active.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('business-finlynq-demo-sandbox-reset', 0)
  );
  -- Serialize the count and insert for one network identity. The route-level
  -- durable rate limits remain a separate abuse-control layer.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('business-finlynq-demo-ip:' || selected_ip_hash, 0)
  );

  WITH expired_sessions AS (
    SELECT id
    FROM auth_sessions
    WHERE session_mode = 'DEMO' AND revoked_at IS NULL
      AND (expires_at <= now() OR idle_expires_at <= now())
    ORDER BY id
    FOR UPDATE
  )
  UPDATE auth_sessions selected_session
  SET revoked_at = coalesce(revoked_at, now())
  FROM expired_sessions
  WHERE selected_session.id = expired_sessions.id;

  UPDATE demo_sandbox_slots slot
  SET state = 'DIRTY', lease_session_id = NULL
  WHERE slot.state = 'LEASED'
    AND NOT EXISTS (
      SELECT 1 FROM auth_sessions active_session
      WHERE active_session.id = slot.lease_session_id
        AND active_session.revoked_at IS NULL
        AND active_session.expires_at > now()
        AND active_session.idle_expires_at > now()
    );

  SELECT count(*)::integer INTO selected_live_ip_leases
  FROM auth_sessions active_session
  JOIN demo_sandbox_slots slot
    ON slot.organization_id = active_session.organization_id
   AND slot.state = 'LEASED'
   AND slot.lease_session_id = active_session.id
   AND slot.generation = active_session.demo_generation
  WHERE active_session.session_mode = 'DEMO'
    AND active_session.ip_hash = selected_ip_hash
    AND active_session.revoked_at IS NULL
    AND active_session.expires_at > now()
    AND active_session.idle_expires_at > now();
  IF selected_live_ip_leases >= 2 THEN RETURN; END IF;

  SELECT slot.* INTO selected_slot
  FROM demo_sandbox_slots slot
  JOIN organizations organization
    ON organization.id = slot.organization_id AND organization.active AND organization.is_demo
  WHERE slot.state = 'READY' AND slot.lease_session_id IS NULL
  ORDER BY slot.last_claimed_at NULLS FIRST, slot.slot
  FOR UPDATE OF slot SKIP LOCKED
  LIMIT 1;

  IF selected_slot.organization_id IS NULL THEN RETURN; END IF;

  SELECT membership.id, membership.user_id,
    coalesce(string_agg(DISTINCT role.display_name, ', ' ORDER BY role.display_name), 'Demo accountant')
  INTO selected_membership_id, selected_user_id, selected_role_label
  FROM organization_memberships membership
  LEFT JOIN membership_roles membership_role
    ON membership_role.organization_id = membership.organization_id
   AND membership_role.membership_id = membership.id
  LEFT JOIN roles role
    ON role.organization_id = membership_role.organization_id
   AND role.id = membership_role.role_id AND role.active
  WHERE membership.organization_id = selected_slot.organization_id
    AND membership.active
  GROUP BY membership.id;

  IF selected_membership_id IS NULL THEN RETURN; END IF;

  INSERT INTO auth_sessions(
    token_hash, user_id, organization_id, membership_id, auth_method, session_mode,
    ip_hash, user_agent_hash, idle_timeout_seconds, idle_expires_at, expires_at,
    demo_generation
  ) VALUES (
    selected_token_hash, selected_user_id,
    selected_slot.organization_id, selected_membership_id, 'DEMO_LINK', 'DEMO',
    selected_ip_hash, selected_user_agent_hash, 900,
    now() + interval '15 minutes', now() + interval '1 hour', selected_slot.generation
  ) RETURNING id INTO created_session_id;

  UPDATE demo_sandbox_slots
  SET state = 'LEASED', lease_session_id = created_session_id, last_claimed_at = now()
  WHERE slot = selected_slot.slot;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome, request_id
  ) VALUES (
    selected_user_id,
    selected_slot.organization_id, created_session_id, 'LOGIN', 'SUCCESS', selected_request_id
  );

  RETURN QUERY SELECT created_session_id,
    selected_user_id,
    selected_slot.organization_id, selected_membership_id,
    (SELECT display_name FROM organizations WHERE id = selected_slot.organization_id),
    selected_role_label;
END
$$;
REVOKE ALL ON FUNCTION app.auth_issue_demo_session(text, text, text, text) FROM PUBLIC;
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
     AND slot.state = 'LEASED'
     AND slot.lease_session_id = selected_session.id
     AND slot.generation = selected_session.demo_generation
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
  )
$$;
REVOKE ALL ON FUNCTION app.auth_demo_session_lease_valid(uuid) FROM PUBLIC;
--> statement-breakpoint

-- Tenant transactions cannot merely inspect a lease and continue. They lock
-- the authentication row first and the sandbox slot second, matching logout
-- and reset ordering, so revocation/generation handoff cannot complete until
-- every transaction for the old visitor has ended.
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
  selected_slot demo_sandbox_slots%ROWTYPE;
BEGIN
  IF coalesce(current_setting('app.session_mode', true), '') <> 'demo'
    OR coalesce(current_setting('app.auth_method', true), '') <> 'demo-link' THEN
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

  SELECT * INTO selected_session
  FROM auth_sessions
  WHERE id = selected_session_id
  FOR SHARE;
  IF selected_session.id IS NULL
    OR selected_session.organization_id IS DISTINCT FROM app.current_organization_id()
    OR selected_session.user_id IS DISTINCT FROM app.current_actor_id()
    OR selected_session.session_mode <> 'DEMO'
    OR selected_session.auth_method <> 'DEMO_LINK'
    OR selected_session.revoked_at IS NOT NULL
    OR selected_session.expires_at <= now()
    OR selected_session.idle_expires_at <= now() THEN
    RAISE EXCEPTION 'Demo session lease is not live'
      USING ERRCODE = '28000';
  END IF;

  SELECT * INTO selected_slot
  FROM demo_sandbox_slots
  WHERE organization_id = selected_session.organization_id
  FOR SHARE;
  IF selected_slot.organization_id IS NULL
    OR selected_slot.state <> 'LEASED'
    OR selected_slot.lease_session_id IS DISTINCT FROM selected_session.id
    OR selected_slot.generation IS DISTINCT FROM selected_session.demo_generation
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
    RAISE EXCEPTION 'Demo session lease is not live'
      USING ERRCODE = '28000';
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

  IF revoked_session.session_mode = 'DEMO' THEN
    UPDATE demo_sandbox_slots
    SET state = 'DIRTY', lease_session_id = NULL
    WHERE organization_id = revoked_session.organization_id
      AND state = 'LEASED' AND lease_session_id = revoked_session.id;
  ELSE
    INSERT INTO auth_security_events(
      user_id, organization_id, session_id, event_type, outcome, request_id
    ) VALUES (
      revoked_session.user_id, revoked_session.organization_id,
      revoked_session.id, 'LOGOUT', 'SUCCESS', selected_request_id
    );
  END IF;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.auth_revoke_session(text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_demo_session_is_valid()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.demo_write_authorized', true), 'false') <> 'true'
    OR coalesce(current_setting('app.session_mode', true), '') <> 'demo' THEN
    RETURN false;
  END IF;
  PERFORM app.assert_current_demo_session_lease();
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.current_demo_session_is_valid() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_ledger_posting_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_is_demo boolean;
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NOT NULL THEN
    IF NOT app.current_actor_has_permission('ledger.posting_policy.manage') THEN
      RAISE EXCEPTION 'Posting-policy management permission is required' USING ERRCODE = '42501';
    END IF;
    SELECT is_demo INTO selected_is_demo
    FROM organizations WHERE id = NEW.organization_id;
    IF selected_is_demo AND NOT app.current_demo_session_is_valid() THEN
      RAISE EXCEPTION 'Demo posting-policy changes require a live isolated sandbox session'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.updated_by IS DISTINCT FROM app.current_actor_id() THEN
      RAISE EXCEPTION 'Posting-policy actor does not match transaction context' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.version <> 1 THEN
    RAISE EXCEPTION 'Posting-policy creation must start at version 1'
      USING ERRCODE = '40001';
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
      OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Posting-policy updates require the next optimistic version'
        USING ERRCODE = '40001';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_ledger_posting_policy() FROM PUBLIC;
--> statement-breakpoint

-- Posting must lock and validate ledger configuration without granting the
-- web role direct UPDATE access to ledgers. Keep this callable only as the
-- journal status trigger and pin name resolution for the elevated body.
ALTER FUNCTION app.validate_journal_posting() SECURITY DEFINER;
ALTER FUNCTION app.validate_journal_posting() SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION app.validate_journal_posting() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_tenant_journal_draft_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NOT NULL THEN
    IF NOT app.current_actor_has_permission('ledger.journal.draft') THEN
      RAISE EXCEPTION 'Journal draft permission is required for an active organization member'
        USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM organizations organization
      WHERE organization.id = NEW.organization_id AND organization.is_demo
    ) AND NOT app.current_demo_session_is_valid() THEN
      RAISE EXCEPTION 'Demo journal writes require a live isolated sandbox session'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_tenant_party_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_organization_id uuid;
BEGIN
  target_organization_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF nullif(current_setting('app.organization_id', true), '') IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Party history cannot be hard-deleted by the application; deactivate it instead'
        USING ERRCODE = '42501';
    END IF;
    IF NOT app.current_actor_has_permission('parties.manage') THEN
      RAISE EXCEPTION 'Party-management permission is required' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM organizations organization
      WHERE organization.id = target_organization_id AND organization.is_demo
    ) AND NOT app.current_demo_session_is_valid() THEN
      RAISE EXCEPTION 'Demo party writes require a live isolated sandbox session'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint

ALTER TABLE source_documents
  ADD COLUMN idempotency_key text,
  ADD COLUMN command_hash text,
  ADD COLUMN supersedes_source_document_id uuid,
  ADD COLUMN created_by uuid,
  ADD COLUMN void_reason text,
  ADD CONSTRAINT source_documents_command_hash_check
    CHECK (command_hash IS NULL OR command_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT source_documents_tenant_supersedes_fk
    FOREIGN KEY (organization_id, supersedes_source_document_id)
    REFERENCES source_documents (organization_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX source_documents_org_idempotency_unique
  ON source_documents (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint

CREATE TABLE document_settlement_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,
  payment_source_document_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE RESTRICT,
  open_item_id uuid NOT NULL REFERENCES open_items(id) ON DELETE RESTRICT,
  allocation_type text NOT NULL CHECK (allocation_type IN ('APPLY', 'REVERSAL')),
  reverses_allocation_id uuid,
  transaction_currency text NOT NULL REFERENCES currency_definitions(code) ON DELETE RESTRICT,
  transaction_amount numeric(38,9) NOT NULL CHECK (transaction_amount > 0),
  carrying_functional_amount numeric(38,9) NOT NULL CHECK (carrying_functional_amount > 0),
  settlement_functional_amount numeric(38,9) NOT NULL CHECK (settlement_functional_amount > 0),
  realized_fx_functional numeric(38,9) NOT NULL,
  settlement_fx_rate numeric(38,18) NOT NULL CHECK (settlement_fx_rate > 0),
  fx_rate_source text NOT NULL CHECK (length(fx_rate_source) BETWEEN 1 AND 100),
  fx_rate_effective_at timestamp with time zone NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT document_settlement_allocations_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT document_settlement_allocations_tenant_ledger_fk
    FOREIGN KEY (organization_id, ledger_id) REFERENCES ledgers(organization_id, id),
  CONSTRAINT document_settlement_allocations_tenant_payment_fk
    FOREIGN KEY (organization_id, payment_source_document_id)
    REFERENCES source_documents(organization_id, id),
  CONSTRAINT document_settlement_allocations_tenant_open_item_fk
    FOREIGN KEY (organization_id, open_item_id) REFERENCES open_items(organization_id, id),
  CONSTRAINT document_settlement_allocations_tenant_reversal_fk
    FOREIGN KEY (organization_id, reverses_allocation_id)
    REFERENCES document_settlement_allocations(organization_id, id),
  CONSTRAINT document_settlement_allocations_reversal_shape_check CHECK (
    (allocation_type = 'APPLY' AND reverses_allocation_id IS NULL)
    OR (allocation_type = 'REVERSAL' AND reverses_allocation_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX document_settlement_allocations_org_idempotency_unique
  ON document_settlement_allocations(organization_id, idempotency_key);
CREATE UNIQUE INDEX document_settlement_allocations_reversal_unique
  ON document_settlement_allocations(reverses_allocation_id)
  WHERE reverses_allocation_id IS NOT NULL;
ALTER TABLE document_settlement_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_settlement_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_settlement_allocations
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

CREATE TABLE open_item_void_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,
  open_item_id uuid NOT NULL,
  void_source_document_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT open_item_void_events_tenant_ledger_fk
    FOREIGN KEY (organization_id, ledger_id)
    REFERENCES ledgers(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT open_item_void_events_tenant_item_fk
    FOREIGN KEY (organization_id, open_item_id)
    REFERENCES open_items(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT open_item_void_events_tenant_source_fk
    FOREIGN KEY (organization_id, void_source_document_id)
    REFERENCES source_documents(organization_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX open_item_void_events_org_id_unique
  ON open_item_void_events(organization_id, id);
CREATE UNIQUE INDEX open_item_void_events_item_unique
  ON open_item_void_events(open_item_id);
CREATE UNIQUE INDEX open_item_void_events_org_idempotency_unique
  ON open_item_void_events(organization_id, idempotency_key);
ALTER TABLE open_item_void_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_item_void_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON open_item_void_events
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

CREATE VIEW open_item_balances
WITH (security_invoker = true)
AS
SELECT item.id, item.organization_id, item.ledger_id, item.party_account_id,
  item.source_event_id, item.transaction_currency,
  item.original_transaction_amount, item.original_functional_amount,
  item.due_on, item.created_at,
  CASE WHEN void_event.id IS NOT NULL THEN 0 ELSE greatest(
    item.original_transaction_amount - coalesce(sum(
      CASE allocation.allocation_type
        WHEN 'APPLY' THEN allocation.transaction_amount
        ELSE -allocation.transaction_amount END
    ), 0), 0
  ) END::numeric(38,9) AS open_transaction_amount,
  CASE WHEN void_event.id IS NOT NULL THEN 0 ELSE greatest(
    item.original_functional_amount - coalesce(sum(
      CASE allocation.allocation_type
        WHEN 'APPLY' THEN allocation.carrying_functional_amount
        ELSE -allocation.carrying_functional_amount END
    ), 0), 0
  ) END::numeric(38,9) AS carrying_functional_amount,
  CASE
    WHEN void_event.id IS NOT NULL THEN 'REVERSED'
    WHEN coalesce(sum(CASE allocation.allocation_type
      WHEN 'APPLY' THEN allocation.transaction_amount
      ELSE -allocation.transaction_amount END), 0) = 0 THEN 'OPEN'
    WHEN coalesce(sum(CASE allocation.allocation_type
      WHEN 'APPLY' THEN allocation.transaction_amount
      ELSE -allocation.transaction_amount END), 0) = item.original_transaction_amount THEN 'SETTLED'
    ELSE 'PARTIALLY_SETTLED'
  END AS derived_status
FROM open_items item
LEFT JOIN document_settlement_allocations allocation
  ON allocation.organization_id = item.organization_id
 AND allocation.open_item_id = item.id
LEFT JOIN open_item_void_events void_event
  ON void_event.organization_id = item.organization_id
 AND void_event.open_item_id = item.id
GROUP BY item.id, void_event.id;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_subledger_event_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_source source_documents%ROWTYPE;
  required_permission text;
  selected_is_demo boolean;
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO selected_source FROM source_documents
  WHERE organization_id = NEW.organization_id AND id = NEW.source_document_id
  FOR SHARE;
  IF selected_source.id IS NULL OR selected_source.status <> 'POSTED'
    OR selected_source.legal_entity_id IS DISTINCT FROM (
      SELECT legal_entity_id FROM party_accounts
      WHERE organization_id = NEW.organization_id AND id = NEW.party_account_id
    ) THEN
    RAISE EXCEPTION 'Subledger event requires a posted source for the same party account entity'
      USING ERRCODE = '23514';
  END IF;
  required_permission := CASE
    WHEN selected_source.source_type = 'receivables.sales-invoice' THEN 'receivables.post'
    WHEN selected_source.source_type = 'receivables.customer-receipt' THEN 'receivables.settle'
    WHEN selected_source.source_type = 'payables.supplier-bill' THEN 'payables.post'
    WHEN selected_source.source_type = 'payables.supplier-payment' THEN 'payables.settle'
    ELSE NULL END;
  IF required_permission IS NULL OR NOT app.current_actor_has_permission(required_permission) THEN
    RAISE EXCEPTION 'Subledger posting permission is required' USING ERRCODE = '42501';
  END IF;
  SELECT is_demo INTO selected_is_demo FROM organizations WHERE id = NEW.organization_id;
  IF selected_is_demo AND NOT app.current_demo_session_is_valid() THEN
    RAISE EXCEPTION 'Demo subledger events require a live isolated sandbox session'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subledger_events_insert_guard
  BEFORE INSERT ON subledger_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_subledger_event_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_open_item_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NULL THEN RETURN NEW; END IF;
  IF NEW.status <> 'OPEN'
    OR NEW.open_transaction_amount <> NEW.original_transaction_amount
    OR NEW.carrying_functional_amount <> NEW.original_functional_amount
    OR NEW.original_transaction_amount <= 0 OR NEW.original_functional_amount <= 0 THEN
    RAISE EXCEPTION 'Open items must begin as a positive, fully open obligation'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM subledger_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.id = NEW.source_event_id
      AND event.ledger_id = NEW.ledger_id
      AND event.party_account_id = NEW.party_account_id
  ) THEN
    RAISE EXCEPTION 'Open item must reference a matching subledger event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER open_items_insert_guard
  BEFORE INSERT ON open_items
  FOR EACH ROW EXECUTE FUNCTION app.guard_open_item_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_settlement_allocation_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_item open_items%ROWTYPE;
  selected_party_role party_role_kind;
  selected_functional_currency text;
  selected_functional_minor_units integer;
  selected_payment source_documents%ROWTYPE;
  selected_original document_settlement_allocations%ROWTYPE;
  applied_amount numeric(38,9);
  allocated_carrying numeric(38,9);
  remaining_transaction numeric(38,9);
  remaining_carrying numeric(38,9);
  expected_carrying numeric(38,9);
  required_permission text;
  expected_settlement numeric(38,9);
  expected_realized numeric(38,9);
  selected_is_demo boolean;
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NULL THEN RETURN NEW; END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_actor_id() THEN
    RAISE EXCEPTION 'Settlement actor does not match transaction context' USING ERRCODE = '42501';
  END IF;
  SELECT item.*
    INTO selected_item
  FROM open_items item
  WHERE item.organization_id = NEW.organization_id AND item.id = NEW.open_item_id
  FOR UPDATE OF item;
  SELECT account.role, ledger.functional_currency
    INTO selected_party_role, selected_functional_currency
  FROM party_accounts account
  JOIN ledgers ledger
    ON ledger.organization_id = account.organization_id AND ledger.id = account.ledger_id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = selected_item.party_account_id;
  IF selected_item.id IS NULL OR selected_item.ledger_id <> NEW.ledger_id
    OR selected_item.transaction_currency <> NEW.transaction_currency THEN
    RAISE EXCEPTION 'Allocation does not match the open item ledger and currency'
      USING ERRCODE = '23514';
  END IF;
  selected_functional_minor_units := app.currency_minor_units(selected_functional_currency);
  IF selected_party_role IS NULL OR selected_functional_minor_units IS NULL THEN
    RAISE EXCEPTION 'Allocation requires an active party account and functional currency'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO selected_payment FROM source_documents
  WHERE organization_id = NEW.organization_id AND id = NEW.payment_source_document_id
  FOR SHARE;
  IF selected_payment.id IS NULL
    OR selected_payment.snapshot->>'partyAccountId' <> selected_item.party_account_id::text
    OR selected_payment.snapshot->>'ledgerId' <> selected_item.ledger_id::text THEN
    RAISE EXCEPTION 'Allocation payment source does not match the open item'
      USING ERRCODE = '23514';
  END IF;
  required_permission := CASE selected_party_role
    WHEN 'CUSTOMER' THEN CASE WHEN NEW.allocation_type = 'REVERSAL' THEN 'receivables.void' ELSE 'receivables.settle' END
    WHEN 'SUPPLIER' THEN CASE WHEN NEW.allocation_type = 'REVERSAL' THEN 'payables.void' ELSE 'payables.settle' END
  END;
  IF NOT app.current_actor_has_permission(required_permission) THEN
    RAISE EXCEPTION 'Settlement permission is required' USING ERRCODE = '42501';
  END IF;
  IF (selected_party_role = 'CUSTOMER' AND selected_payment.source_type <> 'receivables.customer-receipt')
    OR (selected_party_role = 'SUPPLIER' AND selected_payment.source_type <> 'payables.supplier-payment')
    OR (NEW.allocation_type = 'APPLY' AND selected_payment.status <> 'POSTED')
    OR (NEW.allocation_type = 'REVERSAL' AND selected_payment.status <> 'VOIDED') THEN
    RAISE EXCEPTION 'Payment source type or state is not valid for this allocation'
      USING ERRCODE = '23514';
  END IF;
  SELECT
    coalesce(sum(CASE allocation_type
      WHEN 'APPLY' THEN transaction_amount ELSE -transaction_amount END), 0),
    coalesce(sum(CASE allocation_type
      WHEN 'APPLY' THEN carrying_functional_amount ELSE -carrying_functional_amount END), 0)
    INTO applied_amount, allocated_carrying
  FROM document_settlement_allocations
  WHERE organization_id = NEW.organization_id AND open_item_id = NEW.open_item_id;
  remaining_transaction := selected_item.original_transaction_amount - applied_amount;
  remaining_carrying := selected_item.original_functional_amount - allocated_carrying;

  IF NEW.allocation_type = 'APPLY' THEN
    IF remaining_transaction <= 0 OR remaining_carrying <= 0
      OR NEW.transaction_amount > remaining_transaction THEN
      RAISE EXCEPTION 'Settlement would over-allocate the open item' USING ERRCODE = '23514';
    END IF;
    expected_carrying := CASE
      WHEN NEW.transaction_amount = remaining_transaction THEN remaining_carrying
      ELSE round(
        NEW.transaction_amount * selected_item.original_functional_amount
          / selected_item.original_transaction_amount,
        selected_functional_minor_units
      )
    END;
    IF expected_carrying <= 0 OR NEW.carrying_functional_amount <> expected_carrying THEN
      RAISE EXCEPTION 'Settlement carrying amount is inconsistent with the open item balance'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO selected_original FROM document_settlement_allocations
    WHERE organization_id = NEW.organization_id AND id = NEW.reverses_allocation_id
      AND open_item_id = NEW.open_item_id AND allocation_type = 'APPLY'
    FOR SHARE;
    IF selected_original.id IS NULL
      OR NEW.transaction_amount <> selected_original.transaction_amount
      OR NEW.carrying_functional_amount <> selected_original.carrying_functional_amount
      OR NEW.settlement_functional_amount <> selected_original.settlement_functional_amount
      OR NEW.realized_fx_functional <> selected_original.realized_fx_functional
      OR NEW.transaction_currency <> selected_original.transaction_currency
      OR NEW.ledger_id <> selected_original.ledger_id
      OR NEW.settlement_fx_rate <> selected_original.settlement_fx_rate
      OR NEW.fx_rate_source <> selected_original.fx_rate_source
      OR NEW.fx_rate_effective_at <> selected_original.fx_rate_effective_at THEN
      RAISE EXCEPTION 'Settlement reversal must exactly reference the original allocation'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  expected_settlement := round(
    NEW.transaction_amount * NEW.settlement_fx_rate,
    selected_functional_minor_units
  );
  expected_realized := CASE selected_party_role
    WHEN 'CUSTOMER' THEN expected_settlement - NEW.carrying_functional_amount
    ELSE NEW.carrying_functional_amount - expected_settlement END;
  IF NEW.settlement_functional_amount <> expected_settlement
    OR NEW.realized_fx_functional <> expected_realized THEN
    RAISE EXCEPTION 'Settlement FX snapshot is inconsistent' USING ERRCODE = '23514';
  END IF;
  SELECT is_demo INTO selected_is_demo FROM organizations WHERE id = NEW.organization_id;
  IF selected_is_demo AND NOT app.current_demo_session_is_valid() THEN
    RAISE EXCEPTION 'Demo allocations require a live isolated sandbox session'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER document_settlement_allocations_insert_guard
  BEFORE INSERT ON document_settlement_allocations
  FOR EACH ROW EXECUTE FUNCTION app.guard_settlement_allocation_insert();
CREATE TRIGGER document_settlement_allocations_append_only
  BEFORE UPDATE OR DELETE ON document_settlement_allocations
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_settlement_allocation_inserted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id,
    CASE WHEN NEW.allocation_type = 'APPLY' THEN 'subledger.allocation-applied'
         ELSE 'subledger.allocation-reversed' END,
    'document_settlement_allocation', NEW.id::text,
    jsonb_build_object(
      'openItemId', NEW.open_item_id, 'paymentSourceDocumentId', NEW.payment_source_document_id,
      'allocationType', NEW.allocation_type, 'transactionCurrency', NEW.transaction_currency,
      'transactionAmount', NEW.transaction_amount, 'realizedFxFunctional', NEW.realized_fx_functional,
      'commandHash', NEW.command_hash
    ),
    'subledger.settlement-allocation-' || lower(NEW.allocation_type)
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER document_settlement_allocations_audit_inserted
  AFTER INSERT ON document_settlement_allocations
  FOR EACH ROW EXECUTE FUNCTION app.audit_settlement_allocation_inserted();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_open_item_void_event_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_item open_items%ROWTYPE;
  selected_original_source source_documents%ROWTYPE;
  selected_void_source source_documents%ROWTYPE;
  selected_party_role party_role_kind;
  net_allocated numeric(38,9);
  required_permission text;
  selected_is_demo boolean;
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NULL THEN RETURN NEW; END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_actor_id() THEN
    RAISE EXCEPTION 'Open-item void actor does not match transaction context'
      USING ERRCODE = '42501';
  END IF;
  SELECT item.* INTO selected_item
  FROM open_items item
  WHERE item.organization_id = NEW.organization_id AND item.id = NEW.open_item_id
  FOR UPDATE OF item;
  SELECT source.*
    INTO selected_original_source
  FROM subledger_events event
  JOIN source_documents source
    ON source.organization_id = event.organization_id AND source.id = event.source_document_id
  WHERE event.organization_id = NEW.organization_id
    AND event.id = selected_item.source_event_id;
  SELECT account.role INTO selected_party_role
  FROM subledger_events event
  JOIN party_accounts account
    ON account.organization_id = event.organization_id AND account.id = event.party_account_id
  WHERE event.organization_id = NEW.organization_id
    AND event.id = selected_item.source_event_id;
  SELECT * INTO selected_void_source FROM source_documents
  WHERE organization_id = NEW.organization_id AND id = NEW.void_source_document_id
  FOR SHARE;
  IF selected_item.id IS NULL OR selected_item.ledger_id <> NEW.ledger_id
    OR selected_void_source.id IS NULL OR selected_void_source.status <> 'VOIDED'
    OR selected_void_source.supersedes_source_document_id <> selected_original_source.id
    OR selected_void_source.source_type <> selected_original_source.source_type
    OR selected_void_source.source_number <> selected_original_source.source_number THEN
    RAISE EXCEPTION 'Open-item void must use the exact voided successor of its posted source document'
      USING ERRCODE = '23514';
  END IF;
  required_permission := CASE selected_party_role
    WHEN 'CUSTOMER' THEN 'receivables.void'
    WHEN 'SUPPLIER' THEN 'payables.void'
  END;
  IF required_permission IS NULL OR NOT app.current_actor_has_permission(required_permission) THEN
    RAISE EXCEPTION 'Open-item void permission is required' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(sum(CASE allocation_type
    WHEN 'APPLY' THEN transaction_amount ELSE -transaction_amount END), 0)
  INTO net_allocated
  FROM document_settlement_allocations
  WHERE organization_id = NEW.organization_id AND open_item_id = NEW.open_item_id;
  IF net_allocated <> 0 THEN
    RAISE EXCEPTION 'Reverse every settlement allocation before voiding an open item'
      USING ERRCODE = '55000';
  END IF;
  SELECT is_demo INTO selected_is_demo FROM organizations WHERE id = NEW.organization_id;
  IF selected_is_demo AND NOT app.current_demo_session_is_valid() THEN
    RAISE EXCEPTION 'Demo open-item voids require a live isolated sandbox session'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER open_item_void_events_insert_guard
  BEFORE INSERT ON open_item_void_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_open_item_void_event_insert();
CREATE TRIGGER open_item_void_events_append_only
  BEFORE UPDATE OR DELETE ON open_item_void_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_open_item_void_event_inserted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id, 'subledger.open-item-voided', 'open_item_void_event', NEW.id::text,
    jsonb_build_object(
      'openItemId', NEW.open_item_id, 'voidSourceDocumentId', NEW.void_source_document_id,
      'commandHash', NEW.command_hash
    ),
    'subledger.open-item-void'
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER open_item_void_events_audit_inserted
  AFTER INSERT ON open_item_void_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_open_item_void_event_inserted();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_source_document_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  prior source_documents%ROWTYPE;
  required_permission text;
  selected_is_demo boolean;
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NULL THEN RETURN NEW; END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_actor_id() THEN
    RAISE EXCEPTION 'Source-document actor does not match transaction context' USING ERRCODE = '42501';
  END IF;
  IF NEW.status NOT IN ('DRAFT', 'POSTED', 'VOIDED')
    OR NEW.owner_module NOT IN ('receivables', 'payables') THEN
    RAISE EXCEPTION 'Unsupported source-document state' USING ERRCODE = '22023';
  END IF;
  IF NEW.owner_module = 'receivables' THEN
    required_permission := CASE
      WHEN NEW.source_type = 'receivables.customer-receipt' THEN
        CASE WHEN NEW.status = 'VOIDED' THEN 'receivables.void' ELSE 'receivables.settle' END
      WHEN NEW.status = 'DRAFT' THEN 'receivables.manage'
      WHEN NEW.status = 'POSTED' THEN 'receivables.post'
      ELSE 'receivables.void' END;
  ELSE
    required_permission := CASE
      WHEN NEW.source_type = 'payables.supplier-payment' THEN
        CASE WHEN NEW.status = 'VOIDED' THEN 'payables.void' ELSE 'payables.settle' END
      WHEN NEW.status = 'DRAFT' THEN 'payables.manage'
      WHEN NEW.status = 'POSTED' THEN 'payables.post'
      ELSE 'payables.void' END;
  END IF;
  IF NOT app.current_actor_has_permission(required_permission) THEN
    RAISE EXCEPTION 'Source-document permission is required' USING ERRCODE = '42501';
  END IF;
  SELECT is_demo INTO selected_is_demo FROM organizations WHERE id = NEW.organization_id;
  IF selected_is_demo AND NOT app.current_demo_session_is_valid() THEN
    RAISE EXCEPTION 'Demo source documents require a live isolated sandbox session'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.version = 1 THEN
    IF NEW.supersedes_source_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'Initial source-document version cannot supersede another version'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT * INTO prior FROM source_documents
    WHERE organization_id = NEW.organization_id
      AND id = NEW.supersedes_source_document_id
    FOR SHARE;
    IF prior.id IS NULL OR prior.source_type <> NEW.source_type
      OR prior.source_number <> NEW.source_number OR NEW.version <> prior.version + 1
      OR EXISTS (
        SELECT 1 FROM source_documents newer
        WHERE newer.organization_id = NEW.organization_id
          AND newer.source_type = NEW.source_type
          AND newer.source_number = NEW.source_number
          AND newer.version > prior.version
      ) THEN
      RAISE EXCEPTION 'Source-document version must supersede the current matching version'
        USING ERRCODE = '40001';
    END IF;
  END IF;
  IF NEW.status = 'VOIDED' AND length(coalesce(NEW.void_reason, '')) < 5 THEN
    RAISE EXCEPTION 'Voiding a source document requires a reason' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER source_documents_version_guard
  BEFORE INSERT ON source_documents
  FOR EACH ROW EXECUTE FUNCTION app.guard_source_document_version();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_source_document_inserted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id,
    CASE WHEN NEW.status = 'VOIDED' THEN NEW.owner_module || '.document-voided'
         WHEN NEW.status = 'POSTED' THEN NEW.owner_module || '.document-posted'
         ELSE NEW.owner_module || '.document-drafted' END,
    'source_document', NEW.id::text,
    jsonb_build_object(
      'sourceType', NEW.source_type, 'sourceNumber', NEW.source_number,
      'version', NEW.version, 'status', NEW.status, 'contentHash', NEW.content_hash
    ),
    NEW.owner_module || '.source-document-' || lower(NEW.status)
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER source_documents_audit_inserted
  AFTER INSERT ON source_documents
  FOR EACH ROW EXECUTE FUNCTION app.audit_source_document_inserted();
--> statement-breakpoint

INSERT INTO journal_type_definitions (id, key, version, owner_module, display_name, correction_route)
VALUES
  ('88888888-8888-4888-8888-888888888883', 'receivables.customer-receipt', 1, 'receivables', 'Customer receipt', '/app/receivables/invoices'),
  ('88888888-8888-4888-8888-888888888884', 'receivables.invoice-void', 1, 'receivables', 'Sales invoice void', '/app/receivables/invoices'),
  ('88888888-8888-4888-8888-888888888885', 'payables.supplier-payment', 1, 'payables', 'Supplier payment', '/app/payables/bills'),
  ('88888888-8888-4888-8888-888888888886', 'payables.bill-void', 1, 'payables', 'Supplier bill void', '/app/payables/bills')
ON CONFLICT (key, version) DO UPDATE SET
  owner_module = EXCLUDED.owner_module,
  display_name = EXCLUDED.display_name,
  correction_route = EXCLUDED.correction_route;
--> statement-breakpoint

REVOKE ALL ON demo_sandbox_slots, document_settlement_allocations,
  open_item_void_events, open_item_balances FROM PUBLIC;
REVOKE UPDATE, DELETE ON source_documents FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.current_demo_session_is_valid(),
  app.assert_current_demo_session_lease(),
  app.auth_demo_session_lease_valid(uuid), app.guard_auth_session_mode(),
  app.validate_journal_posting(),
  app.guard_ledger_posting_policy(),
  app.guard_subledger_event_insert(), app.guard_open_item_insert(),
  app.guard_settlement_allocation_insert(),
  app.audit_settlement_allocation_inserted(),
  app.guard_open_item_void_event_insert(),
  app.audit_open_item_void_event_inserted(),
  app.guard_source_document_version(), app.audit_source_document_inserted()
  FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON demo_sandbox_slots, document_settlement_allocations,
      open_item_void_events, open_item_balances
      FROM business_finlynq_app;
    REVOKE UPDATE, DELETE ON source_documents FROM business_finlynq_app;
    GRANT SELECT, INSERT ON source_documents, document_settlement_allocations,
      open_item_void_events
      TO business_finlynq_app;
    GRANT SELECT ON open_item_balances TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.current_demo_session_is_valid(),
      app.assert_current_demo_session_lease(),
      app.auth_issue_demo_session(text, text, text, text),
      app.auth_demo_session_lease_valid(uuid),
      app.auth_revoke_session(text, text)
      TO business_finlynq_app;
    REVOKE EXECUTE ON FUNCTION app.guard_source_document_version(),
      app.audit_source_document_inserted(),
      app.guard_subledger_event_insert(), app.guard_open_item_insert(),
      app.guard_settlement_allocation_insert(),
      app.audit_settlement_allocation_inserted(),
      app.guard_open_item_void_event_insert(),
      app.audit_open_item_void_event_inserted()
      FROM business_finlynq_app;
  END IF;
END
$$;
