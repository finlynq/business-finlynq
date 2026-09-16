-- Journal administration is an owner-only correction capability. Earlier
-- deployments also assigned it to the organization-admin template; remove that
-- assignment and keep future template synchronization owner-only.
UPDATE permissions
SET description = 'Owner-only unpost and tombstone controls for eligible manual general-ledger transactions'
WHERE key = 'ledger.journal.administer';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assign_journal_admin_template_permission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.active AND NEW.key = 'OWNER' THEN
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key)
    VALUES (NEW.organization_id, NEW.id, 'ledger.journal.administer')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.assign_journal_admin_template_permission() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_journal_admin_template_permission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.permission_key = 'ledger.journal.administer' AND EXISTS (
    SELECT 1 FROM public.roles role
    WHERE role.organization_id = OLD.organization_id
      AND role.id = OLD.role_id AND role.active AND role.key = 'OWNER'
  ) THEN
    RAISE EXCEPTION 'Active owner roles must retain ledger.journal.administer'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION app.guard_journal_admin_template_permission() FROM PUBLIC;
--> statement-breakpoint
DELETE FROM role_permissions assignment
USING roles role
WHERE assignment.organization_id = role.organization_id
  AND assignment.role_id = role.id
  AND assignment.permission_key = 'ledger.journal.administer'
  AND role.key = 'ORGANIZATION_ADMIN';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_journal_transaction_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships membership
    JOIN public.membership_roles membership_role
      ON membership_role.organization_id = membership.organization_id
     AND membership_role.membership_id = membership.id
    JOIN public.roles role
      ON role.organization_id = membership_role.organization_id
     AND role.id = membership_role.role_id
    WHERE membership.organization_id = NEW.organization_id
      AND membership.user_id = NEW.actor_id
      AND membership.active AND role.active AND role.key = 'OWNER'
  ) THEN
    RAISE EXCEPTION 'Journal administration requires an active organization owner'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_journal_transaction_owner() FROM PUBLIC;
DROP TRIGGER IF EXISTS journal_transaction_controls_owner_guard
  ON journal_transaction_controls;
CREATE TRIGGER journal_transaction_controls_owner_guard
  BEFORE INSERT ON journal_transaction_controls
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_transaction_owner();
--> statement-breakpoint

-- A direct-write MCP authorization is deliberately durable beyond the ten-minute
-- browser MFA window. Revalidate the exact live connection at the database
-- boundary instead of treating the historical browser session as still live.
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
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  selected_organization_id uuid;
  selected_actor_id uuid;
  selected_session_id uuid;
  selected_mcp_connection_id uuid;
  selected_organization organizations%ROWTYPE;
  selected_session auth_sessions%ROWTYPE;
  selected_mcp_connection mcp_connections%ROWTYPE;
  uses_persistent_mcp_authorization boolean := false;
BEGIN
  selected_organization_id := app.current_organization_id();
  selected_actor_id := app.current_actor_id();
  BEGIN
    selected_session_id := nullif(current_setting('app.session_id', true), '')::uuid;
    selected_mcp_connection_id := nullif(
      current_setting('app.mcp_connection_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Organization administration requires an active authorization context'
      USING ERRCODE = '28000';
  END;
  IF selected_session_id IS NULL THEN
    RAISE EXCEPTION 'Organization administration requires an active authorization context'
      USING ERRCODE = '28000';
  END IF;

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

  IF selected_organization.id IS NOT NULL
    AND selected_mcp_connection_id IS NOT NULL
    AND coalesce(current_setting('app.source_surface', true), '') = 'MCP' THEN
    SELECT connection.* INTO selected_mcp_connection
    FROM mcp_connections connection
    JOIN organization_memberships membership
      ON membership.organization_id = connection.organization_id
     AND membership.id = connection.membership_id
     AND membership.user_id = connection.user_id
     AND membership.active
    WHERE connection.organization_id = selected_organization_id
      AND connection.id = selected_mcp_connection_id
      AND connection.user_id = selected_actor_id
      AND connection.revoked_at IS NULL
      AND connection.direct_write_session_id = selected_session_id
      AND connection.direct_write_step_up_expires_at IS NOT NULL
      AND (connection.daily_mode = 'ALLOW_WRITES'
        OR connection.setup_mode = 'ALLOW_WRITES'
        OR EXISTS (
          SELECT 1 FROM jsonb_each_text(connection.tool_overrides) override
          WHERE override.value = 'ALLOW_WRITES'
        ))
    FOR SHARE OF connection, membership;
    uses_persistent_mcp_authorization := selected_mcp_connection.id IS NOT NULL;
  END IF;

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
    OR (
      NOT uses_persistent_mcp_authorization
      AND (
        selected_session.revoked_at IS NOT NULL
        OR selected_session.expires_at <= now()
        OR selected_session.idle_expires_at <= now()
      )
    ) THEN
    RAISE EXCEPTION 'Organization administration requires an active authorization context'
      USING ERRCODE = '28000';
  END IF;

  IF selected_organization.is_demo THEN
    IF uses_persistent_mcp_authorization
      OR selected_organization.organization_mode <> 'PUBLIC_DEMO'
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
      coalesce(current_setting('app.auth_method', true), '')
        NOT IN ('password+mfa', 'oidc+mfa')
      OR (
        NOT uses_persistent_mcp_authorization
        AND (
          selected_session.step_up_expires_at IS NULL
          OR selected_session.step_up_expires_at <= now()
        )
      )
    ) THEN
      RAISE EXCEPTION 'Organization administration requires MFA-backed authorization'
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

-- Account validity is effective-dated master data, not immutable identity.
-- Expanding validity earlier preserves history; contracting it must not make an
-- existing journal or bank mapping predate the account.
CREATE OR REPLACE FUNCTION app.guard_used_gl_account_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM account_combinations combination
    JOIN journal_lines line ON line.account_combination_id = combination.id
    WHERE combination.account_id = OLD.id
  ) AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.ledger_id IS DISTINCT FROM OLD.ledger_id OR
    NEW.code IS DISTINCT FROM OLD.code OR
    NEW.class IS DISTINCT FROM OLD.class OR
    NEW.control_kind IS DISTINCT FROM OLD.control_kind
  ) THEN
    RAISE EXCEPTION 'A general-ledger account identity is immutable after journal use'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.valid_from > OLD.valid_from AND (
    EXISTS (
      SELECT 1
      FROM account_combinations combination
      JOIN journal_lines line ON line.account_combination_id = combination.id
      JOIN journal_entries entry ON entry.id = line.journal_entry_id
      WHERE combination.account_id = OLD.id
        AND entry.accounting_date < NEW.valid_from
    ) OR EXISTS (
      SELECT 1
      FROM account_combinations combination
      JOIN source_documents document
        ON document.organization_id = combination.organization_id
       AND (
         document.snapshot->>'controlAccountCombinationId' = combination.id::text
         OR document.snapshot->>'taxAccountCombinationId' = combination.id::text
         OR document.snapshot->>'fxRoundingAccountCombinationId' = combination.id::text
         OR document.snapshot->>'bankAccountCombinationId' = combination.id::text
         OR document.snapshot->>'settlementAccountCombinationId' = combination.id::text
         OR document.snapshot->>'realizedFxGainAccountCombinationId' = combination.id::text
         OR document.snapshot->>'realizedFxLossAccountCombinationId' = combination.id::text
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(
             coalesce(document.snapshot->'lines', '[]'::jsonb)
           ) line
           WHERE line->>'accountCombinationId' = combination.id::text
         )
       )
      WHERE combination.account_id = OLD.id
        AND (document.snapshot->>'accountingDate')::date < NEW.valid_from
    ) OR EXISTS (
      SELECT 1
      FROM account_combinations combination
      JOIN bank_external_accounts external_account
        ON external_account.organization_id = combination.organization_id
       AND external_account.cash_account_combination_id = combination.id
      WHERE combination.account_id = OLD.id
        AND external_account.created_at::date < NEW.valid_from
    )
  ) THEN
    RAISE EXCEPTION 'Account validity cannot start after an existing accounting dependency'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.valid_to IS NOT NULL AND EXISTS (
    SELECT 1
    FROM account_combinations combination
    JOIN journal_lines line ON line.account_combination_id = combination.id
    JOIN journal_entries entry ON entry.id = line.journal_entry_id
    WHERE combination.account_id = OLD.id
      AND entry.accounting_date > NEW.valid_to
  ) THEN
    RAISE EXCEPTION 'Account validity cannot be ended before an existing journal date'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_used_gl_account_identity() FROM PUBLIC;
