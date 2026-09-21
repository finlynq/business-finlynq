-- BUSINESS-FINLYNQ-61: the shared audit trigger previously referenced
-- the trigger record's version field while handling tax_filings, whose row type has no version
-- column. PostgreSQL resolves that record access before the CASE branch can
-- protect it, so every otherwise-valid workpaper insert rolled back. Read the
-- polymorphic trigger row through jsonb and preserve the same bounded audit
-- metadata for both supported tables.
CREATE OR REPLACE FUNCTION app.audit_tax_filing_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_action text;
  selected_type text;
  selected_row jsonb := to_jsonb(NEW);
  selected_metadata jsonb;
BEGIN
  selected_action := CASE TG_TABLE_NAME
    WHEN 'tax_account_mapping_sets' THEN 'tax.mapping.version-created'
    ELSE CASE selected_row ->> 'filing_type'
      WHEN 'HISTORICAL_IMPORT' THEN 'tax.filing.historical-reconciled'
      ELSE 'tax.filing.prepared'
    END
  END;
  selected_type := CASE TG_TABLE_NAME
    WHEN 'tax_account_mapping_sets' THEN 'tax_account_mapping_set'
    ELSE 'tax_filing'
  END;
  selected_metadata := CASE TG_TABLE_NAME
    WHEN 'tax_account_mapping_sets' THEN jsonb_build_object(
      'legalEntityId', selected_row ->> 'legal_entity_id',
      'ledgerId', selected_row ->> 'ledger_id',
      'templateId', selected_row ->> 'template_id',
      'version', selected_row -> 'version',
      'commandHash', selected_row ->> 'command_hash'
    )
    ELSE jsonb_build_object(
      'legalEntityId', selected_row ->> 'legal_entity_id',
      'ledgerId', selected_row ->> 'ledger_id',
      'templateId', selected_row ->> 'template_id',
      'mappingSetId', selected_row ->> 'mapping_set_id',
      'filingType', selected_row ->> 'filing_type',
      'status', selected_row ->> 'status',
      'periodStart', selected_row ->> 'period_start',
      'periodEnd', selected_row ->> 'period_end',
      'externalReferencePresent', selected_row ->> 'external_reference' IS NOT NULL,
      'sourceFileNamePresent', selected_row ->> 'source_file_name' IS NOT NULL,
      'commandHash', selected_row ->> 'command_hash'
    )
  END;
  PERFORM app.append_tenant_business_audit(
    (selected_row ->> 'organization_id')::uuid,
    selected_action,
    selected_type,
    selected_row ->> 'id',
    jsonb_strip_nulls(selected_metadata),
    NULL
  );
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.audit_tax_filing_event() FROM PUBLIC;
