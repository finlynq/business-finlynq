-- Let a new organization choose any ISO country and any supported functional
-- currency. Accounting profiles remain deliberately versioned enum values;
-- unsupported local tax facts are held for review by the tax engine.

ALTER TABLE auth_organization_signups
  DROP CONSTRAINT auth_organization_signups_country_check,
  DROP CONSTRAINT auth_organization_signups_country_profile_check;
--> statement-breakpoint
ALTER TABLE auth_organization_signups
  ADD CONSTRAINT auth_organization_signups_country_check
    CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT auth_organization_signups_supported_currency_check
    CHECK (app.currency_minor_units(functional_currency) IS NOT NULL);
--> statement-breakpoint

DO $migration$
DECLARE
  function_signature regprocedure;
  function_definition text;
  previous_validation text := $old$
    OR NOT (
      (selected_country_code = 'CA' AND selected_functional_currency = 'CAD'
        AND selected_accounting_profile = 'CAN_ASPE')
      OR
      (selected_country_code = 'US' AND selected_functional_currency = 'USD'
        AND selected_accounting_profile = 'US_GAAP_NONPUBLIC')
    ) THEN
$old$;
  global_validation text := $new$
    OR selected_country_code !~ '^[A-Z]{2}$'
    OR app.currency_minor_units(selected_functional_currency) IS NULL THEN
$new$;
BEGIN
  function_signature := to_regprocedure(
    'app.auth_begin_organization_signup(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,accounting_profile,integer,manual_posting_mode,text,text,text,text,uuid,text,text,text)'
  );
  IF function_signature IS NULL THEN
    RAISE EXCEPTION 'Canonical organization-signup function is missing';
  END IF;

  SELECT pg_get_functiondef(function_signature) INTO function_definition;
  IF position(previous_validation IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Organization-signup validation no longer matches the reviewed predecessor';
  END IF;

  function_definition := replace(
    function_definition,
    previous_validation,
    global_validation
  );
  EXECUTE function_definition;
END
$migration$;
--> statement-breakpoint

COMMENT ON FUNCTION app.auth_begin_organization_signup(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text,
  text, text, text, accounting_profile, integer, manual_posting_mode,
  text, text, text, text, uuid, text, text, text
) IS 'Starts an encrypted owner signup for an ISO-country entity, supported functional currency, and explicit accounting profile.';
