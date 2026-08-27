-- Organization administration is intentionally exposed only through the
-- SECURITY DEFINER APIs below. The runtime role never receives direct CRUD on
-- identity, invitation, MFA, session, or email-delivery tables.
ALTER TABLE organizations
  ADD COLUMN settings_version integer NOT NULL DEFAULT 1
    CHECK (settings_version > 0),
  ADD COLUMN updated_at timestamp with time zone NOT NULL DEFAULT now();
--> statement-breakpoint

ALTER TABLE organization_memberships
  ADD COLUMN administration_version integer NOT NULL DEFAULT 1
    CHECK (administration_version > 0);
CREATE UNIQUE INDEX organization_memberships_one_active_user_unique
  ON organization_memberships(user_id) WHERE active;
--> statement-breakpoint

CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  token_id uuid REFERENCES auth_one_time_tokens(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PENDING',
  invited_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at timestamp with time zone NOT NULL,
  accepted_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT organization_invitations_membership_fk
    FOREIGN KEY (organization_id, membership_id)
    REFERENCES organization_memberships(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT organization_invitations_role_fk
    FOREIGN KEY (organization_id, role_id)
    REFERENCES roles(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT organization_invitations_membership_unique
    UNIQUE (organization_id, membership_id),
  CONSTRAINT organization_invitations_status_check
    CHECK (status IN ('PENDING', 'ACCEPTED', 'CANCELLED', 'SUPERSEDED')),
  CONSTRAINT organization_invitations_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT organization_invitations_transition_check CHECK (
    (status = 'PENDING' AND accepted_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'ACCEPTED' AND accepted_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'CANCELLED' AND accepted_at IS NULL AND cancelled_at IS NOT NULL)
    OR (status = 'SUPERSEDED' AND accepted_at IS NULL AND cancelled_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX organization_invitations_one_pending_user_unique
  ON organization_invitations(organization_id, user_id)
  WHERE status = 'PENDING';
CREATE INDEX organization_invitations_org_status_idx
  ON organization_invitations(organization_id, status, expires_at);
ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_invitations_tenant_policy
  ON organization_invitations
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
REVOKE ALL ON organization_invitations FROM PUBLIC;
--> statement-breakpoint

-- Preserve operator-issued invitations created before this table existed.
-- The newest invitation token is authoritative for each membership; completed
-- memberships are retained as accepted history, while interrupted enrollment
-- remains pending so an administrator can safely reissue it.
WITH legacy_invitation AS (
  SELECT DISTINCT ON (membership.organization_id, membership.id)
    token.id AS token_id,
    token.user_id,
    token.organization_id,
    membership.id AS membership_id,
    assignment.role_id,
    CASE WHEN inviting_user.id IS NOT NULL
      THEN assignment.assigned_by ELSE token.user_id END AS invited_by_user_id,
    token.created_at,
    token.expires_at,
    token.consumed_at,
    membership.active AS membership_active,
    selected_user.active AS user_active,
    selected_user.email_verified_at IS NOT NULL AS email_verified,
    EXISTS (
      SELECT 1 FROM auth_mfa_factors factor
      WHERE factor.user_id = selected_user.id
        AND factor.factor_type = 'TOTP' AND factor.status = 'ACTIVE'
        AND factor.verified_at IS NOT NULL AND factor.revoked_at IS NULL
    ) AS has_active_mfa
  FROM auth_one_time_tokens token
  JOIN users selected_user ON selected_user.id = token.user_id
  JOIN organizations organization
    ON organization.id = token.organization_id
   AND organization.organization_mode = 'REAL'
   AND NOT organization.is_demo
  JOIN organization_memberships membership
    ON membership.organization_id = token.organization_id
   AND membership.user_id = token.user_id
  JOIN LATERAL (
    SELECT membership_role.role_id, membership_role.assigned_by
    FROM membership_roles membership_role
    JOIN roles role
      ON role.organization_id = membership_role.organization_id
     AND role.id = membership_role.role_id
    WHERE membership_role.organization_id = membership.organization_id
      AND membership_role.membership_id = membership.id
    ORDER BY role.active DESC,
      EXISTS (
        SELECT 1 FROM role_permissions permission_assignment
        WHERE permission_assignment.organization_id = membership_role.organization_id
          AND permission_assignment.role_id = membership_role.role_id
          AND permission_assignment.permission_key = 'organization.recovery.manage'
      ) DESC,
      CASE role.key
        WHEN 'OWNER' THEN 1
        WHEN 'demo_accountant' THEN 2
        WHEN 'ORGANIZATION_ADMIN' THEN 3
        WHEN 'ACCOUNTANT_APPROVER' THEN 4
        WHEN 'BOOKKEEPER_MAKER' THEN 5
        WHEN 'VIEWER_AUDITOR' THEN 6
        WHEN 'INTEGRATION_MCP' THEN 7
        ELSE 20
      END,
      role.key, membership_role.assigned_at DESC, membership_role.role_id
    LIMIT 1
  ) assignment ON true
  LEFT JOIN users inviting_user ON inviting_user.id = assignment.assigned_by
  WHERE token.purpose = 'INVITATION'
  ORDER BY membership.organization_id, membership.id,
    token.created_at DESC, token.id DESC
)
INSERT INTO organization_invitations(
  id, organization_id, user_id, membership_id, role_id, token_id,
  status, invited_by_user_id, expires_at, accepted_at,
  created_at, updated_at
)
SELECT gen_random_uuid(), legacy.organization_id, legacy.user_id,
  legacy.membership_id, legacy.role_id, legacy.token_id,
  CASE WHEN legacy.user_active AND (
      legacy.membership_active
      OR (legacy.email_verified AND legacy.has_active_mfa)
    )
    THEN 'ACCEPTED' ELSE 'PENDING' END,
  legacy.invited_by_user_id, legacy.expires_at,
  CASE WHEN legacy.user_active AND (
      legacy.membership_active
      OR (legacy.email_verified AND legacy.has_active_mfa)
    )
    THEN coalesce(legacy.consumed_at, now()) ELSE NULL END,
  legacy.created_at, coalesce(legacy.consumed_at, legacy.created_at)
FROM legacy_invitation legacy
ON CONFLICT (organization_id, membership_id) DO NOTHING;

-- Any older unconsumed token for the same retained invitation is explicitly
-- invalidated; only the token referenced by the backfilled record can work.
UPDATE auth_one_time_tokens old_token SET
  consumed_at = coalesce(old_token.consumed_at, now())
WHERE old_token.purpose = 'INVITATION'
  AND old_token.consumed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM organization_invitations invitation
    WHERE invitation.organization_id = old_token.organization_id
      AND invitation.user_id = old_token.user_id
      AND invitation.token_id <> old_token.id
  );
--> statement-breakpoint

-- Register the organization-owned invitation table with the extensible nightly
-- demo reset. The extension hook below removes identity/auth children and the
-- extra synthetic users after this child table has been purged.
INSERT INTO demo_sandbox_reset_tables(table_name, purge_order)
SELECT 'organization_invitations', coalesce(max(purge_order), 0) + 1
FROM demo_sandbox_reset_tables
ON CONFLICT (table_name) DO NOTHING;
--> statement-breakpoint

INSERT INTO permissions(key, description) VALUES
  ('organization.settings.read', 'Read organization profile and settings'),
  ('organization.settings.manage', 'Change organization profile and settings'),
  ('organization.members.read', 'Read organization membership and invitation status'),
  ('organization.members.manage', 'Invite, suspend, reactivate, and sign out organization members')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;
--> statement-breakpoint

-- Keep a small, immutable application role catalog. Custom role editing is a
-- later module; member administration can assign only these reviewed keys.
INSERT INTO roles(organization_id, key, display_name, system_template, active)
SELECT organization.id, template.key, template.display_name, true, true
FROM organizations organization
CROSS JOIN (VALUES
  ('OWNER', 'Owner'),
  ('ORGANIZATION_ADMIN', 'Organization administrator'),
  ('ACCOUNTANT_APPROVER', 'Accountant / approver'),
  ('BOOKKEEPER_MAKER', 'Bookkeeper / maker'),
  ('VIEWER_AUDITOR', 'Viewer / auditor'),
  ('INTEGRATION_MCP', 'AI & MCP integration')
) AS template(key, display_name)
ON CONFLICT (organization_id, key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  system_template = true,
  active = true;
--> statement-breakpoint

-- Owners retain the complete permission set. Organization administrators can
-- administer ordinary settings and access but cannot approve recovery. Every
-- interactive accounting role can at least read its organization profile.
INSERT INTO role_permissions(organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, permission.key
FROM roles role
CROSS JOIN permissions permission
WHERE role.key = 'OWNER'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, selected.permission_key
FROM roles role
CROSS JOIN (VALUES
  ('organization.settings.read'),
  ('organization.settings.manage'),
  ('organization.members.read'),
  ('organization.members.manage'),
  ('organization.roles.manage')
) AS selected(permission_key)
WHERE role.key = 'ORGANIZATION_ADMIN'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, 'organization.settings.read'
FROM roles role
WHERE role.key IN (
  'ACCOUNTANT_APPROVER', 'BOOKKEEPER_MAKER', 'VIEWER_AUDITOR', 'INTEGRATION_MCP'
)
ON CONFLICT DO NOTHING;

-- The anonymous sandbox's canonical demo_accountant receives the same in-app
-- settings/member surface, while recovery remains deliberately unavailable.
INSERT INTO role_permissions(organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, selected.permission_key
FROM roles role
CROSS JOIN (VALUES
  ('organization.settings.read'),
  ('organization.settings.manage'),
  ('organization.members.read'),
  ('organization.members.manage'),
  ('organization.roles.manage')
) AS selected(permission_key)
WHERE role.key = 'demo_accountant'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Fixed-role administration is intentionally one-role-per-membership in v1.
-- Preserve the strongest active/recovery role when upgrading any historical
-- many-to-many assignments, then enforce the invariant for every write path.
WITH ranked_assignment AS (
  SELECT assignment.organization_id, assignment.membership_id,
    assignment.role_id,
    row_number() OVER (
      PARTITION BY assignment.organization_id, assignment.membership_id
      ORDER BY role.active DESC,
        EXISTS (
          SELECT 1 FROM role_permissions permission_assignment
          WHERE permission_assignment.organization_id = assignment.organization_id
            AND permission_assignment.role_id = assignment.role_id
            AND permission_assignment.permission_key = 'organization.recovery.manage'
        ) DESC,
        CASE role.key
          WHEN 'OWNER' THEN 1
          WHEN 'demo_accountant' THEN 2
          WHEN 'ORGANIZATION_ADMIN' THEN 3
          WHEN 'ACCOUNTANT_APPROVER' THEN 4
          WHEN 'BOOKKEEPER_MAKER' THEN 5
          WHEN 'VIEWER_AUDITOR' THEN 6
          WHEN 'INTEGRATION_MCP' THEN 7
          ELSE 20
        END,
        role.key, assignment.role_id
    ) AS keep_rank
  FROM membership_roles assignment
  JOIN roles role
    ON role.organization_id = assignment.organization_id
   AND role.id = assignment.role_id
)
DELETE FROM membership_roles assignment
USING ranked_assignment ranked
WHERE assignment.organization_id = ranked.organization_id
  AND assignment.membership_id = ranked.membership_id
  AND assignment.role_id = ranked.role_id
  AND ranked.keep_rank > 1;
CREATE UNIQUE INDEX membership_roles_one_fixed_role_unique
  ON membership_roles(organization_id, membership_id);
--> statement-breakpoint

-- Signup migration 0013 provisions its tenant inside a durable database
-- function. This membership trigger makes the v1 fixed-role catalog additive
-- for every future tenant without reopening that security-sensitive function.
CREATE OR REPLACE FUNCTION app.ensure_organization_access_catalog()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO roles(organization_id, key, display_name, system_template, active)
  VALUES (
    NEW.organization_id, 'ORGANIZATION_ADMIN',
    'Organization administrator', true, true
  )
  ON CONFLICT (organization_id, key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    system_template = true,
    active = true;

  INSERT INTO role_permissions(organization_id, role_id, permission_key)
  SELECT role.organization_id, role.id, selected.permission_key
  FROM roles role
  CROSS JOIN (VALUES
    ('organization.settings.read'),
    ('organization.settings.manage'),
    ('organization.members.read'),
    ('organization.members.manage'),
    ('organization.roles.manage')
  ) AS selected(permission_key)
  WHERE role.organization_id = NEW.organization_id
    AND role.key = 'ORGANIZATION_ADMIN'
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permissions(organization_id, role_id, permission_key)
  SELECT role.organization_id, role.id, 'organization.settings.read'
  FROM roles role
  WHERE role.organization_id = NEW.organization_id
    AND role.key IN (
      'ACCOUNTANT_APPROVER', 'BOOKKEEPER_MAKER',
      'VIEWER_AUDITOR', 'INTEGRATION_MCP'
    )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.ensure_organization_access_catalog() FROM PUBLIC;
CREATE TRIGGER organization_membership_ensures_access_catalog
  AFTER INSERT ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION app.ensure_organization_access_catalog();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_admin_actor_has_permission(
  selected_organization_id uuid,
  selected_actor_id uuid,
  selected_permission text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_memberships membership
    JOIN users selected_user
      ON selected_user.id = membership.user_id AND selected_user.active
    JOIN roles role
      ON role.organization_id = membership.organization_id AND role.active
    JOIN membership_roles assignment
      ON assignment.organization_id = membership.organization_id
     AND assignment.membership_id = membership.id
     AND assignment.role_id = role.id
    JOIN role_permissions permission_assignment
      ON permission_assignment.organization_id = role.organization_id
     AND permission_assignment.role_id = role.id
    WHERE membership.organization_id = selected_organization_id
      AND membership.user_id = selected_actor_id
      AND membership.active
      AND permission_assignment.permission_key = selected_permission
  )
$$;
REVOKE ALL ON FUNCTION app.organization_admin_actor_has_permission(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint

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

  -- Acquire the organization mutation mutex before any row lock. Waiting for
  -- this advisory lock while holding an organization/session SHARE lock would
  -- deadlock with the current administrator that needs to update those rows.
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
    IF selected_organization.organization_mode <> 'SANDBOX'
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
      OR coalesce(current_setting('app.auth_method', true), '') <> 'password+mfa'
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

CREATE OR REPLACE FUNCTION app.organization_settings_read()
RETURNS TABLE(
  organization_id uuid,
  display_name text,
  settings_version integer,
  is_demo boolean,
  can_manage_settings boolean,
  can_read_members boolean,
  can_manage_members boolean,
  can_manage_roles boolean,
  can_manage_recovery boolean,
  assignable_roles jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.settings.read', false);
  RETURN QUERY
  SELECT organization.id, organization.display_name,
    organization.settings_version, organization.is_demo,
    app.organization_admin_actor_has_permission(
      administrator.organization_id, administrator.actor_id,
      'organization.settings.manage'
    ),
    app.organization_admin_actor_has_permission(
      administrator.organization_id, administrator.actor_id,
      'organization.members.read'
    ),
    app.organization_admin_actor_has_permission(
      administrator.organization_id, administrator.actor_id,
      'organization.members.manage'
    ),
    app.organization_admin_actor_has_permission(
      administrator.organization_id, administrator.actor_id,
      'organization.roles.manage'
    ),
    app.organization_admin_actor_has_permission(
      administrator.organization_id, administrator.actor_id,
      'organization.recovery.manage'
    ),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', catalog.id,
        'key', catalog.key,
        'displayName', catalog.display_name
      ) ORDER BY catalog.display_name, catalog.key)
      FROM roles catalog
      WHERE catalog.organization_id = organization.id
        AND catalog.active AND catalog.system_template
        AND catalog.key IN (
          'OWNER', 'ORGANIZATION_ADMIN', 'ACCOUNTANT_APPROVER',
          'BOOKKEEPER_MAKER', 'VIEWER_AUDITOR'
        )
    ), '[]'::jsonb)
  FROM organizations organization
  WHERE organization.id = administrator.organization_id;
END
$$;
REVOKE ALL ON FUNCTION app.organization_settings_read() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_members_read()
RETURNS TABLE(
  membership_id uuid,
  user_id uuid,
  email_ciphertext text,
  display_name_ciphertext text,
  membership_active boolean,
  administration_version integer,
  role_id uuid,
  role_key text,
  role_name text,
  invitation_id uuid,
  invitation_status text,
  invitation_version integer,
  invitation_expires_at timestamp with time zone,
  is_self boolean,
  active_session_count bigint,
  last_active_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.members.read', false);
  RETURN QUERY
  SELECT membership.id, selected_user.id,
    selected_user.email_ciphertext, selected_user.display_name_ciphertext,
    membership.active, membership.administration_version,
    selected_role.id, selected_role.key, selected_role.display_name,
    invitation.id, invitation.status, invitation.version,
    invitation.expires_at,
    membership.user_id = administrator.actor_id,
    coalesce(session_summary.active_count, 0),
    session_summary.last_active_at
  FROM organization_memberships membership
  JOIN users selected_user ON selected_user.id = membership.user_id
  JOIN LATERAL (
    SELECT role.id, role.key, role.display_name
    FROM membership_roles assignment
    JOIN roles role
      ON role.organization_id = assignment.organization_id
     AND role.id = assignment.role_id
    WHERE assignment.organization_id = membership.organization_id
      AND assignment.membership_id = membership.id
      AND role.active
    ORDER BY CASE role.key
      WHEN 'OWNER' THEN 1
      WHEN 'demo_accountant' THEN 2
      WHEN 'ORGANIZATION_ADMIN' THEN 3
      WHEN 'ACCOUNTANT_APPROVER' THEN 4
      WHEN 'BOOKKEEPER_MAKER' THEN 5
      WHEN 'VIEWER_AUDITOR' THEN 6
      ELSE 10
    END, role.key
    LIMIT 1
  ) selected_role ON true
  LEFT JOIN LATERAL (
    SELECT selected_invitation.id, selected_invitation.status,
      selected_invitation.version, selected_invitation.expires_at
    FROM organization_invitations selected_invitation
    WHERE selected_invitation.organization_id = membership.organization_id
      AND selected_invitation.membership_id = membership.id
    ORDER BY selected_invitation.created_at DESC, selected_invitation.id DESC
    LIMIT 1
  ) invitation ON true
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (
        WHERE session.revoked_at IS NULL
          AND session.expires_at > now()
          AND session.idle_expires_at > now()
      )::bigint AS active_count,
      max(session.last_seen_at) AS last_active_at
    FROM auth_sessions session
    WHERE session.organization_id = membership.organization_id
      AND session.membership_id = membership.id
  ) session_summary ON true
  WHERE membership.organization_id = administrator.organization_id
  ORDER BY membership.active DESC, selected_user.created_at, membership.id;
END
$$;
REVOKE ALL ON FUNCTION app.organization_members_read() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_update_settings(
  selected_display_name text,
  expected_version integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
  next_version integer;
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.settings.manage', true);
  IF length(btrim(selected_display_name)) NOT BETWEEN 2 AND 160
    OR selected_display_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Organization display name is invalid' USING ERRCODE = '22023';
  END IF;

  UPDATE organizations SET
    display_name = btrim(selected_display_name),
    settings_version = settings_version + 1,
    updated_at = now()
  WHERE id = administrator.organization_id
    AND settings_version = expected_version
  RETURNING settings_version INTO next_version;
  IF next_version IS NULL THEN
    RAISE EXCEPTION 'Organization settings version changed by another administrator'
      USING ERRCODE = '40001';
  END IF;

  PERFORM app.append_tenant_business_audit(
    administrator.organization_id,
    'organization.settings-updated',
    'organization',
    administrator.organization_id::text,
    jsonb_build_object('version', next_version),
    'organization.settings-updated'
  );
  RETURN next_version;
END
$$;
REVOKE ALL ON FUNCTION app.organization_update_settings(text, integer) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_invite_member(
  selected_role_id uuid,
  selected_user_id uuid,
  selected_membership_id uuid,
  selected_invitation_id uuid,
  selected_email_lookup_hash text,
  selected_email_ciphertext text,
  selected_display_name_ciphertext text,
  selected_token_id uuid,
  selected_token_hash text,
  selected_outbox_id uuid,
  selected_payload_ciphertext text
)
RETURNS TABLE(
  invitation_id uuid,
  membership_id uuid,
  version integer,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
  selected_role roles%ROWTYPE;
  selected_organization organizations%ROWTYPE;
  existing_identity users%ROWTYPE;
  invitation_expiry timestamp with time zone := now() + interval '72 hours';
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.members.manage', true);
  IF NOT app.organization_admin_actor_has_permission(
    administrator.organization_id, administrator.actor_id,
    'organization.roles.manage'
  ) THEN
    RAISE EXCEPTION 'Role-administration permission is required'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_organization FROM organizations
  WHERE id = administrator.organization_id FOR SHARE;
  IF selected_organization.is_demo AND (
    SELECT count(*) FROM organization_memberships membership
    WHERE membership.organization_id = administrator.organization_id
  ) >= 32 THEN
    RAISE EXCEPTION 'Demo sandbox member limit of 32 reached'
      USING ERRCODE = '54000';
  END IF;
  SELECT * INTO selected_role FROM roles
  WHERE organization_id = administrator.organization_id
    AND id = selected_role_id AND active AND system_template
    AND key IN (
      'OWNER', 'ORGANIZATION_ADMIN', 'ACCOUNTANT_APPROVER',
      'BOOKKEEPER_MAKER', 'VIEWER_AUDITOR'
    )
  FOR SHARE;
  IF selected_role.id IS NULL THEN
    RAISE EXCEPTION 'The selected fixed role is invalid' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
      SELECT 1 FROM role_permissions
      WHERE organization_id = selected_role.organization_id
        AND role_id = selected_role.id
        AND permission_key = 'organization.recovery.manage'
    ) AND NOT administrator.is_demo
    AND NOT app.organization_admin_actor_has_permission(
      administrator.organization_id, administrator.actor_id,
      'organization.recovery.manage'
    ) THEN
    RAISE EXCEPTION 'Recovery-administration permission is required for this role'
      USING ERRCODE = '42501';
  END IF;

  IF selected_user_id IS NULL OR selected_membership_id IS NULL
    OR selected_invitation_id IS NULL
    OR selected_email_lookup_hash !~ '^[0-9a-f]{64}$'
    OR length(selected_email_ciphertext) NOT BETWEEN 40 AND 4000
    OR length(selected_display_name_ciphertext) NOT BETWEEN 40 AND 4000 THEN
    RAISE EXCEPTION 'Member invitation identity payload is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF selected_organization.is_demo THEN
    IF selected_organization.organization_mode <> 'SANDBOX'
      OR selected_token_id IS NOT NULL OR selected_token_hash IS NOT NULL
      OR selected_outbox_id IS NOT NULL OR selected_payload_ciphertext IS NOT NULL THEN
      RAISE EXCEPTION 'Demo invitations must remain synthetic and local'
        USING ERRCODE = '22023';
    END IF;
  ELSIF selected_organization.organization_mode <> 'REAL'
    OR selected_token_id IS NULL OR selected_outbox_id IS NULL
    OR length(selected_token_hash) NOT BETWEEN 32 AND 200
    OR length(selected_payload_ciphertext) NOT BETWEEN 40 AND 4000 THEN
    RAISE EXCEPTION 'Real invitations require encrypted delivery material'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_lookup_hash, 0
  ));
  SELECT * INTO existing_identity
  FROM users WHERE email_lookup_hash = selected_email_lookup_hash
  FOR UPDATE;
  IF existing_identity.id IS NOT NULL THEN
    -- Invitation administration never repurposes any identity, including a
    -- pending owner signup. Verified self-signup is the only precedence path.
    RAISE EXCEPTION 'This email cannot be invited to this organization'
      USING ERRCODE = '23505';
  ELSE
    INSERT INTO users(
      id, email_lookup_hash, email_ciphertext, display_name_ciphertext,
      password_hash, active, is_demo, mfa_required, email_verified_at
    ) VALUES (
      selected_user_id, selected_email_lookup_hash, selected_email_ciphertext,
      selected_display_name_ciphertext,
      CASE WHEN selected_organization.is_demo
        THEN '!demo-invitation-disabled!' ELSE '!invitation-pending!' END,
      selected_organization.is_demo,
      selected_organization.is_demo,
      NOT selected_organization.is_demo,
      CASE WHEN selected_organization.is_demo THEN now() ELSE NULL END
    );
  END IF;
  INSERT INTO organization_memberships(
    id, organization_id, user_id, active, administration_version
  ) VALUES (
    selected_membership_id, administrator.organization_id,
    selected_user_id, selected_organization.is_demo, 1
  );
  INSERT INTO membership_roles(
    organization_id, membership_id, role_id, assigned_by
  ) VALUES (
    administrator.organization_id, selected_membership_id,
    selected_role.id, administrator.actor_id
  );

  IF NOT selected_organization.is_demo THEN
    INSERT INTO auth_one_time_tokens(
      id, token_hash, purpose, user_id, organization_id, expires_at
    ) VALUES (
      selected_token_id, selected_token_hash, 'INVITATION',
      selected_user_id, administrator.organization_id, invitation_expiry
    );
    INSERT INTO auth_email_outbox(
      id, user_id, organization_id, template_type,
      payload_ciphertext, request_id
    ) VALUES (
      selected_outbox_id, selected_user_id, administrator.organization_id,
      'INVITATION', selected_payload_ciphertext,
      current_setting('app.request_id', true)
    );
  END IF;

  INSERT INTO organization_invitations(
    id, organization_id, user_id, membership_id, role_id, token_id,
    status, invited_by_user_id, expires_at, accepted_at
  ) VALUES (
    selected_invitation_id, administrator.organization_id, selected_user_id,
    selected_membership_id, selected_role.id, selected_token_id,
    CASE WHEN selected_organization.is_demo THEN 'ACCEPTED' ELSE 'PENDING' END,
    administrator.actor_id, invitation_expiry,
    CASE WHEN selected_organization.is_demo THEN now() ELSE NULL END
  );

  IF NOT selected_organization.is_demo THEN
    INSERT INTO auth_security_events(
      user_id, organization_id, session_id, event_type, outcome,
      request_id, metadata
    ) VALUES (
      administrator.actor_id, administrator.organization_id,
      administrator.session_id, 'ORGANIZATION_INVITATION_ISSUED',
      'SUCCESS', current_setting('app.request_id', true),
      jsonb_build_object(
        'invitedBy', administrator.actor_id,
        'targetUserId', selected_user_id,
        'roleId', selected_role.id,
        'synthetic', false
      )
    );
  END IF;
  PERFORM app.append_tenant_business_audit(
    administrator.organization_id,
    'organization.member-invited',
    'organization_membership',
    selected_membership_id::text,
    jsonb_build_object(
      'invitationId', selected_invitation_id,
      'roleId', selected_role.id,
      'synthetic', selected_organization.is_demo
    ),
    'organization.member-invited'
  );
  RETURN QUERY SELECT selected_invitation_id, selected_membership_id,
    1, invitation_expiry;
END
$$;
REVOKE ALL ON FUNCTION app.organization_invite_member(
  uuid, uuid, uuid, uuid, text, text, text, uuid, text, uuid, text
) FROM PUBLIC;
--> statement-breakpoint

-- Invitation acceptance participates in the same account lock as signup and
-- organization administration. This prevents an administrator from reissuing
-- an invitation while its password/MFA enrollment transaction is in flight.
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
  selected_invitation organization_invitations%ROWTYPE;
  selected_identity users%ROWTYPE;
  selected_membership organization_memberships%ROWTYPE;
  selected_organization_name text;
  selected_email_lookup_hash text;
BEGIN
  IF selected_password_hash NOT LIKE 'scrypt-v1$32768$8$1$%'
    OR length(selected_factor_secret_ciphertext) NOT BETWEEN 40 AND 1000
    OR length(selected_setup_token_hash) NOT BETWEEN 32 AND 200
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid invitation acceptance request' USING ERRCODE = '22023';
  END IF;

  SELECT selected_user.email_lookup_hash INTO selected_email_lookup_hash
  FROM auth_one_time_tokens token
  JOIN users selected_user ON selected_user.id = token.user_id
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'INVITATION';
  IF selected_email_lookup_hash IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_lookup_hash, 0
  ));

  SELECT token.* INTO selected_token FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'INVITATION'
    AND token.consumed_at IS NULL AND token.available_at <= now()
    AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL OR selected_token.organization_id IS NULL THEN RETURN; END IF;
  SELECT invitation.* INTO selected_invitation
  FROM organization_invitations invitation
  WHERE invitation.token_id = selected_token.id
    AND invitation.user_id = selected_token.user_id
    AND invitation.organization_id = selected_token.organization_id
    AND invitation.status = 'PENDING'
  FOR UPDATE;
  IF selected_invitation.id IS NULL THEN RETURN; END IF;
  SELECT selected_user.* INTO selected_identity FROM users selected_user
  WHERE selected_user.id = selected_token.user_id
    AND NOT selected_user.active AND NOT selected_user.is_demo
    AND selected_user.email_verified_at IS NULL
    AND selected_user.password_hash = '!invitation-pending!'
  FOR UPDATE;
  IF selected_identity.id IS NULL THEN RETURN; END IF;
  SELECT membership.* INTO selected_membership
  FROM organization_memberships membership
  WHERE membership.id = selected_invitation.membership_id
    AND membership.organization_id = selected_token.organization_id
    AND membership.user_id = selected_token.user_id
    AND NOT membership.active
  FOR UPDATE;
  IF selected_membership.id IS NULL OR EXISTS (
    SELECT 1 FROM organization_memberships other_membership
    WHERE other_membership.user_id = selected_token.user_id
      AND other_membership.active
  ) OR EXISTS (
    SELECT 1 FROM auth_mfa_factors factor
    WHERE factor.user_id = selected_token.user_id
      AND factor.status IN ('PENDING', 'ACTIVE')
  ) THEN RETURN; END IF;
  SELECT organization.display_name INTO selected_organization_name
  FROM organizations organization
  WHERE organization.id = selected_token.organization_id
    AND organization.active AND NOT organization.is_demo
    AND organization.organization_mode = 'REAL'
  FOR SHARE;
  IF selected_organization_name IS NULL THEN RETURN; END IF;

  -- A signup reservation may coexist with an unused invitation until one link
  -- proves control of the email address. Invitation acceptance wins this race
  -- only while that signup is still PENDING, and makes its delivery terminal.
  UPDATE auth_organization_signups SET status = 'SUPERSEDED'
  WHERE user_id = selected_token.user_id AND status = 'PENDING';
  UPDATE auth_one_time_tokens SET consumed_at = coalesce(consumed_at, now())
  WHERE user_id = selected_token.user_id
    AND purpose IN ('ORGANIZATION_SIGNUP', 'MFA_SETUP')
    AND consumed_at IS NULL;
  UPDATE auth_email_outbox SET
    status = 'DEAD', lease_owner = NULL, lease_expires_at = NULL,
    last_error_code = 'SUPERSEDED_BY_INVITATION'
  WHERE user_id = selected_token.user_id
    AND template_type = 'ORGANIZATION_SIGNUP'
    AND status IN ('PENDING', 'SENDING');
  UPDATE auth_one_time_tokens invitation_token SET consumed_at = now()
  WHERE invitation_token.id = selected_token.id;
  UPDATE users invited_user SET
    password_hash = selected_password_hash,
    password_changed_at = now(),
    email_verified_at = now(),
    mfa_required = true,
    active = false
  WHERE invited_user.id = selected_token.user_id;
  INSERT INTO auth_mfa_factors(
    id, user_id, factor_type, label, secret_ciphertext, status
  ) VALUES (
    selected_factor_id, selected_token.user_id, 'TOTP',
    'Primary authenticator', selected_factor_secret_ciphertext, 'PENDING'
  );
  INSERT INTO auth_one_time_tokens(
    token_hash, purpose, user_id, organization_id, expires_at
  ) VALUES (
    selected_setup_token_hash, 'MFA_SETUP', selected_token.user_id,
    selected_token.organization_id, now() + interval '30 minutes'
  );
  INSERT INTO auth_security_events(
    user_id, organization_id, event_type, outcome, request_id
  ) VALUES (
    selected_token.user_id, selected_token.organization_id,
    'INVITATION_ACCEPTED', 'SUCCESS', selected_request_id
  );
  RETURN QUERY SELECT selected_token.user_id,
    selected_identity.email_ciphertext, selected_organization_name,
    selected_factor_id;
END
$$;
REVOKE ALL ON FUNCTION app.auth_accept_invitation(
  text, text, uuid, text, text, text
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_resend_invitation(
  selected_invitation_id uuid,
  expected_version integer,
  selected_token_id uuid,
  selected_token_hash text,
  selected_outbox_id uuid,
  selected_payload_ciphertext text
)
RETURNS TABLE(
  invitation_id uuid,
  membership_id uuid,
  version integer,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
  selected_invitation organization_invitations%ROWTYPE;
  selected_organization organizations%ROWTYPE;
  selected_identity users%ROWTYPE;
  selected_email_lookup_hash text;
  reset_incomplete_enrollment boolean := false;
  next_version integer;
  next_expiry timestamp with time zone := now() + interval '72 hours';
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.members.manage', true);
  SELECT * INTO selected_organization FROM organizations
  WHERE id = administrator.organization_id FOR SHARE;
  SELECT selected_user.email_lookup_hash INTO selected_email_lookup_hash
  FROM organization_invitations invitation
  JOIN users selected_user ON selected_user.id = invitation.user_id
  WHERE invitation.id = selected_invitation_id
    AND invitation.organization_id = administrator.organization_id;
  IF selected_email_lookup_hash IS NULL THEN
    RAISE EXCEPTION 'The invitation is unavailable for reissue' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_lookup_hash, 0
  ));
  SELECT * INTO selected_invitation
  FROM organization_invitations
  WHERE id = selected_invitation_id
    AND organization_id = administrator.organization_id
  FOR UPDATE;
  IF selected_invitation.id IS NULL
    OR selected_invitation.status NOT IN ('PENDING', 'CANCELLED') THEN
    RAISE EXCEPTION 'The invitation is unavailable for reissue' USING ERRCODE = '22023';
  END IF;
  IF selected_invitation.version <> expected_version THEN
    RAISE EXCEPTION 'Invitation version changed by another administrator'
      USING ERRCODE = '40001';
  END IF;
  SELECT * INTO selected_identity FROM users
  WHERE id = selected_invitation.user_id FOR UPDATE;
  IF selected_identity.active
    OR EXISTS (
      SELECT 1 FROM organization_memberships other_membership
      WHERE other_membership.user_id = selected_identity.id
        AND other_membership.organization_id <> administrator.organization_id
    )
    OR EXISTS (
      SELECT 1 FROM auth_organization_signups signup
      WHERE signup.user_id = selected_identity.id
        AND signup.status IN ('ENROLLING', 'ACTIVE')
    ) THEN
    RAISE EXCEPTION 'The invitation identity is no longer available for reissue'
      USING ERRCODE = '23505';
  END IF;

  IF selected_organization.is_demo THEN
    IF selected_organization.organization_mode <> 'SANDBOX'
      OR selected_token_id IS NOT NULL OR selected_token_hash IS NOT NULL
      OR selected_outbox_id IS NOT NULL OR selected_payload_ciphertext IS NOT NULL THEN
      RAISE EXCEPTION 'Demo invitation resend cannot deliver email'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF selected_organization.organization_mode <> 'REAL'
      OR selected_token_id IS NULL OR selected_outbox_id IS NULL
      OR length(selected_token_hash) NOT BETWEEN 32 AND 200
      OR length(selected_payload_ciphertext) NOT BETWEEN 40 AND 4000 THEN
      RAISE EXCEPTION 'Real invitation resend requires encrypted delivery material'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM auth_mfa_factors factor
      WHERE factor.user_id = selected_identity.id
        AND factor.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'An enrolled identity cannot be reset by invitation administration'
        USING ERRCODE = '23505';
    END IF;
    IF selected_identity.email_verified_at IS NULL
      AND selected_identity.password_hash = '!invitation-pending!' THEN
      reset_incomplete_enrollment := false;
    ELSIF selected_identity.email_verified_at IS NOT NULL
      AND selected_identity.password_hash LIKE 'scrypt-v1$32768$8$1$%'
      AND (
        EXISTS (
          SELECT 1 FROM auth_mfa_factors factor
          WHERE factor.user_id = selected_identity.id
            AND factor.status = 'PENDING'
        ) OR EXISTS (
          SELECT 1 FROM auth_one_time_tokens setup_token
          WHERE setup_token.user_id = selected_identity.id
            AND setup_token.organization_id = administrator.organization_id
            AND setup_token.purpose = 'MFA_SETUP'
            AND setup_token.consumed_at IS NULL
        )
      ) THEN
      reset_incomplete_enrollment := true;
    ELSE
      RAISE EXCEPTION 'The invitation identity is no longer available for reissue'
        USING ERRCODE = '23505';
    END IF;
    UPDATE auth_one_time_tokens
    SET consumed_at = coalesce(consumed_at, now())
    WHERE user_id = selected_invitation.user_id
      AND organization_id = administrator.organization_id
      AND purpose IN ('INVITATION', 'MFA_SETUP')
      AND consumed_at IS NULL;
    UPDATE auth_email_outbox SET
      status = 'DEAD', lease_owner = NULL, lease_expires_at = NULL,
      last_error_code = 'SUPERSEDED'
    WHERE user_id = selected_invitation.user_id
      AND organization_id = administrator.organization_id
      AND template_type = 'INVITATION'
      AND status IN ('PENDING', 'SENDING');
    UPDATE auth_mfa_factors SET
      status = 'REVOKED', revoked_at = coalesce(revoked_at, now())
    WHERE user_id = selected_invitation.user_id
      AND status = 'PENDING';
    IF reset_incomplete_enrollment THEN
      UPDATE users SET
        password_hash = '!invitation-pending!',
        password_changed_at = NULL,
        email_verified_at = NULL,
        active = false,
        mfa_required = true
      WHERE id = selected_identity.id
        AND NOT active AND NOT is_demo;
    END IF;
    INSERT INTO auth_one_time_tokens(
      id, token_hash, purpose, user_id, organization_id, expires_at
    ) VALUES (
      selected_token_id, selected_token_hash, 'INVITATION',
      selected_invitation.user_id, administrator.organization_id,
      next_expiry
    );
    INSERT INTO auth_email_outbox(
      id, user_id, organization_id, template_type,
      payload_ciphertext, request_id
    ) VALUES (
      selected_outbox_id, selected_invitation.user_id,
      administrator.organization_id, 'INVITATION',
      selected_payload_ciphertext, current_setting('app.request_id', true)
    );
    INSERT INTO auth_security_events(
      user_id, organization_id, session_id, event_type, outcome,
      request_id, metadata
    ) VALUES (
      administrator.actor_id, administrator.organization_id,
      administrator.session_id, 'ORGANIZATION_INVITATION_REISSUED',
      'SUCCESS', current_setting('app.request_id', true),
      jsonb_build_object(
        'targetUserId', selected_identity.id,
        'enrollmentReset', reset_incomplete_enrollment
      )
    );
  END IF;

  UPDATE organization_invitations invitation SET
    token_id = selected_token_id,
    status = 'PENDING',
    accepted_at = NULL,
    cancelled_at = NULL,
    expires_at = next_expiry,
    updated_at = now(),
    version = invitation.version + 1
  WHERE invitation.id = selected_invitation.id
  RETURNING invitation.version INTO next_version;

  PERFORM app.append_tenant_business_audit(
    administrator.organization_id,
    'organization.invitation-reissued',
    'organization_membership',
    selected_invitation.membership_id::text,
    jsonb_build_object(
      'invitationId', selected_invitation.id,
      'version', next_version,
      'synthetic', selected_organization.is_demo
    ),
    'organization.invitation-reissued'
  );
  RETURN QUERY SELECT selected_invitation.id,
    selected_invitation.membership_id, next_version, next_expiry;
END
$$;
REVOKE ALL ON FUNCTION app.organization_resend_invitation(
  uuid, integer, uuid, text, uuid, text
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_cancel_invitation(
  selected_invitation_id uuid,
  expected_version integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
  selected_invitation organization_invitations%ROWTYPE;
  selected_identity users%ROWTYPE;
  selected_email_lookup_hash text;
  reset_incomplete_enrollment boolean := false;
  next_version integer;
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.members.manage', true);
  SELECT selected_user.email_lookup_hash INTO selected_email_lookup_hash
  FROM organization_invitations invitation
  JOIN users selected_user ON selected_user.id = invitation.user_id
  WHERE invitation.id = selected_invitation_id
    AND invitation.organization_id = administrator.organization_id;
  IF selected_email_lookup_hash IS NULL THEN
    RAISE EXCEPTION 'The pending invitation is unavailable' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_lookup_hash, 0
  ));
  SELECT * INTO selected_invitation
  FROM organization_invitations
  WHERE id = selected_invitation_id
    AND organization_id = administrator.organization_id
  FOR UPDATE;
  IF selected_invitation.id IS NULL OR selected_invitation.status <> 'PENDING' THEN
    RAISE EXCEPTION 'The pending invitation is unavailable' USING ERRCODE = '22023';
  END IF;
  IF selected_invitation.version <> expected_version THEN
    RAISE EXCEPTION 'Invitation version changed by another administrator'
      USING ERRCODE = '40001';
  END IF;

  SELECT * INTO selected_identity FROM users
  WHERE id = selected_invitation.user_id FOR UPDATE;
  IF selected_identity.active OR EXISTS (
    SELECT 1 FROM organization_memberships other_membership
    WHERE other_membership.user_id = selected_identity.id
      AND other_membership.organization_id <> administrator.organization_id
  ) OR EXISTS (
    SELECT 1 FROM auth_mfa_factors factor
    WHERE factor.user_id = selected_identity.id AND factor.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'The invitation identity is no longer available for cancellation'
      USING ERRCODE = '23505';
  END IF;
  IF NOT selected_identity.is_demo THEN
    IF selected_identity.email_verified_at IS NULL
      AND selected_identity.password_hash = '!invitation-pending!' THEN
      reset_incomplete_enrollment := false;
    ELSIF selected_identity.email_verified_at IS NOT NULL
      AND selected_identity.password_hash LIKE 'scrypt-v1$32768$8$1$%'
      AND (
        EXISTS (
          SELECT 1 FROM auth_mfa_factors factor
          WHERE factor.user_id = selected_identity.id
            AND factor.status = 'PENDING'
        ) OR EXISTS (
          SELECT 1 FROM auth_one_time_tokens setup_token
          WHERE setup_token.user_id = selected_identity.id
            AND setup_token.organization_id = administrator.organization_id
            AND setup_token.purpose = 'MFA_SETUP'
            AND setup_token.consumed_at IS NULL
        )
      ) THEN
      reset_incomplete_enrollment := true;
    ELSE
      RAISE EXCEPTION 'The invitation identity is no longer available for cancellation'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  UPDATE auth_one_time_tokens
  SET consumed_at = coalesce(consumed_at, now())
  WHERE user_id = selected_invitation.user_id
    AND organization_id = administrator.organization_id
    AND purpose IN ('INVITATION', 'MFA_SETUP')
    AND consumed_at IS NULL;
  UPDATE auth_email_outbox SET
    status = 'DEAD', lease_owner = NULL, lease_expires_at = NULL,
    last_error_code = 'CANCELLED'
  WHERE user_id = selected_invitation.user_id
    AND organization_id = administrator.organization_id
    AND template_type = 'INVITATION'
    AND status IN ('PENDING', 'SENDING');
  UPDATE auth_mfa_factors SET
    status = 'REVOKED', revoked_at = coalesce(revoked_at, now())
  WHERE user_id = selected_invitation.user_id AND status = 'PENDING';
  IF reset_incomplete_enrollment THEN
    UPDATE users SET
      password_hash = '!invitation-pending!',
      password_changed_at = NULL,
      email_verified_at = NULL,
      active = false,
      mfa_required = true
    WHERE id = selected_identity.id
      AND NOT active AND NOT is_demo;
  END IF;
  UPDATE organization_invitations SET
    status = 'CANCELLED', cancelled_at = now(), updated_at = now(),
    version = version + 1
  WHERE id = selected_invitation.id
  RETURNING organization_invitations.version INTO next_version;

  IF NOT selected_identity.is_demo THEN
    INSERT INTO auth_security_events(
      user_id, organization_id, session_id, event_type, outcome,
      request_id, metadata
    ) VALUES (
      administrator.actor_id, administrator.organization_id,
      administrator.session_id, 'ORGANIZATION_INVITATION_CANCELLED',
      'SUCCESS', current_setting('app.request_id', true),
      jsonb_build_object(
        'targetUserId', selected_identity.id,
        'enrollmentReset', reset_incomplete_enrollment
      )
    );
  END IF;

  PERFORM app.append_tenant_business_audit(
    administrator.organization_id,
    'organization.invitation-cancelled',
    'organization_membership',
    selected_invitation.membership_id::text,
    jsonb_build_object(
      'invitationId', selected_invitation.id,
      'version', next_version
    ),
    'organization.invitation-cancelled'
  );
  RETURN next_version;
END
$$;
REVOKE ALL ON FUNCTION app.organization_cancel_invitation(uuid, integer) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_member_is_last_owner(
  selected_organization_id uuid,
  selected_membership_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_memberships membership
    JOIN membership_roles assignment
      ON assignment.organization_id = membership.organization_id
     AND assignment.membership_id = membership.id
    JOIN roles role
      ON role.organization_id = assignment.organization_id
     AND role.id = assignment.role_id
    WHERE membership.organization_id = selected_organization_id
      AND membership.id = selected_membership_id
      AND membership.active AND role.active
      AND role.key IN ('OWNER', 'demo_accountant')
  ) AND NOT EXISTS (
    SELECT 1
    FROM organization_memberships other_membership
    JOIN membership_roles other_assignment
      ON other_assignment.organization_id = other_membership.organization_id
     AND other_assignment.membership_id = other_membership.id
    JOIN roles other_role
      ON other_role.organization_id = other_assignment.organization_id
     AND other_role.id = other_assignment.role_id
    WHERE other_membership.organization_id = selected_organization_id
      AND other_membership.id <> selected_membership_id
      AND other_membership.active AND other_role.active
      AND other_role.key IN ('OWNER', 'demo_accountant')
  )
$$;
REVOKE ALL ON FUNCTION app.organization_member_is_last_owner(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_member_is_last_recovery_admin(
  selected_organization_id uuid,
  selected_membership_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_memberships membership
    JOIN membership_roles assignment
      ON assignment.organization_id = membership.organization_id
     AND assignment.membership_id = membership.id
    JOIN roles role
      ON role.organization_id = assignment.organization_id
     AND role.id = assignment.role_id AND role.active
    JOIN role_permissions permission_assignment
      ON permission_assignment.organization_id = role.organization_id
     AND permission_assignment.role_id = role.id
     AND permission_assignment.permission_key = 'organization.recovery.manage'
    WHERE membership.organization_id = selected_organization_id
      AND membership.id = selected_membership_id
      AND membership.active
  ) AND EXISTS (
    SELECT 1 FROM organizations organization
    WHERE organization.id = selected_organization_id
      AND NOT organization.is_demo
  ) AND NOT EXISTS (
    SELECT 1
    FROM organization_memberships other_membership
    JOIN membership_roles other_assignment
      ON other_assignment.organization_id = other_membership.organization_id
     AND other_assignment.membership_id = other_membership.id
    JOIN roles other_role
      ON other_role.organization_id = other_assignment.organization_id
     AND other_role.id = other_assignment.role_id AND other_role.active
    JOIN role_permissions other_permission
      ON other_permission.organization_id = other_role.organization_id
     AND other_permission.role_id = other_role.id
     AND other_permission.permission_key = 'organization.recovery.manage'
    WHERE other_membership.organization_id = selected_organization_id
      AND other_membership.id <> selected_membership_id
      AND other_membership.active
  )
$$;
REVOKE ALL ON FUNCTION app.organization_member_is_last_recovery_admin(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_assign_member_role(
  selected_membership_id uuid,
  selected_role_id uuid,
  expected_version integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
  selected_membership organization_memberships%ROWTYPE;
  selected_role roles%ROWTYPE;
  current_role roles%ROWTYPE;
  selected_role_has_recovery boolean;
  current_role_has_recovery boolean;
  current_role_has_owner boolean;
  current_role_count integer;
  next_version integer;
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.roles.manage', true);
  IF NOT app.organization_admin_actor_has_permission(
    administrator.organization_id, administrator.actor_id,
    'organization.members.manage'
  ) THEN
    RAISE EXCEPTION 'Member-administration permission is required'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_membership
  FROM organization_memberships
  WHERE id = selected_membership_id
    AND organization_id = administrator.organization_id
  FOR UPDATE;
  IF selected_membership.id IS NULL THEN
    RAISE EXCEPTION 'The organization member is unavailable' USING ERRCODE = '22023';
  END IF;
  IF selected_membership.user_id = administrator.actor_id THEN
    RAISE EXCEPTION 'Administrators cannot change their own fixed role'
      USING ERRCODE = '42501';
  END IF;
  IF selected_membership.administration_version <> expected_version THEN
    RAISE EXCEPTION 'Member administration version changed by another administrator'
      USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM organization_invitations invitation
    WHERE invitation.organization_id = administrator.organization_id
      AND invitation.membership_id = selected_membership.id
      AND invitation.status = 'SUPERSEDED'
  ) THEN
    RAISE EXCEPTION 'A superseded invitation membership is immutable'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO selected_role FROM roles
  WHERE id = selected_role_id
    AND organization_id = administrator.organization_id
    AND active AND system_template
    AND key IN (
      'OWNER', 'ORGANIZATION_ADMIN', 'ACCOUNTANT_APPROVER',
      'BOOKKEEPER_MAKER', 'VIEWER_AUDITOR'
    )
  FOR SHARE;
  IF selected_role.id IS NULL THEN
    RAISE EXCEPTION 'The selected fixed role is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT role.* INTO current_role
  FROM membership_roles assignment
  JOIN roles role
    ON role.organization_id = assignment.organization_id
   AND role.id = assignment.role_id
  WHERE assignment.organization_id = administrator.organization_id
    AND assignment.membership_id = selected_membership.id
  ORDER BY CASE role.key
    WHEN 'OWNER' THEN 1
    WHEN 'demo_accountant' THEN 2
    WHEN 'ORGANIZATION_ADMIN' THEN 3
    WHEN 'ACCOUNTANT_APPROVER' THEN 4
    WHEN 'BOOKKEEPER_MAKER' THEN 5
    WHEN 'VIEWER_AUDITOR' THEN 6
    ELSE 10
  END, role.key
  LIMIT 1;
  SELECT count(*) INTO current_role_count
  FROM membership_roles assignment
  WHERE assignment.organization_id = administrator.organization_id
    AND assignment.membership_id = selected_membership.id;
  IF current_role.id = selected_role.id AND current_role_count = 1 THEN
    RETURN selected_membership.administration_version;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM role_permissions
    WHERE organization_id = administrator.organization_id
      AND role_id = selected_role.id
      AND permission_key = 'organization.recovery.manage'
  ) INTO selected_role_has_recovery;
  SELECT EXISTS (
    SELECT 1
    FROM membership_roles assignment
    JOIN role_permissions permission_assignment
      ON permission_assignment.organization_id = assignment.organization_id
     AND permission_assignment.role_id = assignment.role_id
    WHERE assignment.organization_id = administrator.organization_id
      AND assignment.membership_id = selected_membership.id
      AND permission_assignment.permission_key = 'organization.recovery.manage'
  ) INTO current_role_has_recovery;
  SELECT EXISTS (
    SELECT 1
    FROM membership_roles assignment
    JOIN roles assigned_role
      ON assigned_role.organization_id = assignment.organization_id
     AND assigned_role.id = assignment.role_id
    WHERE assignment.organization_id = administrator.organization_id
      AND assignment.membership_id = selected_membership.id
      AND assigned_role.active
      AND assigned_role.key IN ('OWNER', 'demo_accountant')
  ) INTO current_role_has_owner;
  IF (selected_role_has_recovery OR current_role_has_recovery)
    AND NOT administrator.is_demo
    AND NOT app.organization_admin_actor_has_permission(
      administrator.organization_id, administrator.actor_id,
      'organization.recovery.manage'
    ) THEN
    RAISE EXCEPTION 'Recovery-administration permission is required for this role change'
      USING ERRCODE = '42501';
  END IF;
  IF selected_membership.active
    AND current_role_has_owner AND selected_role.key <> 'OWNER'
    AND app.organization_member_is_last_owner(
      administrator.organization_id, selected_membership.id
    ) THEN
    RAISE EXCEPTION 'The last active owner role cannot be removed'
      USING ERRCODE = '23514';
  END IF;
  IF selected_membership.active
    AND current_role_has_recovery AND NOT selected_role_has_recovery
    AND app.organization_member_is_last_recovery_admin(
      administrator.organization_id, selected_membership.id
    ) THEN
    RAISE EXCEPTION 'The last active recovery administrator cannot be removed'
      USING ERRCODE = '23514';
  END IF;

  DELETE FROM membership_roles
  WHERE organization_id = administrator.organization_id
    AND membership_id = selected_membership.id;
  INSERT INTO membership_roles(
    organization_id, membership_id, role_id, assigned_by
  ) VALUES (
    administrator.organization_id, selected_membership.id,
    selected_role.id, administrator.actor_id
  );
  UPDATE organization_invitations SET
    role_id = selected_role.id, updated_at = now(), version = version + 1
  WHERE organization_id = administrator.organization_id
    AND membership_id = selected_membership.id
    AND status IN ('PENDING', 'CANCELLED');
  UPDATE organization_memberships SET
    administration_version = administration_version + 1
  WHERE id = selected_membership.id
  RETURNING administration_version INTO next_version;
  UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
  WHERE organization_id = administrator.organization_id
    AND membership_id = selected_membership.id
    AND revoked_at IS NULL;

  PERFORM app.append_tenant_business_audit(
    administrator.organization_id,
    'organization.member-role-changed',
    'organization_membership',
    selected_membership.id::text,
    jsonb_build_object(
      'fromRoleId', current_role.id,
      'toRoleId', selected_role.id,
      'version', next_version,
      'sessionsRevoked', true
    ),
    'organization.member-role-changed'
  );
  RETURN next_version;
END
$$;
REVOKE ALL ON FUNCTION app.organization_assign_member_role(uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint

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
      IF selected_user.email_verified_at IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM auth_mfa_factors factor
          WHERE factor.user_id = selected_user.id
            AND factor.factor_type = 'TOTP' AND factor.status = 'ACTIVE'
            AND factor.verified_at IS NOT NULL AND factor.revoked_at IS NULL
        ) THEN
        RAISE EXCEPTION 'The member must complete invitation and MFA enrollment first'
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
REVOKE ALL ON FUNCTION app.organization_set_member_active(uuid, integer, boolean) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_revoke_member_sessions(
  selected_membership_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
  selected_membership organization_memberships%ROWTYPE;
  revoked_count bigint;
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.members.manage', true);
  SELECT * INTO selected_membership
  FROM organization_memberships
  WHERE id = selected_membership_id
    AND organization_id = administrator.organization_id
  FOR SHARE;
  IF selected_membership.id IS NULL THEN
    RAISE EXCEPTION 'The organization member is unavailable' USING ERRCODE = '22023';
  END IF;
  IF selected_membership.user_id = administrator.actor_id THEN
    RAISE EXCEPTION 'Use sign out to revoke your own session'
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
    RAISE EXCEPTION 'Recovery-administration permission is required to revoke these sessions'
      USING ERRCODE = '42501';
  END IF;

  WITH revoked AS (
    UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
    WHERE organization_id = administrator.organization_id
      AND membership_id = selected_membership.id
      AND revoked_at IS NULL
    RETURNING id
  ) SELECT count(*)::bigint INTO revoked_count FROM revoked;
  PERFORM app.append_tenant_business_audit(
    administrator.organization_id,
    'organization.member-sessions-revoked',
    'organization_membership',
    selected_membership.id::text,
    jsonb_build_object('revokedCount', revoked_count),
    'organization.member-sessions-revoked'
  );
  RETURN revoked_count;
END
$$;
REVOKE ALL ON FUNCTION app.organization_revoke_member_sessions(uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_mark_invitation_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.active AND NOT OLD.active THEN
    UPDATE organization_invitations SET
      status = 'ACCEPTED', accepted_at = now(), updated_at = now(),
      version = version + 1
    WHERE organization_id = NEW.organization_id
      AND membership_id = NEW.id
      AND status = 'PENDING';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.organization_mark_invitation_accepted() FROM PUBLIC;
CREATE TRIGGER organization_membership_accepts_invitation
  AFTER UPDATE OF active ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION app.organization_mark_invitation_accepted();
--> statement-breakpoint

-- Verified self-signup wins over an unused invitation placeholder. Signup 0013
-- consumes the invitation/setup tokens, dead-letters unsent invitation email,
-- and revokes pending factors while holding the same deterministic user lock;
-- this trigger retains an irreversible terminal invitation record.
CREATE OR REPLACE FUNCTION app.organization_cancel_invitation_for_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'PENDING' AND NEW.status = 'ENROLLING' THEN
    UPDATE organization_invitations SET
      status = 'SUPERSEDED', cancelled_at = coalesce(cancelled_at, now()),
      updated_at = now(),
      version = version + 1
    WHERE user_id = NEW.user_id AND status IN ('PENDING', 'CANCELLED');
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.organization_cancel_invitation_for_signup() FROM PUBLIC;
CREATE TRIGGER organization_signup_cancels_unused_invitation
  AFTER UPDATE OF status ON auth_organization_signups
  FOR EACH ROW EXECUTE FUNCTION app.organization_cancel_invitation_for_signup();
--> statement-breakpoint

-- Migration 0012 intentionally created this owner-only extension hook. Runtime
-- users cannot invoke it. Nightly reset calls it after organization-owned table
-- purges, with the canonical demo_accountant user that must be retained.
CREATE OR REPLACE FUNCTION app.reset_demo_sandbox_extensions(
  selected_organization_id uuid,
  canonical_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  extra_user_ids uuid[];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM organizations organization
    JOIN organization_memberships membership
      ON membership.organization_id = organization.id
     AND membership.user_id = canonical_user_id
    JOIN membership_roles assignment
      ON assignment.organization_id = membership.organization_id
     AND assignment.membership_id = membership.id
    JOIN roles role
      ON role.organization_id = assignment.organization_id
     AND role.id = assignment.role_id
    WHERE organization.id = selected_organization_id
      AND organization.is_demo
      AND organization.organization_mode = 'SANDBOX'
      AND role.key = 'demo_accountant'
  ) THEN
    RAISE EXCEPTION 'Demo extension reset requires the canonical sandbox identity';
  END IF;

  SELECT coalesce(array_agg(membership.user_id), ARRAY[]::uuid[])
  INTO extra_user_ids
  FROM organization_memberships membership
  WHERE membership.organization_id = selected_organization_id
    AND membership.user_id <> canonical_user_id;

  DELETE FROM organization_invitations
  WHERE organization_id = selected_organization_id;
  DELETE FROM auth_recovery_requests
  WHERE organization_id = selected_organization_id
    OR user_id IN (
      SELECT membership.user_id FROM organization_memberships membership
      WHERE membership.organization_id = selected_organization_id
        AND membership.user_id <> canonical_user_id
    );
  DELETE FROM auth_email_outbox
  WHERE organization_id = selected_organization_id
    AND user_id <> canonical_user_id;
  DELETE FROM auth_mfa_factors
  WHERE user_id IN (
    SELECT membership.user_id FROM organization_memberships membership
    WHERE membership.organization_id = selected_organization_id
      AND membership.user_id <> canonical_user_id
  );
  DELETE FROM auth_one_time_tokens
  WHERE organization_id = selected_organization_id
    AND user_id <> canonical_user_id;
  DELETE FROM auth_sessions
  WHERE organization_id = selected_organization_id
    AND user_id <> canonical_user_id;
  DELETE FROM membership_roles
  WHERE organization_id = selected_organization_id
    AND membership_id IN (
      SELECT membership.id FROM organization_memberships membership
      WHERE membership.organization_id = selected_organization_id
        AND membership.user_id <> canonical_user_id
    );
  DELETE FROM organization_memberships
  WHERE organization_id = selected_organization_id
    AND user_id <> canonical_user_id;
  DELETE FROM users selected_user
  WHERE selected_user.id = ANY(extra_user_ids)
    AND selected_user.is_demo
    AND NOT EXISTS (
      SELECT 1 FROM organization_memberships remaining
      WHERE remaining.user_id = selected_user.id
    );

  UPDATE organizations organization SET
    display_name = 'Northstar Demo Sandbox ' || lpad(slot.slot::text, 3, '0'),
    settings_version = 1,
    updated_at = now()
  FROM demo_sandbox_slots slot
  WHERE organization.id = selected_organization_id
    AND slot.organization_id = organization.id;
END
$$;
REVOKE ALL ON FUNCTION app.reset_demo_sandbox_extensions(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON organization_invitations FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION
      app.organization_settings_read(),
      app.organization_members_read(),
      app.organization_update_settings(text, integer),
      app.organization_invite_member(
        uuid, uuid, uuid, uuid, text, text, text, uuid, text, uuid, text
      ),
      app.organization_resend_invitation(
        uuid, integer, uuid, text, uuid, text
      ),
      app.organization_cancel_invitation(uuid, integer),
      app.organization_assign_member_role(uuid, uuid, integer),
      app.organization_set_member_active(uuid, integer, boolean),
      app.organization_revoke_member_sessions(uuid)
      TO business_finlynq_app;
  END IF;
END
$$;
