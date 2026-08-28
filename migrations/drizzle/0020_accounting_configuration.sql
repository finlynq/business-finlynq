-- Organization accounting configuration: enabled currencies, append-only FX
-- rates, protected segment administration, and additional legal entities.

-- Equality operator classes for UUID/text let PostgreSQL enforce non-overlap
-- for each tenant/entity/regime with one concurrency-safe exclusion index.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

CREATE TABLE organization_currencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  currency_code text NOT NULL REFERENCES currency_definitions(code) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT organization_currencies_org_code_unique UNIQUE (organization_id, currency_code),
  CONSTRAINT organization_currencies_org_id_unique UNIQUE (organization_id, id)
);
--> statement-breakpoint
CREATE TABLE currency_exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  source_currency text NOT NULL REFERENCES currency_definitions(code) ON DELETE RESTRICT,
  target_currency text NOT NULL REFERENCES currency_definitions(code) ON DELETE RESTRICT,
  rate numeric(38,18) NOT NULL CHECK (rate > 0),
  effective_at timestamp with time zone NOT NULL,
  source text NOT NULL CHECK (length(source) BETWEEN 2 AND 100),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT currency_exchange_rates_distinct_pair CHECK (source_currency <> target_currency),
  CONSTRAINT currency_exchange_rates_org_identity_unique UNIQUE (
    organization_id, source_currency, target_currency, effective_at, source
  ),
  CONSTRAINT currency_exchange_rates_org_id_unique UNIQUE (organization_id, id)
);
--> statement-breakpoint

CREATE TRIGGER currency_exchange_rates_append_only
  BEFORE UPDATE OR DELETE ON currency_exchange_rates
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();
--> statement-breakpoint

-- Legacy registrations predate explicit sourcing evidence. Keep those fields
-- nullable so the application can hold them for review instead of inventing a
-- city or location code during migration. Every governed mutation below writes
-- the complete country, region, and evidence set.
ALTER TABLE entity_tax_registrations
  ADD COLUMN destination_country text,
  ADD COLUMN destination_region text,
  ADD COLUMN destination_city text,
  ADD COLUMN location_code text,
  ADD COLUMN configuration_evidence text,
  ADD CONSTRAINT entity_tax_registrations_destination_country_check CHECK (
    destination_country IS NULL OR destination_country ~ '^[A-Z]{2}$'
  ),
  ADD CONSTRAINT entity_tax_registrations_destination_region_check CHECK (
    destination_region IS NULL OR destination_region ~ '^[A-Z0-9-]{2,10}$'
  ),
  ADD CONSTRAINT entity_tax_registrations_destination_city_check CHECK (
    destination_city IS NULL OR length(destination_city) BETWEEN 1 AND 100
  ),
  ADD CONSTRAINT entity_tax_registrations_location_code_check CHECK (
    location_code IS NULL OR length(location_code) BETWEEN 1 AND 40
  ),
  ADD CONSTRAINT entity_tax_registrations_configuration_evidence_check CHECK (
    configuration_evidence IS NULL OR length(configuration_evidence) BETWEEN 8 AND 1000
  ),
  ADD CONSTRAINT entity_tax_registrations_valid_window_check CHECK (
    valid_to IS NULL OR valid_to >= valid_from
  ),
  ADD CONSTRAINT entity_tax_registrations_regime_window_exclusion
    EXCLUDE USING gist (
      organization_id WITH =,
      legal_entity_id WITH =,
      regime_key WITH =,
      daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') WITH &&
  );
--> statement-breakpoint

-- The generic fallback is an approved, executable review policy rather than
-- a statutory rate pack. It lets unsupported jurisdictions preserve a frozen
-- tax decision while preventing automatic tax posting without evidence.
INSERT INTO tax_pack_versions(
  id, pack_key, version, jurisdiction, effective_from, effective_to,
  source_uri, source_digest, approved_by, approved_at
) VALUES (
  'c187ece1-a853-49b5-98a0-69f68b45463a'::uuid,
  'generic.unsupported', '2026.08.27', 'GLOBAL-UNSUPPORTED',
  '2000-01-01', NULL,
  'https://github.com/finlynq/business-finlynq/blob/main/src/modules/tax/packs/generic-unsupported.ts',
  '80fc1d1967819ea235ab215df7a3ae2a22e15fbd8ce3287a6cc26e2ae11ff76f',
  '00000000-0000-0000-0000-000000000000'::uuid,
  '2026-08-27T00:00:00Z'::timestamptz
)
ON CONFLICT (pack_key, version) DO NOTHING;
--> statement-breakpoint

INSERT INTO organization_currencies(
  organization_id, currency_code, enabled, created_by
)
SELECT DISTINCT ledger.organization_id, ledger.functional_currency, true,
  coalesce((
    SELECT membership.user_id
    FROM organization_memberships membership
    WHERE membership.organization_id = ledger.organization_id
      AND membership.active
    ORDER BY membership.created_at, membership.id
    LIMIT 1
  ), '00000000-0000-0000-0000-000000000000'::uuid)
FROM ledgers ledger
ON CONFLICT (organization_id, currency_code) DO UPDATE SET enabled = true, updated_at = now();
--> statement-breakpoint

ALTER TABLE organization_currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_currencies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_currencies
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
ALTER TABLE currency_exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE currency_exchange_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON currency_exchange_rates
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.ensure_ledger_functional_currency_enabled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_actor_id uuid;
  selected_organization_id uuid;
  normalized_code text;
  previous_organization_setting text := current_setting('app.organization_id', true);
BEGIN
  selected_organization_id := NEW.organization_id;
  normalized_code := upper(trim(NEW.functional_currency));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|organization-currency|' || normalized_code,
    0
  ));

  selected_actor_id := app.current_actor_id();
  IF selected_actor_id IS NULL THEN
    SELECT membership.user_id INTO selected_actor_id
    FROM organization_memberships membership
    WHERE membership.organization_id = selected_organization_id
    ORDER BY membership.active DESC, membership.created_at, membership.id
    LIMIT 1;
  END IF;
  selected_actor_id := coalesce(
    selected_actor_id,
    '00000000-0000-0000-0000-000000000000'::uuid
  );

  -- Ledger creation also occurs inside unauthenticated signup-completion
  -- functions. Bind this trigger's forced-RLS write to the ledger's own
  -- tenant, then restore the caller's transaction-local context.
  PERFORM set_config('app.organization_id', selected_organization_id::text, true);
  INSERT INTO organization_currencies(
    organization_id, currency_code, enabled, created_by
  ) VALUES (
    selected_organization_id, normalized_code, true, selected_actor_id
  )
  ON CONFLICT (organization_id, currency_code) DO UPDATE SET
    enabled = true,
    updated_at = now();
  PERFORM set_config('app.organization_id', coalesce(previous_organization_setting, ''), true);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.ensure_ledger_functional_currency_enabled() FROM PUBLIC;
CREATE TRIGGER ledgers_enable_functional_currency
  AFTER INSERT OR UPDATE OF functional_currency, active ON ledgers
  FOR EACH ROW WHEN (NEW.active)
  EXECUTE FUNCTION app.ensure_ledger_functional_currency_enabled();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_set_currency_enabled(
  selected_currency_code text,
  selected_enabled boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  authorization record;
  selected_organization_id uuid;
  selected_actor_id uuid;
  normalized_code text := upper(trim(selected_currency_code));
BEGIN
  SELECT * INTO authorization
  FROM app.organization_admin_authorize('organization.settings.manage', true);
  selected_organization_id := authorization.organization_id;
  selected_actor_id := authorization.actor_id;
  -- This lock is shared with the ledger trigger. A concurrent ledger create
  -- therefore either observes the disable first and re-enables its currency,
  -- or commits first and makes the disable fail the active-ledger check.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|organization-currency|' || normalized_code,
    0
  ));
  IF NOT EXISTS (
    SELECT 1 FROM currency_definitions definition
    WHERE definition.code = normalized_code AND definition.active
  ) THEN
    RAISE EXCEPTION 'Unsupported currency code' USING ERRCODE = '22023';
  END IF;
  IF NOT selected_enabled AND EXISTS (
    SELECT 1 FROM ledgers ledger
    WHERE ledger.organization_id = selected_organization_id
      AND ledger.active AND ledger.functional_currency = normalized_code
  ) THEN
    RAISE EXCEPTION 'A functional currency cannot be disabled' USING ERRCODE = '55000';
  END IF;

  INSERT INTO organization_currencies(
    organization_id, currency_code, enabled, created_by
  ) VALUES (
    selected_organization_id, normalized_code, selected_enabled, selected_actor_id
  )
  ON CONFLICT (organization_id, currency_code) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    updated_at = now();

  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    'accounting.currency.configuration_changed',
    'organization_currency',
    normalized_code,
    jsonb_build_object('currencyCode', normalized_code, 'enabled', selected_enabled),
    NULL
  );
  RETURN selected_enabled;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_set_currency_enabled(text, boolean) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_add_currency_rate(
  selected_source_currency text,
  selected_target_currency text,
  selected_rate numeric,
  selected_effective_at timestamp with time zone,
  selected_source text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  authorization record;
  selected_organization_id uuid;
  selected_actor_id uuid;
  normalized_source text := upper(trim(selected_source_currency));
  normalized_target text := upper(trim(selected_target_currency));
  rate_id uuid;
BEGIN
  SELECT * INTO authorization
  FROM app.organization_admin_authorize('organization.settings.manage', true);
  selected_organization_id := authorization.organization_id;
  selected_actor_id := authorization.actor_id;
  IF selected_rate IS NULL OR selected_rate <= 0 OR selected_effective_at IS NULL
    OR normalized_source = normalized_target
    OR length(trim(selected_source)) NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'Invalid exchange-rate configuration' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[normalized_source, normalized_target]) code
    WHERE NOT EXISTS (
      SELECT 1 FROM organization_currencies currency
      WHERE currency.organization_id = selected_organization_id
        AND currency.currency_code = code AND currency.enabled
    )
  ) THEN
    RAISE EXCEPTION 'Both exchange-rate currencies must be enabled' USING ERRCODE = '22023';
  END IF;

  INSERT INTO currency_exchange_rates(
    organization_id, source_currency, target_currency, rate,
    effective_at, source, created_by
  ) VALUES (
    selected_organization_id, normalized_source, normalized_target,
    selected_rate, selected_effective_at, trim(selected_source), selected_actor_id
  ) RETURNING id INTO rate_id;

  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    'accounting.currency_rate.recorded',
    'currency_exchange_rate',
    rate_id::text,
    jsonb_build_object(
      'sourceCurrency', normalized_source,
      'targetCurrency', normalized_target,
      'rate', selected_rate::text,
      'effectiveAt', selected_effective_at,
      'source', trim(selected_source)
    ),
    NULL
  );
  RETURN rate_id;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_add_currency_rate(text, text, numeric, timestamp with time zone, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_add_tax_registration(
  selected_registration_id uuid,
  selected_legal_entity_id uuid,
  selected_regime_key text,
  selected_registration_ciphertext text,
  selected_key_version integer,
  selected_destination_country text,
  selected_destination_region text,
  selected_destination_city text,
  selected_location_code text,
  selected_configuration_evidence text,
  selected_valid_from date,
  selected_valid_to date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  authorization record;
  selected_organization_id uuid;
  normalized_regime text := lower(trim(selected_regime_key));
  normalized_country text := upper(trim(selected_destination_country));
  normalized_region text := upper(trim(selected_destination_region));
  normalized_city text := nullif(trim(selected_destination_city), '');
  normalized_location text := nullif(upper(trim(selected_location_code)), '');
  seattle_named boolean;
  seattle_location boolean;
BEGIN
  SELECT * INTO authorization
  FROM app.organization_admin_authorize('organization.settings.manage', true);
  selected_organization_id := authorization.organization_id;

  normalized_city := CASE
    WHEN normalized_city IS NULL THEN NULL
    ELSE regexp_replace(normalized_city, '[[:space:]]+', ' ', 'g')
  END;
  seattle_named := upper(coalesce(normalized_city, '')) = 'SEATTLE';
  seattle_location := coalesce(normalized_location, '') = '1726';

  IF selected_registration_id IS NULL OR selected_legal_entity_id IS NULL
    OR selected_regime_key IS NULL OR selected_registration_ciphertext IS NULL
    OR selected_destination_country IS NULL OR selected_destination_region IS NULL
    OR selected_configuration_evidence IS NULL
    OR normalized_regime !~ '^[a-z0-9][a-z0-9._-]{1,99}$'
    OR length(selected_registration_ciphertext) NOT BETWEEN 40 AND 20000
    OR selected_key_version IS NULL OR selected_key_version < 1
    OR normalized_country !~ '^[A-Z]{2}$'
    OR normalized_region !~ '^[A-Z0-9-]{2,10}$'
    OR (normalized_city IS NOT NULL AND length(normalized_city) NOT BETWEEN 1 AND 100)
    OR (normalized_location IS NOT NULL AND length(normalized_location) NOT BETWEEN 1 AND 40)
    OR length(trim(selected_configuration_evidence)) NOT BETWEEN 8 AND 1000
    OR selected_valid_from IS NULL
    OR (selected_valid_to IS NOT NULL AND selected_valid_to < selected_valid_from) THEN
    RAISE EXCEPTION 'Invalid tax-registration configuration' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM legal_entities entity
    WHERE entity.organization_id = selected_organization_id
      AND entity.id = selected_legal_entity_id AND entity.active
  ) THEN
    RAISE EXCEPTION 'The legal entity is not active in this organization' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tax_pack_versions pack WHERE pack.pack_key = normalized_regime
  ) THEN
    RAISE EXCEPTION 'The selected tax pack is not installed' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_key_versions key_version
    WHERE key_version.organization_id = selected_organization_id
      AND key_version.version = selected_key_version AND key_version.active
  ) THEN
    RAISE EXCEPTION 'The registration reference was not encrypted with the active organization key'
      USING ERRCODE = '55000';
  END IF;

  -- Seattle automation is available only when both facts are supplied
  -- explicitly. A different (or absent) city/location pair remains valid
  -- configuration and is deliberately returned as manual review by the pack.
  IF normalized_regime = 'us.wa.sales-use' AND seattle_named <> seattle_location THEN
    RAISE EXCEPTION 'Seattle automation requires both city Seattle and DOR location code 1726; use a different explicit pair for manual review'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|tax-registration|' ||
      selected_legal_entity_id::text || '|' || normalized_regime,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM entity_tax_registrations registration
    WHERE registration.organization_id = selected_organization_id
      AND registration.legal_entity_id = selected_legal_entity_id
      AND registration.regime_key = normalized_regime
      AND daterange(
        registration.valid_from,
        coalesce(registration.valid_to, 'infinity'::date),
        '[]'
      ) && daterange(
        selected_valid_from,
        coalesce(selected_valid_to, 'infinity'::date),
        '[]'
      )
  ) THEN
    RAISE EXCEPTION 'A tax configuration overlaps this validity window for the legal entity and regime'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO entity_tax_registrations(
    id, organization_id, legal_entity_id, regime_key,
    destination_country, destination_region, destination_city, location_code,
    configuration_evidence, registration_ciphertext, key_version,
    valid_from, valid_to
  ) VALUES (
    selected_registration_id, selected_organization_id, selected_legal_entity_id,
    normalized_regime, normalized_country, normalized_region, normalized_city,
    normalized_location, trim(selected_configuration_evidence),
    selected_registration_ciphertext, selected_key_version::text,
    selected_valid_from, selected_valid_to
  );

  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    'accounting.tax_registration.configured',
    'entity_tax_registration',
    selected_registration_id::text,
    jsonb_build_object(
      'legalEntityId', selected_legal_entity_id,
      'regimeKey', normalized_regime,
      'destinationCountry', normalized_country,
      'destinationRegion', normalized_region,
      'destinationCity', normalized_city,
      'locationCode', normalized_location,
      'validFrom', selected_valid_from,
      'validTo', selected_valid_to,
      'seattleAutomationReady', normalized_regime = 'us.wa.sales-use'
        AND normalized_country = 'US' AND normalized_region = 'WA'
        AND seattle_named AND seattle_location,
      'configurationEvidencePresent', true
    ),
    NULL
  );
  RETURN selected_registration_id;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_add_tax_registration(
  uuid, uuid, text, text, integer, text, text, text, text, text, date, date
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_configure_segment(
  selected_key text,
  selected_display_name text,
  selected_visible boolean,
  selected_required boolean,
  selected_action text
)
RETURNS segment_definitions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  authorization record;
  selected_organization_id uuid;
  normalized_key text := lower(trim(selected_key));
  selected_definition segment_definitions%ROWTYPE;
  next_state custom_slot_state;
BEGIN
  SELECT * INTO authorization
  FROM app.organization_admin_authorize('ledger.segments.manage', true);
  selected_organization_id := authorization.organization_id;
  IF normalized_key NOT IN (
    'subaccount', 'department',
    'custom1', 'custom2', 'custom3', 'custom4',
    'custom5', 'custom6', 'custom7', 'custom8'
  ) OR length(trim(selected_display_name)) NOT BETWEEN 2 AND 80
    OR selected_action NOT IN ('CONFIGURE', 'ACTIVATE', 'DEACTIVATE') THEN
    RAISE EXCEPTION 'Invalid segment configuration' USING ERRCODE = '22023';
  END IF;

  -- Segment lifecycle and combination validation share one tenant lock. The
  -- settings surface is low-volume, and organization scope avoids write skew
  -- across required definitions and combinations that span many dimensions.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|account-segments',
    0
  ));

  SELECT definition.* INTO selected_definition
  FROM segment_definitions definition
  WHERE definition.organization_id = selected_organization_id
    AND lower(definition.key) = normalized_key
  FOR UPDATE;
  IF selected_definition.id IS NULL THEN
    RAISE EXCEPTION 'Segment definition is missing' USING ERRCODE = '22023';
  END IF;

  next_state := selected_definition.state;
  IF selected_action = 'CONFIGURE' AND selected_definition.state = 'EMPTY' THEN
    next_state := 'CONFIGURED_UNBOUND';
  ELSIF selected_action = 'ACTIVATE' THEN
    IF selected_definition.state NOT IN ('CONFIGURED_UNBOUND', 'INACTIVE_LOCKED') THEN
      RAISE EXCEPTION 'Only a configured or inactive segment can be activated' USING ERRCODE = '55000';
    END IF;
    next_state := 'ACTIVE_LOCKED';
  ELSIF selected_action = 'DEACTIVATE' THEN
    IF selected_definition.state <> 'ACTIVE_LOCKED' THEN
      RAISE EXCEPTION 'Only an active segment can be deactivated' USING ERRCODE = '55000';
    END IF;
    next_state := 'INACTIVE_LOCKED';
  END IF;

  IF selected_required AND next_state <> 'ACTIVE_LOCKED' THEN
    RAISE EXCEPTION 'Only an active segment can be required' USING ERRCODE = '22023';
  END IF;
  IF selected_required AND EXISTS (
    SELECT 1 FROM account_combinations combination
    WHERE combination.organization_id = selected_organization_id
      AND combination.active
      AND CASE normalized_key
        WHEN 'subaccount' THEN combination.subaccount_id
        WHEN 'department' THEN combination.department_id
        WHEN 'custom1' THEN combination.custom_1_id
        WHEN 'custom2' THEN combination.custom_2_id
        WHEN 'custom3' THEN combination.custom_3_id
        WHEN 'custom4' THEN combination.custom_4_id
        WHEN 'custom5' THEN combination.custom_5_id
        WHEN 'custom6' THEN combination.custom_6_id
        WHEN 'custom7' THEN combination.custom_7_id
        WHEN 'custom8' THEN combination.custom_8_id
      END IS NULL
  ) THEN
    RAISE EXCEPTION 'Existing account combinations must be completed before this segment can be required' USING ERRCODE = '55000';
  END IF;

  UPDATE segment_definitions definition SET
    display_name = trim(selected_display_name),
    state = next_state,
    visible = CASE WHEN next_state = 'INACTIVE_LOCKED' THEN false ELSE selected_visible END,
    required = CASE WHEN next_state = 'INACTIVE_LOCKED' THEN false ELSE selected_required END
  WHERE definition.id = selected_definition.id
  RETURNING definition.* INTO selected_definition;

  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    'accounting.segment.configuration_changed',
    'segment_definition',
    selected_definition.id::text,
    jsonb_build_object(
      'key', selected_definition.key,
      'displayName', selected_definition.display_name,
      'state', selected_definition.state,
      'visible', selected_definition.visible,
      'required', selected_definition.required
    ),
    NULL
  );
  RETURN selected_definition;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_configure_segment(text, text, boolean, boolean, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_add_segment_value(
  selected_definition_key text,
  selected_code text,
  selected_display_name text,
  selected_valid_from date,
  selected_valid_to date
)
RETURNS segment_values
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  authorization record;
  selected_organization_id uuid;
  normalized_key text := lower(trim(selected_definition_key));
  normalized_code text := upper(trim(selected_code));
  selected_definition segment_definitions%ROWTYPE;
  selected_value segment_values%ROWTYPE;
BEGIN
  SELECT * INTO authorization
  FROM app.organization_admin_authorize('ledger.segments.manage', true);
  selected_organization_id := authorization.organization_id;

  IF normalized_key NOT IN (
    'subaccount', 'department',
    'custom1', 'custom2', 'custom3', 'custom4',
    'custom5', 'custom6', 'custom7', 'custom8'
  ) OR normalized_code = '0000'
    OR normalized_code !~ '^[A-Z0-9][A-Z0-9_-]{0,15}$'
    OR length(trim(selected_display_name)) NOT BETWEEN 2 AND 100
    OR selected_valid_from IS NULL
    OR (selected_valid_to IS NOT NULL AND selected_valid_to < selected_valid_from) THEN
    RAISE EXCEPTION 'Invalid segment-value configuration' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|account-segments',
    0
  ));

  SELECT definition.* INTO selected_definition
  FROM segment_definitions definition
  WHERE definition.organization_id = selected_organization_id
    AND lower(definition.key) = normalized_key
  FOR SHARE;
  IF selected_definition.id IS NULL OR selected_definition.state <> 'ACTIVE_LOCKED' THEN
    RAISE EXCEPTION 'Values can be added only to an active optional segment'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|segment-value|' ||
      selected_definition.id::text || '|' || normalized_code,
    0
  ));
  SELECT value.* INTO selected_value
  FROM segment_values value
  WHERE value.organization_id = selected_organization_id
    AND value.definition_id = selected_definition.id
    AND upper(value.code) = normalized_code
  FOR SHARE;
  IF selected_value.id IS NOT NULL THEN
    IF selected_value.display_name = trim(selected_display_name)
      AND selected_value.active
      AND selected_value.valid_from = selected_valid_from
      AND selected_value.valid_to IS NOT DISTINCT FROM selected_valid_to THEN
      RETURN selected_value;
    END IF;
    RAISE EXCEPTION 'This segment code already identifies a different value'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO segment_values(
    organization_id, definition_id, code, display_name,
    active, valid_from, valid_to
  ) VALUES (
    selected_organization_id, selected_definition.id, normalized_code,
    trim(selected_display_name), true, selected_valid_from, selected_valid_to
  ) RETURNING * INTO selected_value;

  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    'accounting.segment_value.created',
    'segment_value',
    selected_value.id::text,
    jsonb_build_object(
      'definitionId', selected_definition.id,
      'definitionKey', selected_definition.key,
      'code', selected_value.code,
      'displayName', selected_value.display_name,
      'validFrom', selected_value.valid_from,
      'validTo', selected_value.valid_to
    ),
    NULL
  );
  RETURN selected_value;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_add_segment_value(text, text, text, date, date) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_create_account_combination(
  selected_legal_entity_id uuid,
  selected_ledger_id uuid,
  selected_account_id uuid,
  selected_subaccount_id uuid,
  selected_department_id uuid,
  selected_intercompany_entity_id uuid,
  selected_custom_1_id uuid,
  selected_custom_2_id uuid,
  selected_custom_3_id uuid,
  selected_custom_4_id uuid,
  selected_custom_5_id uuid,
  selected_custom_6_id uuid,
  selected_custom_7_id uuid,
  selected_custom_8_id uuid,
  selected_replaces_combination_id uuid
)
RETURNS account_combinations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  authorization record;
  selected_organization_id uuid;
  selected_combination account_combinations%ROWTYPE;
  replacement account_combinations%ROWTYPE;
  combination_created boolean := false;
  combination_reactivated boolean := false;
BEGIN
  SELECT * INTO authorization
  FROM app.organization_admin_authorize('ledger.segments.manage', true);
  selected_organization_id := authorization.organization_id;

  IF selected_legal_entity_id IS NULL OR selected_ledger_id IS NULL
    OR selected_account_id IS NULL THEN
    RAISE EXCEPTION 'Entity, ledger, and natural account are required'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|account-segments',
    0
  ));
  IF NOT EXISTS (
    SELECT 1
    FROM legal_entities entity
    JOIN ledgers ledger
      ON ledger.organization_id = entity.organization_id
     AND ledger.legal_entity_id = entity.id
    JOIN gl_accounts account
      ON account.organization_id = ledger.organization_id
     AND account.ledger_id = ledger.id
    WHERE entity.organization_id = selected_organization_id
      AND entity.id = selected_legal_entity_id AND entity.active
      AND ledger.id = selected_ledger_id AND ledger.active
      AND account.id = selected_account_id AND account.active AND account.postable
  ) THEN
    RAISE EXCEPTION 'Entity, ledger, and natural account must be active and tenant-consistent'
      USING ERRCODE = '22023';
  END IF;
  IF selected_intercompany_entity_id IS NOT NULL AND (
    selected_intercompany_entity_id = selected_legal_entity_id OR NOT EXISTS (
      SELECT 1 FROM legal_entities intercompany
      WHERE intercompany.organization_id = selected_organization_id
        AND intercompany.id = selected_intercompany_entity_id
        AND intercompany.active
    )
  ) THEN
    RAISE EXCEPTION 'Intercompany must reference a different active legal entity in this organization'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('subaccount', selected_subaccount_id),
      ('department', selected_department_id),
      ('custom1', selected_custom_1_id),
      ('custom2', selected_custom_2_id),
      ('custom3', selected_custom_3_id),
      ('custom4', selected_custom_4_id),
      ('custom5', selected_custom_5_id),
      ('custom6', selected_custom_6_id),
      ('custom7', selected_custom_7_id),
      ('custom8', selected_custom_8_id)
    ) AS selected_value(definition_key, value_id)
    WHERE selected_value.value_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM segment_values value
        JOIN segment_definitions definition
          ON definition.organization_id = value.organization_id
         AND definition.id = value.definition_id
        WHERE value.organization_id = selected_organization_id
          AND value.id = selected_value.value_id
          AND lower(definition.key) = selected_value.definition_key
          AND definition.state = 'ACTIVE_LOCKED'
          AND value.active
      )
  ) THEN
    RAISE EXCEPTION 'Every selected value must belong to its exact active segment definition'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM segment_definitions definition
    LEFT JOIN (VALUES
      ('subaccount', selected_subaccount_id),
      ('department', selected_department_id),
      ('custom1', selected_custom_1_id),
      ('custom2', selected_custom_2_id),
      ('custom3', selected_custom_3_id),
      ('custom4', selected_custom_4_id),
      ('custom5', selected_custom_5_id),
      ('custom6', selected_custom_6_id),
      ('custom7', selected_custom_7_id),
      ('custom8', selected_custom_8_id)
    ) AS selected_value(definition_key, value_id)
      ON selected_value.definition_key = lower(definition.key)
    WHERE definition.organization_id = selected_organization_id
      AND definition.state = 'ACTIVE_LOCKED' AND definition.required
      AND selected_value.value_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Every required segment needs a value in the new account combination'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|account-combination|' ||
      selected_ledger_id::text || '|' || selected_legal_entity_id::text || '|' ||
      selected_account_id::text,
    0
  ));
  SELECT combination.* INTO selected_combination
  FROM account_combinations combination
  WHERE combination.organization_id = selected_organization_id
    AND combination.ledger_id = selected_ledger_id
    AND combination.entity_id = selected_legal_entity_id
    AND combination.account_id = selected_account_id
    AND combination.subaccount_id IS NOT DISTINCT FROM selected_subaccount_id
    AND combination.department_id IS NOT DISTINCT FROM selected_department_id
    AND combination.intercompany_entity_id IS NOT DISTINCT FROM selected_intercompany_entity_id
    AND combination.custom_1_id IS NOT DISTINCT FROM selected_custom_1_id
    AND combination.custom_2_id IS NOT DISTINCT FROM selected_custom_2_id
    AND combination.custom_3_id IS NOT DISTINCT FROM selected_custom_3_id
    AND combination.custom_4_id IS NOT DISTINCT FROM selected_custom_4_id
    AND combination.custom_5_id IS NOT DISTINCT FROM selected_custom_5_id
    AND combination.custom_6_id IS NOT DISTINCT FROM selected_custom_6_id
    AND combination.custom_7_id IS NOT DISTINCT FROM selected_custom_7_id
    AND combination.custom_8_id IS NOT DISTINCT FROM selected_custom_8_id
  FOR UPDATE;

  IF selected_combination.id IS NULL THEN
    INSERT INTO account_combinations(
      organization_id, ledger_id, entity_id, account_id,
      subaccount_id, department_id, intercompany_entity_id,
      custom_1_id, custom_2_id, custom_3_id, custom_4_id,
      custom_5_id, custom_6_id, custom_7_id, custom_8_id,
      active
    ) VALUES (
      selected_organization_id, selected_ledger_id, selected_legal_entity_id,
      selected_account_id, selected_subaccount_id, selected_department_id,
      selected_intercompany_entity_id, selected_custom_1_id, selected_custom_2_id,
      selected_custom_3_id, selected_custom_4_id, selected_custom_5_id,
      selected_custom_6_id, selected_custom_7_id, selected_custom_8_id, true
    ) RETURNING * INTO selected_combination;
    combination_created := true;
  ELSIF NOT selected_combination.active THEN
    IF selected_combination.last_used_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM journal_lines line
      WHERE line.organization_id = selected_organization_id
        AND line.account_combination_id = selected_combination.id
    ) THEN
      RAISE EXCEPTION 'A used inactive account combination cannot be reactivated'
        USING ERRCODE = '55000';
    END IF;
    UPDATE account_combinations combination SET active = true
    WHERE combination.organization_id = selected_organization_id
      AND combination.id = selected_combination.id
    RETURNING combination.* INTO selected_combination;
    combination_reactivated := true;
  END IF;

  IF selected_replaces_combination_id IS NOT NULL
    AND selected_replaces_combination_id <> selected_combination.id THEN
    SELECT combination.* INTO replacement
    FROM account_combinations combination
    WHERE combination.organization_id = selected_organization_id
      AND combination.id = selected_replaces_combination_id
    FOR UPDATE;
    IF replacement.id IS NULL
      OR replacement.ledger_id <> selected_ledger_id
      OR replacement.entity_id <> selected_legal_entity_id
      OR replacement.account_id <> selected_account_id THEN
      RAISE EXCEPTION 'A replacement must identify the same entity, ledger, and natural account'
        USING ERRCODE = '22023';
    END IF;
    IF replacement.last_used_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM journal_lines line
      WHERE line.organization_id = selected_organization_id
        AND line.account_combination_id = replacement.id
    ) THEN
      RAISE EXCEPTION 'A used account combination cannot be replaced or changed'
        USING ERRCODE = '55000';
    END IF;
    IF replacement.active THEN
      UPDATE account_combinations combination SET active = false
      WHERE combination.organization_id = selected_organization_id
        AND combination.id = replacement.id;
      PERFORM app.append_tenant_business_audit(
        selected_organization_id,
        'accounting.account_combination.superseded',
        'account_combination',
        replacement.id::text,
        jsonb_build_object('replacementId', selected_combination.id),
        NULL
      );
    END IF;
  END IF;

  IF combination_created THEN
    PERFORM app.append_tenant_business_audit(
      selected_organization_id,
      'accounting.account_combination.created',
      'account_combination',
      selected_combination.id::text,
      jsonb_build_object(
        'legalEntityId', selected_legal_entity_id,
        'ledgerId', selected_ledger_id,
        'accountId', selected_account_id,
        'subaccountId', selected_subaccount_id,
        'departmentId', selected_department_id,
        'intercompanyEntityId', selected_intercompany_entity_id,
        'custom1Id', selected_custom_1_id,
        'custom2Id', selected_custom_2_id,
        'custom3Id', selected_custom_3_id,
        'custom4Id', selected_custom_4_id,
        'custom5Id', selected_custom_5_id,
        'custom6Id', selected_custom_6_id,
        'custom7Id', selected_custom_7_id,
        'custom8Id', selected_custom_8_id
      ),
      NULL
    );
  ELSIF combination_reactivated THEN
    PERFORM app.append_tenant_business_audit(
      selected_organization_id,
      'accounting.account_combination.reactivated',
      'account_combination',
      selected_combination.id::text,
      jsonb_build_object('active', true),
      NULL
    );
  END IF;
  RETURN selected_combination;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_create_account_combination(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_create_legal_entity(
  selected_code text,
  selected_display_name text,
  selected_country_code text,
  selected_region_code text,
  selected_functional_currency text,
  selected_accounting_profile accounting_profile,
  selected_fiscal_year integer,
  selected_manual_posting_mode manual_posting_mode
)
RETURNS TABLE(legal_entity_id uuid, ledger_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  authorization record;
  selected_organization_id uuid;
  selected_actor_id uuid;
  normalized_code text := upper(trim(selected_code));
  normalized_country text := upper(trim(selected_country_code));
  normalized_region text := upper(trim(selected_region_code));
  normalized_currency text := upper(trim(selected_functional_currency));
  generated_entity_id uuid := gen_random_uuid();
  generated_ledger_id uuid := gen_random_uuid();
  selected_account_id uuid;
  account_record record;
  month_number integer;
  starts_on date;
BEGIN
  SELECT * INTO authorization
  FROM app.organization_admin_authorize('organization.settings.manage', true);
  selected_organization_id := authorization.organization_id;
  selected_actor_id := authorization.actor_id;
  IF normalized_code !~ '^[A-Z0-9][A-Z0-9_-]{0,15}$' OR normalized_code = '0000'
    OR length(trim(selected_display_name)) NOT BETWEEN 2 AND 200
    OR normalized_country !~ '^[A-Z]{2}$'
    OR normalized_region !~ '^[A-Z0-9-]{2,10}$'
    OR selected_fiscal_year NOT BETWEEN 2000 AND 2200
    OR app.currency_minor_units(normalized_currency) IS NULL THEN
    RAISE EXCEPTION 'Invalid legal-entity configuration' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|account-segments',
    0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|organization-currency|' || normalized_currency,
    0
  ));
  IF EXISTS (
    SELECT 1
    FROM segment_definitions definition
    WHERE definition.organization_id = selected_organization_id
      AND definition.state = 'ACTIVE_LOCKED'
      AND definition.required
  ) THEN
    RAISE EXCEPTION 'Create legal entities before requiring an account segment, or make the segment optional while its foundation combinations are created'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO legal_entities(
    id, organization_id, code, display_name, country_code, region_code, active
  ) VALUES (
    generated_entity_id, selected_organization_id, normalized_code,
    trim(selected_display_name), normalized_country, normalized_region, true
  );
  INSERT INTO ledgers(
    id, organization_id, legal_entity_id, code, display_name, kind,
    accounting_profile, functional_currency, active
  ) VALUES (
    generated_ledger_id, selected_organization_id, generated_entity_id,
    normalized_code || '-PRIMARY', trim(selected_display_name) || ' primary ledger',
    'PRIMARY', selected_accounting_profile, normalized_currency, true
  );

  FOR month_number IN 1..12 LOOP
    starts_on := make_date(selected_fiscal_year, month_number, 1);
    INSERT INTO fiscal_periods(
      organization_id, ledger_id, fiscal_year, period_number,
      label, starts_on, ends_on, state
    ) VALUES (
      selected_organization_id, generated_ledger_id, selected_fiscal_year,
      month_number, to_char(starts_on, 'FMMonth YYYY'), starts_on,
      (starts_on + interval '1 month - 1 day')::date, 'OPEN'
    );
  END LOOP;

  FOR account_record IN
    SELECT * FROM (VALUES
      ('1000', 'Cash', 'ASSET'::account_class, 'NONE'::control_account_kind),
      ('1100', 'Accounts receivable', 'ASSET'::account_class, 'AR'::control_account_kind),
      ('1400', 'Prepaid expenses', 'ASSET'::account_class, 'NONE'::control_account_kind),
      ('1500', 'Recoverable input tax', 'ASSET'::account_class, 'NONE'::control_account_kind),
      ('2000', 'Accounts payable', 'LIABILITY'::account_class, 'AP'::control_account_kind),
      ('2200', 'Sales and use tax payable', 'LIABILITY'::account_class, 'NONE'::control_account_kind),
      ('2300', 'Accrued liabilities', 'LIABILITY'::account_class, 'NONE'::control_account_kind),
      ('3000', 'Owner equity', 'EQUITY'::account_class, 'NONE'::control_account_kind),
      ('4100', 'Service revenue', 'REVENUE'::account_class, 'NONE'::control_account_kind),
      ('4900', 'Realized FX gain', 'REVENUE'::account_class, 'NONE'::control_account_kind),
      ('6100', 'Operating expenses', 'EXPENSE'::account_class, 'NONE'::control_account_kind),
      ('7100', 'Realized FX loss', 'EXPENSE'::account_class, 'NONE'::control_account_kind),
      ('7190', 'FX rounding', 'EXPENSE'::account_class, 'NONE'::control_account_kind)
    ) AS foundation(code, display_name, class, control_kind)
  LOOP
    INSERT INTO gl_accounts(
      organization_id, ledger_id, code, display_name, class,
      control_kind, postable, active, valid_from
    ) VALUES (
      selected_organization_id, generated_ledger_id, account_record.code,
      account_record.display_name, account_record.class, account_record.control_kind,
      true, true, make_date(selected_fiscal_year, 1, 1)
    ) RETURNING id INTO selected_account_id;
    INSERT INTO account_combinations(
      organization_id, ledger_id, entity_id, account_id
    ) VALUES (
      selected_organization_id, generated_ledger_id, generated_entity_id, selected_account_id
    );
  END LOOP;

  INSERT INTO ledger_posting_policies(
    organization_id, ledger_id, manual_mode, version, updated_by
  ) VALUES (
    selected_organization_id, generated_ledger_id,
    selected_manual_posting_mode, 1, selected_actor_id
  );
  INSERT INTO organization_currencies(
    organization_id, currency_code, enabled, created_by
  ) VALUES (
    selected_organization_id, normalized_currency, true, selected_actor_id
  )
  ON CONFLICT (organization_id, currency_code) DO UPDATE SET
    enabled = true, updated_at = now();

  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    'accounting.legal_entity.created',
    'legal_entity',
    generated_entity_id::text,
    jsonb_build_object(
      'code', normalized_code,
      'countryCode', normalized_country,
      'regionCode', normalized_region,
      'functionalCurrency', normalized_currency,
      'accountingProfile', selected_accounting_profile,
      'ledgerId', generated_ledger_id
    ),
    NULL
  );
  legal_entity_id := generated_entity_id;
  ledger_id := generated_ledger_id;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_create_legal_entity(
  text, text, text, text, text, accounting_profile, integer, manual_posting_mode
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_ledger_posting_policy_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id,
    'ledger.posting_policy.changed',
    'ledger',
    NEW.ledger_id::text,
    jsonb_build_object(
      'fromMode', OLD.manual_mode,
      'toMode', NEW.manual_mode,
      'fromVersion', OLD.version,
      'toVersion', NEW.version
    ),
    NULL
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.audit_ledger_posting_policy_changed() FROM PUBLIC;
--> statement-breakpoint

DROP TRIGGER IF EXISTS ledger_posting_policies_business_audit ON ledger_posting_policies;
CREATE TRIGGER ledger_posting_policies_business_audit
  AFTER UPDATE OF manual_mode ON ledger_posting_policies
  FOR EACH ROW
  WHEN (OLD.manual_mode IS DISTINCT FROM NEW.manual_mode)
  EXECUTE FUNCTION app.audit_ledger_posting_policy_changed();
--> statement-breakpoint

-- The writable demo mirrors an ordinary owner workspace; only its disposable
-- lifecycle and nightly seed reset differ from a real organization.
INSERT INTO role_permissions(organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, 'ledger.segments.manage'
FROM roles role
JOIN demo_sandbox_slots slot ON slot.organization_id = role.organization_id
WHERE role.key = 'demo_accountant'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO demo_sandbox_reset_tables(table_name, purge_order) VALUES
  ('organization_currencies', 28),
  ('currency_exchange_rates', 29)
ON CONFLICT (table_name) DO UPDATE SET purge_order = EXCLUDED.purge_order;
