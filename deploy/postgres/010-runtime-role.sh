#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

if [ -n "${APP_DATABASE_PASSWORD_FILE:-}" ]; then
  if [ ! -r "$APP_DATABASE_PASSWORD_FILE" ]; then
    echo "APP_DATABASE_PASSWORD_FILE must name a readable secret file" >&2
    exit 1
  fi
  password_line_count="$(awk 'END { print NR }' "$APP_DATABASE_PASSWORD_FILE")"
  if [ "$password_line_count" -ne 1 ]; then
    echo "APP_DATABASE_PASSWORD_FILE must contain exactly one line" >&2
    exit 1
  fi
  APP_DATABASE_PASSWORD=""
  IFS= read -r APP_DATABASE_PASSWORD < "$APP_DATABASE_PASSWORD_FILE" || [ -n "$APP_DATABASE_PASSWORD" ]
  if [ "$APP_DATABASE_PASSWORD_FILE" = /run/business-finlynq-init/app-db-password ]; then
    rm -f -- "$APP_DATABASE_PASSWORD_FILE"
    [ ! -e "$APP_DATABASE_PASSWORD_FILE" ] \
      || { echo "The temporary application database password could not be removed" >&2; exit 1; }
  fi
else
  : "${APP_DATABASE_PASSWORD:?APP_DATABASE_PASSWORD or APP_DATABASE_PASSWORD_FILE is required}"
fi

carriage_return="$(printf '\r')"
case "$APP_DATABASE_PASSWORD" in
  *'
'*|*"$carriage_return"*)
    echo "The application database password must be a single line" >&2
    exit 1
    ;;
esac
password_length=${#APP_DATABASE_PASSWORD}
if [ "$password_length" -lt 24 ] || [ "$password_length" -gt 1024 ]; then
  echo "The application database password must contain 24 to 1024 characters" >&2
  exit 1
fi

# Keep the password out of the psql command line. psql imports it into an
# escaped SQL variable from this short-lived process environment.
BUSINESS_FINLYNQ_RECONCILE_PASSWORD="$APP_DATABASE_PASSWORD"
export BUSINESS_FINLYNQ_RECONCILE_PASSWORD
unset APP_DATABASE_PASSWORD
trap 'unset BUSINESS_FINLYNQ_RECONCILE_PASSWORD' EXIT HUP INT TERM

# Safe to rerun after migrations or an ACL-free restore. Future objects get no
# implicit app access; every new grant must be reviewed and listed below.
psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=db_name="$POSTGRES_DB" \
  --set=owner_role="$POSTGRES_USER" \
  <<-'SQL'
\getenv app_password BUSINESS_FINLYNQ_RECONCILE_PASSWORD
DO $owner_check$
BEGIN
  IF current_user <> (
    SELECT pg_get_userbyid(database.datdba)
    FROM pg_database database
    WHERE database.datname = current_database()
  ) THEN
    RAISE EXCEPTION 'Runtime grant reconciliation must run as the database owner';
  END IF;
END
$owner_check$;

SELECT format(
  'CREATE ROLE business_finlynq_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app')
\gexec

ALTER ROLE business_finlynq_app
  LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 20;

-- NOINHERIT alone is insufficient: a login may SET ROLE to any role it is a
-- member of. Remove both directions so a legacy restore cannot retain an
-- unreviewed privilege path into or out of the web runtime identity.
SELECT format('REVOKE %I FROM business_finlynq_app', granted_role.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
JOIN pg_roles member_role ON member_role.oid = membership.member
WHERE member_role.rolname = 'business_finlynq_app'
\gexec

SELECT format('REVOKE business_finlynq_app FROM %I', member_role.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
JOIN pg_roles member_role ON member_role.oid = membership.member
WHERE granted_role.rolname = 'business_finlynq_app'
\gexec

REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE :"db_name" FROM business_finlynq_app;
-- PostgreSQL grants PUBLIC schema USAGE by default. Remove the shared grant so
-- every service identity receives only its reviewed schema access explicitly.
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM business_finlynq_app;
GRANT CONNECT ON DATABASE :"db_name" TO business_finlynq_app;
GRANT USAGE ON SCHEMA public TO business_finlynq_app;

ALTER ROLE business_finlynq_app SET statement_timeout = '15s';
ALTER ROLE business_finlynq_app SET lock_timeout = '5s';
ALTER ROLE business_finlynq_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE business_finlynq_app SET search_path = public, app;

-- Remove the former blanket future-object CRUD grants. New objects fail
-- closed until this reviewed reconciliation list is deliberately extended.
-- PostgreSQL combines global and per-schema default ACLs. A per-schema REVOKE
-- cannot subtract the built-in global PUBLIC EXECUTE default for functions, so
-- clear the owner's global defaults before removing any legacy schema entries.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role"
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role"
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role"
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role"
  REVOKE ALL ON TABLES FROM business_finlynq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role"
  REVOKE ALL ON SEQUENCES FROM business_finlynq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role"
  REVOKE ALL ON FUNCTIONS FROM business_finlynq_app;

ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  REVOKE ALL ON TABLES FROM business_finlynq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM business_finlynq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM business_finlynq_app;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM business_finlynq_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM business_finlynq_app;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM business_finlynq_app;

-- Table-level REVOKE does not remove independently granted column ACLs.
-- Generate one valid column-privilege REVOKE for every stale PUBLIC/runtime
-- entry before the reviewed whole-table allowlist is applied below.
SELECT format(
  'REVOKE %s (%I) ON TABLE %I.%I FROM PUBLIC',
  privilege.privilege_type,
  attribute.attname,
  namespace.nspname,
  relation.relname
)
FROM pg_attribute attribute
JOIN pg_class relation ON relation.oid = attribute.attrelid
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL aclexplode(
  CASE WHEN array_ndims(attribute.attacl) = 1 THEN attribute.attacl ELSE NULL::aclitem[] END
) privilege
WHERE namespace.nspname IN ('public', 'app')
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND privilege.grantee = 0
ORDER BY namespace.nspname, relation.relname, attribute.attnum, privilege.privilege_type
\gexec

SELECT format(
  'REVOKE %s (%I) ON TABLE %I.%I FROM business_finlynq_app',
  privilege.privilege_type,
  attribute.attname,
  namespace.nspname,
  relation.relname
)
FROM pg_attribute attribute
JOIN pg_class relation ON relation.oid = attribute.attrelid
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL aclexplode(
  CASE WHEN array_ndims(attribute.attacl) = 1 THEN attribute.attacl ELSE NULL::aclitem[] END
) privilege
JOIN pg_roles selected_role ON selected_role.rolname = 'business_finlynq_app'
WHERE namespace.nspname IN ('public', 'app')
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND privilege.grantee = selected_role.oid
ORDER BY namespace.nspname, relation.relname, attribute.attnum, privilege.privilege_type
\gexec

DO $reconcile$
DECLARE
  selected_name text;
  selected_signature text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') THEN
    REVOKE ALL ON SCHEMA app FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON SCHEMA app FROM business_finlynq_app;
    GRANT USAGE ON SCHEMA app TO business_finlynq_app;
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA app FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC;
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA app FROM business_finlynq_app;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA app FROM business_finlynq_app;
    REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA app FROM business_finlynq_app;
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app REVOKE ALL ON TABLES FROM PUBLIC',
      current_user
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app REVOKE ALL ON SEQUENCES FROM PUBLIC',
      current_user
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
      current_user
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app REVOKE ALL ON TABLES FROM business_finlynq_app',
      current_user
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app REVOKE ALL ON SEQUENCES FROM business_finlynq_app',
      current_user
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app REVOKE ALL ON FUNCTIONS FROM business_finlynq_app',
      current_user
    );
  END IF;

  -- Reads needed by the tenant DAL and invoker-security validators. Sensitive
  -- user/auth, audit-outbox, and email-delivery tables are absent.
  FOREACH selected_name IN ARRAY ARRAY[
    'organizations', 'organization_memberships', 'roles',
    'membership_roles', 'role_permissions', 'permissions',
    'organization_key_versions', 'legal_entities', 'ledgers',
    'currency_definitions', 'organization_currencies',
    'currency_exchange_rates', 'organization_fx_provider_policy_versions',
    'fiscal_periods', 'period_events', 'ledger_number_sequences',
    'ledger_posting_policies', 'gl_accounts', 'segment_definitions',
    'segment_values', 'account_combinations',
    'accounting_hierarchies', 'accounting_hierarchy_nodes',
    'journal_type_definitions',
    'source_documents', 'document_evidence_assets', 'journal_entries', 'journal_approvals',
    'journal_lines', 'journal_entry_relations', 'parties',
    'party_addresses', 'party_accounts', 'subledger_events', 'open_items',
    'document_settlement_allocations', 'open_item_void_events',
    'open_item_balances',
    'tax_pack_versions', 'entity_tax_registrations',
    'tax_determination_snapshots',
    'bank_connections', 'bank_connection_credential_events', 'bank_external_accounts', 'bank_sync_runs',
    'bank_observations', 'bank_observation_versions', 'bank_balance_anchors',
    'bank_reconciliation_sessions', 'bank_reconciliation_voids', 'bank_match_allocations',
    'bank_match_allocation_voids', 'bank_rules', 'bank_rule_runs',
    'bank_draft_proposals', 'mcp_oauth_clients', 'mcp_connections',
    'mcp_oauth_codes', 'mcp_access_tokens', 'mcp_refresh_tokens',
    'mcp_approvals', 'mcp_tool_executions',
    'document_storage_connections', 'document_storage_oauth', 'document_inbox_items'
  ] LOOP
    IF to_regclass(format('public.%I', selected_name)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO business_finlynq_app', selected_name);
    END IF;
  END LOOP;

  -- Only controlled transactional paths receive direct mutation privileges.
  -- No application table receives DELETE.
  FOREACH selected_name IN ARRAY ARRAY[
    'journal_entries', 'journal_lines', 'parties', 'party_addresses',
    'party_accounts', 'gl_accounts',
    'ledger_posting_policies', 'ledger_number_sequences',
    'bank_connections', 'bank_external_accounts', 'bank_sync_runs',
    'bank_reconciliation_sessions', 'mcp_connections', 'mcp_oauth_codes',
    'mcp_access_tokens', 'mcp_refresh_tokens', 'mcp_approvals',
    'mcp_tool_executions',
    'document_storage_connections', 'document_storage_oauth', 'document_inbox_items'
  ] LOOP
    IF to_regclass(format('public.%I', selected_name)) IS NOT NULL THEN
      EXECUTE format('GRANT INSERT, UPDATE ON TABLE public.%I TO business_finlynq_app', selected_name);
    END IF;
  END LOOP;

  FOREACH selected_name IN ARRAY ARRAY[
    'journal_approvals', 'journal_entry_relations', 'source_documents', 'document_evidence_assets',
    'subledger_events', 'open_items', 'document_settlement_allocations',
    'open_item_void_events',
    'tax_determination_snapshots',
    'bank_connection_credential_events',
    'bank_observations', 'bank_observation_versions', 'bank_balance_anchors',
    'bank_reconciliation_voids', 'bank_match_allocations', 'bank_match_allocation_voids', 'bank_rules',
    'bank_rule_runs', 'bank_draft_proposals', 'mcp_oauth_clients'
  ] LOOP
    IF to_regclass(format('public.%I', selected_name)) IS NOT NULL THEN
      EXECUTE format('GRANT INSERT ON TABLE public.%I TO business_finlynq_app', selected_name);
    END IF;
  END LOOP;

  IF to_regclass('public.fiscal_periods') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.fiscal_periods TO business_finlynq_app;
  END IF;

  -- Directly called and invoker-security helper APIs only. Trigger-only and
  -- worker-only functions remain non-executable by the web application. The
  -- two pgcrypto digest overloads are required by invoker-security accounting
  -- hashes and constraint triggers; no other extension function is exposed.
  FOREACH selected_signature IN ARRAY ARRAY[
    'public.digest(text,text)',
    'public.digest(bytea,text)',
    'app.current_organization_id()',
    'app.current_actor_id()',
    'app.current_actor_has_permission(text)',
    'app.mcp_user_is_active(uuid)',
    'app.segment_value_is_valid(uuid,uuid,text,date)',
    'app.currency_minor_units(text)',
    'app.current_demo_session_is_valid()',
    'app.assert_current_demo_session_lease()',
    'app.allocate_journal_number(uuid,uuid,text)',
    'app.compute_journal_content_hash(uuid)',
    'app.install_initial_organization_key(text,text)',
    'app.accounting_set_currency_enabled(text,boolean)',
    'app.accounting_add_currency_rate(text,text,numeric,timestamp with time zone,text)',
    'app.accounting_set_fx_provider_policy(integer,text,integer,boolean)',
    'app.accounting_add_tax_registration(uuid,uuid,text,text,integer,text,text,text,text,text,date,date)',
    'app.accounting_configure_segment(text,text,boolean,boolean,text)',
    'app.accounting_add_segment_value(text,text,text,date,date)',
    'app.accounting_create_account_combination(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    'app.accounting_create_legal_entity(text,text,text,text,text,accounting_profile,integer,manual_posting_mode)',
    'app.accounting_create_fiscal_periods(uuid,integer,text,period_state,text)',
    'app.accounting_create_hierarchy_draft(text,uuid,text,text,uuid)',
    'app.accounting_replace_hierarchy_draft(uuid,integer,jsonb)',
    'app.accounting_publish_hierarchy(uuid,integer,date)',
    'app.auth_consume_rate_limit(text,text,integer,integer)',
    'app.auth_lookup_login(text)',
    'app.auth_lookup_login_v2(text)',
    'app.auth_issue_demo_session(text,text,text,text,text,text)',
    'app.auth_demo_session_lease_valid(uuid)',
    'app.auth_mark_demo_step_up(uuid,text)',
    'app.shared_demo_operations_state()',
    'app.auth_issue_mfa_user_session(uuid,uuid,uuid,uuid,bigint,text,text,text,text)',
    'app.auth_issue_password_user_session(uuid,uuid,uuid,text,text,text,text)',
    'app.auth_resolve_session(text,text)',
    'app.auth_resolve_session_v2(text,text)',
    'app.auth_resolve_session_v3(text,text)',
    'app.auth_platform_administrator_authorization(uuid,uuid)',
    'app.platform_administration_overview(uuid,uuid)',
    'app.auth_revoke_session(text,text)',
    'app.auth_queue_password_reset(text,text,text,uuid,text,text)',
    'app.auth_finish_password_reset(text,text,text)',
    'app.auth_record_login_failure(text)',
    'app.auth_password_reset_challenge(text)',
    'app.auth_prepare_recovery_mfa(text,uuid,text,text)',
    'app.auth_authorize_password_reset_totp(text,uuid,bigint,text)',
    'app.auth_finish_password_reset_with_mfa(text,text,uuid,bigint,text)',
    'app.auth_escalate_password_reset(text,text)',
    'app.auth_approve_recovery(uuid,uuid,uuid,bigint,text)',
    'app.auth_accept_invitation(text,text,uuid,text,text,text)',
    'app.auth_begin_organization_signup(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,accounting_profile,integer,manual_posting_mode,text,text,text,text,uuid,text,text,text)',
    'app.auth_consume_signup_accept_limits(text)',
    'app.auth_accept_organization_signup(text,text,uuid,text,text,text)',
    'app.auth_mfa_setup_challenge(text)',
    'app.auth_finish_mfa_enrollment(text,uuid,bigint,text)',
    'app.auth_skip_mfa_enrollment(text,text)',
    'app.auth_mfa_status_for_session(uuid)',
    'app.auth_begin_session_mfa_enrollment(uuid,uuid,text,text,text)',
    'app.auth_finish_session_mfa_enrollment(uuid,text,uuid,bigint,text,text)',
    'app.auth_password_for_session(uuid)',
    'app.auth_record_session_reauthentication_failure(uuid,text)',
    'app.auth_totp_for_session(uuid)',
    'app.auth_mark_step_up(uuid,uuid,bigint,text)',
    'app.auth_email_delivery_readiness(integer)',
    'app.operations_metrics()',
    'app.auth_consume_mfa_step_up_limits(uuid)',
    'app.auth_consume_password_reset_limits(text)',
    'app.auth_consume_password_reset_escalation_limits(text)',
    'app.auth_consume_recovery_approval_limits(uuid,uuid)',
    'app.auth_consume_mfa_enrollment_limits(text)',
    'app.organization_settings_read()',
    'app.organization_members_read()',
    'app.organization_update_settings(text,integer)',
    'app.organization_invite_member(uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,text)',
    'app.organization_resend_invitation(uuid,integer,uuid,text,uuid,text)',
    'app.organization_cancel_invitation(uuid,integer)',
    'app.organization_assign_member_role(uuid,uuid,integer)',
    'app.organization_set_member_active(uuid,integer,boolean)',
    'app.organization_revoke_member_sessions(uuid)'
  ] LOOP
    IF to_regprocedure(selected_signature) IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO business_finlynq_app', selected_signature);
    END IF;
  END LOOP;
END
$reconcile$;

DO $role_contract$
DECLARE
  selected_role oid;
BEGIN
  SELECT oid INTO selected_role
  FROM pg_roles
  WHERE rolname = 'business_finlynq_app'
    AND rolcanlogin
    AND NOT rolbypassrls
    AND NOT rolsuper
    AND NOT rolcreatedb
    AND NOT rolcreaterole
    AND NOT rolreplication
    AND NOT rolinherit
    AND rolconnlimit = 20;
  IF selected_role IS NULL THEN
    RAISE EXCEPTION 'runtime role attributes are unsafe';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE member = selected_role OR roleid = selected_role
  ) THEN
    RAISE EXCEPTION 'runtime role must have no inbound or outbound role memberships';
  END IF;
  IF NOT has_database_privilege('business_finlynq_app', current_database(), 'CONNECT')
    OR has_database_privilege('business_finlynq_app', current_database(), 'CREATE')
    OR has_database_privilege('business_finlynq_app', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'runtime database privileges are unsafe';
  END IF;
  IF NOT has_schema_privilege('business_finlynq_app', 'public', 'USAGE')
    OR has_schema_privilege('business_finlynq_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'runtime public-schema privileges are unsafe';
  END IF;
  IF to_regnamespace('app') IS NOT NULL AND (
    NOT has_schema_privilege('business_finlynq_app', 'app', 'USAGE')
    OR has_schema_privilege('business_finlynq_app', 'app', 'CREATE')
  ) THEN
    RAISE EXCEPTION 'runtime app-schema privileges are unsafe';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(
      CASE WHEN relation.relacl IS NULL THEN acldefault(
        CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
        relation.relowner
      ) WHEN array_ndims(relation.relacl) = 1 THEN relation.relacl
        ELSE NULL::aclitem[] END
    ) privilege
    WHERE namespace.nspname IN ('public', 'app')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC relation or sequence privileges remain after runtime reconciliation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(
      CASE WHEN array_ndims(attribute.attacl) = 1 THEN attribute.attacl ELSE NULL::aclitem[] END
    ) privilege
    WHERE namespace.nspname IN ('public', 'app')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege.grantee IN (0, selected_role)
  ) THEN
    RAISE EXCEPTION 'PUBLIC or runtime column privileges remain after runtime reconciliation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc selected_function
    JOIN pg_namespace namespace ON namespace.oid = selected_function.pronamespace
    CROSS JOIN LATERAL aclexplode(
      CASE WHEN selected_function.proacl IS NULL THEN acldefault('f'::"char", selected_function.proowner)
        WHEN array_ndims(selected_function.proacl) = 1 THEN selected_function.proacl
        ELSE NULL::aclitem[] END
    ) privilege
    WHERE namespace.nspname IN ('public', 'app')
      AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC function privileges remain after runtime reconciliation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_namespace namespace
    CROSS JOIN LATERAL aclexplode(
      CASE WHEN namespace.nspacl IS NULL THEN acldefault('n'::"char", namespace.nspowner)
        WHEN array_ndims(namespace.nspacl) = 1 THEN namespace.nspacl
        ELSE NULL::aclitem[] END
    ) privilege
    WHERE namespace.nspname IN ('public', 'app')
      AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC schema privileges remain after runtime reconciliation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_default_acl default_acl
    LEFT JOIN pg_namespace namespace ON namespace.oid = default_acl.defaclnamespace
    CROSS JOIN LATERAL aclexplode(
      CASE WHEN array_ndims(default_acl.defaclacl) = 1 THEN default_acl.defaclacl ELSE NULL::aclitem[] END
    ) privilege
    WHERE (
        default_acl.defaclnamespace = 0
        OR namespace.nspname IN ('public', 'app')
      )
      AND default_acl.defaclobjtype IN ('r', 'S', 'f')
      AND privilege.grantee IN (0, selected_role)
  ) THEN
    RAISE EXCEPTION 'PUBLIC or runtime default privileges remain after runtime reconciliation';
  END IF;
END
$role_contract$;
SQL
