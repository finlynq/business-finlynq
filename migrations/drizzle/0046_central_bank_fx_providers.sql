ALTER TABLE "organization_fx_provider_policy_versions" DROP CONSTRAINT "organization_fx_provider_policy_versions_provider_check";--> statement-breakpoint
ALTER TABLE "organization_fx_provider_policy_versions" DROP CONSTRAINT "organization_fx_provider_policy_versions_acknowledgement_check";--> statement-breakpoint
ALTER TABLE "organization_fx_provider_policy_versions" ADD CONSTRAINT "organization_fx_provider_policy_versions_provider_check" CHECK ("organization_fx_provider_policy_versions"."provider_mode" IN ('STORED_ONLY', 'BANK_OF_CANADA', 'EUROPEAN_CENTRAL_BANK', 'YAHOO_FINANCE_EXPERIMENTAL'));--> statement-breakpoint
ALTER TABLE "organization_fx_provider_policy_versions" ADD CONSTRAINT "organization_fx_provider_policy_versions_acknowledgement_check" CHECK (("organization_fx_provider_policy_versions"."provider_mode" = 'YAHOO_FINANCE_EXPERIMENTAL' AND "organization_fx_provider_policy_versions"."licensed_and_authorized_use_acknowledged")
        OR ("organization_fx_provider_policy_versions"."provider_mode" <> 'YAHOO_FINANCE_EXPERIMENTAL' AND NOT "organization_fx_provider_policy_versions"."licensed_and_authorized_use_acknowledged"));
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
    OR normalized_provider_mode NOT IN ('STORED_ONLY', 'BANK_OF_CANADA', 'EUROPEAN_CENTRAL_BANK', 'YAHOO_FINANCE_EXPERIMENTAL')
    OR requested_max_lookback_days IS NULL
    OR requested_max_lookback_days NOT BETWEEN 1 AND 7
    OR requested_licensed_acknowledgement IS NULL
    OR (
      normalized_provider_mode = 'YAHOO_FINANCE_EXPERIMENTAL'
      AND NOT requested_licensed_acknowledgement
    )
    OR (
      normalized_provider_mode <> 'YAHOO_FINANCE_EXPERIMENTAL'
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
