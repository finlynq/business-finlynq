-- Complete the frozen tenant-table row-security contract before the Drizzle
-- snapshot is rebaselined. The identity and demo control-plane tables below
-- are reached only through reviewed SECURITY DEFINER functions; the web and
-- authentication-worker roles have no direct table grants. Their policies
-- therefore admit only the table's current owner. Looking the owner up by
-- relation OID keeps the policy correct after an ALTER TABLE ... OWNER TO
-- operation instead of freezing a deployment-specific role name in the DDL.
DO $tenant_rls$
DECLARE
  selected_table text;
  selected_policy text;
BEGIN
  FOREACH selected_table IN ARRAY ARRAY[
    'auth_email_outbox',
    'auth_one_time_tokens',
    'auth_organization_signups',
    'auth_recovery_requests',
    'auth_security_events',
    'auth_sessions',
    'demo_daily_claims',
    'demo_sandbox_slots'
  ] LOOP
    IF to_regclass(format('public.%I', selected_table)) IS NULL THEN
      RAISE EXCEPTION 'Tenant RLS completion is missing required table %', selected_table;
    END IF;

    selected_policy := selected_table || '_owner_only_policy';
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO PUBLIC '
      || 'USING (current_user = pg_catalog.pg_get_userbyid('
      || '(SELECT owner_relation.relowner FROM pg_catalog.pg_class owner_relation '
      || 'WHERE owner_relation.oid = %L::pg_catalog.regclass))) '
      || 'WITH CHECK (current_user = pg_catalog.pg_get_userbyid('
      || '(SELECT owner_relation.relowner FROM pg_catalog.pg_class owner_relation '
      || 'WHERE owner_relation.oid = %L::pg_catalog.regclass)))',
      selected_policy,
      selected_table,
      format('public.%I', selected_table),
      format('public.%I', selected_table)
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', selected_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', selected_table);
  END LOOP;

  -- These application-facing tables already have tenant-qualified policies.
  -- Preserve those policy definitions and complete only the FORCE contract.
  FOREACH selected_table IN ARRAY ARRAY[
    'ledger_posting_policies',
    'organization_invitations'
  ] LOOP
    IF to_regclass(format('public.%I', selected_table)) IS NULL THEN
      RAISE EXCEPTION 'Tenant RLS completion is missing required table %', selected_table;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', selected_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', selected_table);
  END LOOP;
END
$tenant_rls$;
--> statement-breakpoint

-- Keep this assertion set-based so every future organization-qualified table
-- must opt into both RLS switches and the reviewed one-policy contract in the
-- migration that creates it. The organization root and the owner-only control
-- plane tables are included even though they naturally have no organization_id
-- column of their own.
DO $tenant_rls_contract$
DECLARE
  selected_relation record;
  expected_expression text;
  expected_policy_name text;
  owner_only boolean;
  policy_count integer;
  actual_policy record;
  normalized_expected_expression text;
  normalized_using_expression text;
  normalized_with_check_expression text;
BEGIN
  FOR selected_relation IN
    SELECT relation.oid, relation.relname, relation.relrowsecurity,
           relation.relforcerowsecurity
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace schema ON schema.oid = relation.relnamespace
    WHERE schema.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND (
        relation.relname = 'organizations'
        OR relation.relname = ANY (ARRAY[
          'auth_email_outbox',
          'auth_one_time_tokens',
          'auth_organization_signups',
          'auth_recovery_requests',
          'auth_security_events',
          'auth_sessions',
          'demo_daily_claims',
          'demo_sandbox_slots'
        ])
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute column_definition
          WHERE column_definition.attrelid = relation.oid
            AND column_definition.attname = 'organization_id'
            AND column_definition.attnum > 0
            AND NOT column_definition.attisdropped
        )
      )
    ORDER BY relation.relname
  LOOP
    IF NOT selected_relation.relrowsecurity OR NOT selected_relation.relforcerowsecurity THEN
      RAISE EXCEPTION 'Tenant table public.% must enable and force row-level security (rls=%, force=%)',
        selected_relation.relname,
        selected_relation.relrowsecurity,
        selected_relation.relforcerowsecurity;
    END IF;

    owner_only := selected_relation.relname = ANY (ARRAY[
      'auth_email_outbox',
      'auth_one_time_tokens',
      'auth_organization_signups',
      'auth_recovery_requests',
      'auth_security_events',
      'auth_sessions',
      'demo_daily_claims',
      'demo_sandbox_slots'
    ]);
    IF selected_relation.relname = 'organizations' THEN
      expected_policy_name := 'organizations_tenant_isolation';
      expected_expression := 'id = app.current_organization_id()';
    ELSIF owner_only THEN
      expected_policy_name := selected_relation.relname || '_owner_only_policy';
      expected_expression := format(
        'current_user = pg_get_userbyid((select owner_relation.relowner from pg_class owner_relation where owner_relation.oid = %L::regclass))',
        format('public.%I', selected_relation.relname)
      );
    ELSE
      -- These two tables predate this completion migration and intentionally
      -- retain their reviewed policy identities. Keep the assertion aligned
      -- with the immutable historical DDL rather than renaming a live policy.
      expected_policy_name := CASE selected_relation.relname
        WHEN 'ledger_posting_policies' THEN 'tenant_isolation'
        WHEN 'organization_invitations' THEN 'organization_invitations_tenant_policy'
        ELSE 'tenant_isolation'
      END;
      expected_expression := 'organization_id = app.current_organization_id()';
    END IF;

    SELECT count(*)
      INTO policy_count
    FROM pg_catalog.pg_policy policy
    WHERE policy.polrelid = selected_relation.oid;
    IF policy_count <> 1 THEN
      RAISE EXCEPTION 'Tenant table public.% must define exactly one reviewed RLS policy; found %',
        selected_relation.relname,
        policy_count;
    END IF;

    SELECT policy.polname, policy.polcmd, policy.polpermissive, policy.polroles,
           pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
           pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) AS with_check_expression
      INTO actual_policy
    FROM pg_catalog.pg_policy policy
    WHERE policy.polrelid = selected_relation.oid;
    normalized_expected_expression := regexp_replace(
      regexp_replace(
        lower(replace(replace(expected_expression, 'pg_catalog.', ''), '"', '')),
        '[[:space:]()]', '', 'g'
      ),
      '''([a-z_][a-z0-9_$]*)''::regclass::oid', '''public.\1''::regclass', 'g'
    );
    normalized_using_expression := regexp_replace(
      regexp_replace(
        lower(replace(replace(actual_policy.using_expression, 'pg_catalog.', ''), '"', '')),
        '[[:space:]()]', '', 'g'
      ),
      '''([a-z_][a-z0-9_$]*)''::regclass::oid', '''public.\1''::regclass', 'g'
    );
    normalized_with_check_expression := regexp_replace(
      regexp_replace(
        lower(replace(replace(actual_policy.with_check_expression, 'pg_catalog.', ''), '"', '')),
        '[[:space:]()]', '', 'g'
      ),
      '''([a-z_][a-z0-9_$]*)''::regclass::oid', '''public.\1''::regclass', 'g'
    );
    IF actual_policy.polname <> expected_policy_name
      OR actual_policy.polcmd <> '*'
      OR NOT actual_policy.polpermissive
      OR actual_policy.polroles <> ARRAY[0::oid]
      OR normalized_using_expression <> normalized_expected_expression
      OR normalized_with_check_expression <> normalized_expected_expression
    THEN
      RAISE EXCEPTION 'Tenant table public.% has an unreviewed RLS policy contract (expected policy %, FOR ALL TO PUBLIC, permissive, and reviewed USING/WITH CHECK predicates)',
        selected_relation.relname,
        expected_policy_name;
    END IF;
  END LOOP;
END
$tenant_rls_contract$;
