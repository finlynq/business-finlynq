CREATE OR REPLACE FUNCTION app.mcp_user_is_active(selected_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users selected_user
    WHERE selected_user.id = selected_user_id
      AND selected_user.active
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.mcp_user_is_active(uuid) FROM PUBLIC;
--> statement-breakpoint

DO $mcp_rls$
DECLARE
  selected_table text;
BEGIN
  FOREACH selected_table IN ARRAY ARRAY[
    'mcp_connections',
    'mcp_oauth_codes',
    'mcp_access_tokens',
    'mcp_refresh_tokens',
    'mcp_approvals',
    'mcp_tool_executions'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', selected_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', selected_table);
    EXECUTE format('DROP POLICY IF EXISTS mcp_user_isolation ON public.%I', selected_table);
    EXECUTE format(
      'CREATE POLICY mcp_user_isolation ON public.%I FOR ALL TO PUBLIC '
      || 'USING (organization_id = app.current_organization_id() AND user_id = app.current_actor_id()) '
      || 'WITH CHECK (organization_id = app.current_organization_id() AND user_id = app.current_actor_id())',
      selected_table
    );
  END LOOP;
END
$mcp_rls$;
--> statement-breakpoint

-- The historical validator blocked both import and MCP posting. MCP now uses
-- the same database permission, frozen-content, maker-checker, period, FX,
-- tax, and subledger controls as the UI. Import remains draft-only.
DO $mcp_posting$
DECLARE
  function_definition text;
  original_guard constant text := 'IN (''MCP'', ''IMPORT'')';
BEGIN
  SELECT pg_get_functiondef('app.validate_journal_posting()'::regprocedure)
  INTO function_definition;
  IF function_definition IS NULL OR position(original_guard IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Expected historical MCP/import posting guard was not found';
  END IF;
  function_definition := replace(function_definition, original_guard, '= ''IMPORT''');
  function_definition := replace(function_definition,
    'MCP and import surfaces may create drafts but cannot post journals',
    'Import surfaces may create drafts but cannot post journals');
  EXECUTE function_definition;
END
$mcp_posting$;
