CREATE TABLE "organization_fx_provider_policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"provider_mode" text NOT NULL,
	"max_lookback_days" integer NOT NULL,
	"licensed_and_authorized_use_acknowledged" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_fx_provider_policy_versions_version_check" CHECK ("organization_fx_provider_policy_versions"."version" > 0),
	CONSTRAINT "organization_fx_provider_policy_versions_provider_check" CHECK ("organization_fx_provider_policy_versions"."provider_mode" IN ('STORED_ONLY', 'YAHOO_FINANCE_EXPERIMENTAL')),
	CONSTRAINT "organization_fx_provider_policy_versions_lookback_check" CHECK ("organization_fx_provider_policy_versions"."max_lookback_days" BETWEEN 1 AND 7),
	CONSTRAINT "organization_fx_provider_policy_versions_acknowledgement_check" CHECK (("organization_fx_provider_policy_versions"."provider_mode" = 'STORED_ONLY' AND NOT "organization_fx_provider_policy_versions"."licensed_and_authorized_use_acknowledged")
        OR ("organization_fx_provider_policy_versions"."provider_mode" = 'YAHOO_FINANCE_EXPERIMENTAL' AND "organization_fx_provider_policy_versions"."licensed_and_authorized_use_acknowledged")),
	CONSTRAINT "organization_fx_provider_policy_versions_reason_check" CHECK (char_length(btrim("organization_fx_provider_policy_versions"."reason")) BETWEEN 8 AND 500)
);
--> statement-breakpoint
ALTER TABLE "organization_fx_provider_policy_versions" ADD CONSTRAINT "organization_fx_provider_policy_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_fx_provider_policy_versions_org_version_unique" ON "organization_fx_provider_policy_versions" USING btree ("organization_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_fx_provider_policy_versions_org_id_unique" ON "organization_fx_provider_policy_versions" USING btree ("organization_id","id");
--> statement-breakpoint

ALTER TABLE organization_fx_provider_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_fx_provider_policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_fx_provider_policy_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

CREATE TRIGGER organization_fx_provider_policy_versions_append_only
  BEFORE UPDATE OR DELETE ON organization_fx_provider_policy_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_set_fx_provider_policy(
  selected_expected_version integer,
  requested_provider_mode text,
  requested_max_lookback_days integer,
  requested_licensed_acknowledgement boolean
)
RETURNS TABLE(
  policy_id uuid,
  policy_version integer,
  selected_provider_mode text,
  selected_max_lookback_days integer,
  selected_licensed_acknowledgement boolean,
  selected_configured_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  admin_context record;
  selected_organization_id uuid;
  selected_actor_id uuid;
  normalized_provider_mode text := upper(btrim(requested_provider_mode));
  selected_reason text := btrim(coalesce(current_setting('app.reason', true), ''));
  current_policy organization_fx_provider_policy_versions%ROWTYPE;
  inserted_policy organization_fx_provider_policy_versions%ROWTYPE;
  current_version integer;
BEGIN
  SELECT * INTO admin_context
  FROM app.organization_admin_authorize('organization.settings.manage', true);
  selected_organization_id := admin_context.organization_id;
  selected_actor_id := admin_context.actor_id;

  IF selected_expected_version IS NULL OR selected_expected_version < 0
    OR requested_provider_mode IS NULL
    OR normalized_provider_mode NOT IN ('STORED_ONLY', 'YAHOO_FINANCE_EXPERIMENTAL')
    OR requested_max_lookback_days IS NULL
    OR requested_max_lookback_days NOT BETWEEN 1 AND 7
    OR requested_licensed_acknowledgement IS NULL
    OR (
      normalized_provider_mode = 'YAHOO_FINANCE_EXPERIMENTAL'
      AND NOT requested_licensed_acknowledgement
    )
    OR (
      normalized_provider_mode = 'STORED_ONLY'
      AND requested_licensed_acknowledgement
    )
    OR char_length(selected_reason) NOT BETWEEN 8 AND 500 THEN
    RAISE EXCEPTION 'Invalid FX provider policy configuration'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|fx-provider-policy',
    0
  ));
  SELECT policy.* INTO current_policy
  FROM organization_fx_provider_policy_versions policy
  WHERE policy.organization_id = selected_organization_id
  ORDER BY policy.version DESC, policy.id DESC
  LIMIT 1;
  current_version := coalesce(current_policy.version, 0);

  -- An identical retry is safe even if the caller did not receive the first
  -- response and still carries the prior expected version.
  IF current_policy.id IS NOT NULL
    AND current_policy.provider_mode = normalized_provider_mode
    AND current_policy.max_lookback_days = requested_max_lookback_days
    AND current_policy.licensed_and_authorized_use_acknowledged
      = requested_licensed_acknowledgement THEN
    RETURN QUERY SELECT
      current_policy.id,
      current_policy.version,
      current_policy.provider_mode,
      current_policy.max_lookback_days,
      current_policy.licensed_and_authorized_use_acknowledged,
      current_policy.created_at;
    RETURN;
  END IF;

  IF selected_expected_version <> current_version THEN
    RAISE EXCEPTION 'FX provider policy changed after it was loaded'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO organization_fx_provider_policy_versions(
    organization_id,
    version,
    provider_mode,
    max_lookback_days,
    licensed_and_authorized_use_acknowledged,
    reason,
    created_by
  ) VALUES (
    selected_organization_id,
    current_version + 1,
    normalized_provider_mode,
    requested_max_lookback_days,
    requested_licensed_acknowledgement,
    selected_reason,
    selected_actor_id
  )
  RETURNING * INTO inserted_policy;

  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    'accounting.fx_provider_policy.changed',
    'organization_fx_provider_policy',
    inserted_policy.id::text,
    jsonb_build_object(
      'fromProviderMode', coalesce(current_policy.provider_mode, 'STORED_ONLY'),
      'toProviderMode', inserted_policy.provider_mode,
      'fromVersion', current_version,
      'toVersion', inserted_policy.version,
      'maxLookbackDays', inserted_policy.max_lookback_days,
      'licensedAndAuthorizedUseAcknowledged',
        inserted_policy.licensed_and_authorized_use_acknowledged
    ),
    NULL
  );

  RETURN QUERY SELECT
    inserted_policy.id,
    inserted_policy.version,
    inserted_policy.provider_mode,
    inserted_policy.max_lookback_days,
    inserted_policy.licensed_and_authorized_use_acknowledged,
    inserted_policy.created_at;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_set_fx_provider_policy(integer, text, integer, boolean)
  FROM PUBLIC;
REVOKE ALL ON TABLE organization_fx_provider_policy_versions FROM PUBLIC;
--> statement-breakpoint

DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON TABLE organization_fx_provider_policy_versions
      FROM business_finlynq_app;
    REVOKE ALL ON FUNCTION app.accounting_set_fx_provider_policy(integer, text, integer, boolean)
      FROM business_finlynq_app;
    GRANT SELECT ON TABLE organization_fx_provider_policy_versions
      TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.accounting_set_fx_provider_policy(integer, text, integer, boolean)
      TO business_finlynq_app;
  END IF;
END
$runtime_grants$;
--> statement-breakpoint

INSERT INTO demo_sandbox_reset_tables(table_name, purge_order)
SELECT 'organization_fx_provider_policy_versions', max(purge_order) + 1
FROM demo_sandbox_reset_tables
ON CONFLICT (table_name) DO UPDATE SET purge_order = EXCLUDED.purge_order;
