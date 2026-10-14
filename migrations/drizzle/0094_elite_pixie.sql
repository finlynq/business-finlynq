ALTER TABLE "tax_account_mapping_sets" ADD COLUMN "correction_of_mapping_set_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD CONSTRAINT "tax_account_mapping_sets_org_correction_fk" FOREIGN KEY ("organization_id","correction_of_mapping_set_id") REFERENCES "public"."tax_account_mapping_sets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD CONSTRAINT "tax_account_mapping_sets_correction_lineage_check" CHECK ("tax_account_mapping_sets"."correction_of_mapping_set_id" IS NULL OR "tax_account_mapping_sets"."correction_of_mapping_set_id" = "tax_account_mapping_sets"."supersedes_mapping_set_id");
--> statement-breakpoint

CREATE FUNCTION app.guard_tax_mapping_correction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior tax_account_mapping_sets%ROWTYPE;
  predecessor tax_account_mapping_sets%ROWTYPE;
BEGIN
  IF NEW.correction_of_mapping_set_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO prior FROM tax_account_mapping_sets
    WHERE organization_id=NEW.organization_id AND id=NEW.correction_of_mapping_set_id;
  IF NOT FOUND OR prior.id IS DISTINCT FROM NEW.supersedes_mapping_set_id
    OR prior.legal_entity_id IS DISTINCT FROM NEW.legal_entity_id
    OR prior.ledger_id IS DISTINCT FROM NEW.ledger_id
    OR prior.template_id IS DISTINCT FROM NEW.template_id
    OR prior.version+1 IS DISTINCT FROM NEW.version
    OR prior.state <> 'ACTIVE' OR NEW.state <> 'ACTIVE'
    OR EXISTS (SELECT 1 FROM tax_filing_configurations configuration
      WHERE configuration.organization_id=NEW.organization_id
        AND configuration.mapping_set_id=prior.id)
    OR EXISTS (SELECT 1 FROM tax_filings filing
      WHERE filing.organization_id=NEW.organization_id
        AND filing.mapping_set_id=prior.id)
  THEN
    RAISE EXCEPTION 'The tax mapping correction must replace an exact unreferenced active revision'
      USING ERRCODE='23514';
  END IF;
  IF prior.supersedes_mapping_set_id IS NOT NULL THEN
    SELECT * INTO predecessor FROM tax_account_mapping_sets
      WHERE organization_id=NEW.organization_id AND id=prior.supersedes_mapping_set_id;
    IF NOT FOUND OR predecessor.effective_from >= NEW.effective_from
      OR (predecessor.effective_to IS NOT NULL
        AND predecessor.effective_to >= NEW.effective_from) THEN
      RAISE EXCEPTION 'The corrected tax mapping date conflicts with its earlier revision'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_tax_mapping_correction() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER tax_account_mapping_sets_correction_guard
  BEFORE INSERT ON tax_account_mapping_sets
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_mapping_correction();
--> statement-breakpoint

CREATE FUNCTION app.audit_tax_mapping_correction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  prior tax_account_mapping_sets%ROWTYPE;
  original_lines jsonb;
  corrected_lines jsonb;
BEGIN
  SELECT * INTO prior FROM tax_account_mapping_sets
    WHERE organization_id=NEW.organization_id AND id=NEW.correction_of_mapping_set_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'fieldKey',field_key,'accountId',gl_account_id,'balanceBasis',balance_basis,
    'multiplier',multiplier) ORDER BY field_key,gl_account_id),'[]'::jsonb)
    INTO original_lines FROM tax_account_mapping_lines
    WHERE organization_id=NEW.organization_id AND mapping_set_id=prior.id;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'fieldKey',field_key,'accountId',gl_account_id,'balanceBasis',balance_basis,
    'multiplier',multiplier) ORDER BY field_key,gl_account_id),'[]'::jsonb)
    INTO corrected_lines FROM tax_account_mapping_lines
    WHERE organization_id=NEW.organization_id AND mapping_set_id=NEW.id;
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id,'tax.mapping.corrected','tax_account_mapping_set',NEW.id::text,
    jsonb_build_object(
      'originalId',prior.id,'replacementId',NEW.id,
      'originalVersion',prior.version,'replacementVersion',NEW.version,
      'originalEffectiveFrom',prior.effective_from,'replacementEffectiveFrom',NEW.effective_from,
      'originalEffectiveTo',prior.effective_to,'replacementEffectiveTo',NEW.effective_to,
      'originalLines',original_lines,'replacementLines',corrected_lines,
      'reason',NEW.reason,'commandHash',NEW.command_hash
    ),NULL);
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.audit_tax_mapping_correction() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER tax_account_mapping_sets_correction_audit
  AFTER INSERT ON tax_account_mapping_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.correction_of_mapping_set_id IS NOT NULL)
  EXECUTE FUNCTION app.audit_tax_mapping_correction();
--> statement-breakpoint

-- Keep the ordinary forward-date rule in the deferred guard. Only an exact
-- correction previously checked by the correction guard may move backwards.
CREATE OR REPLACE FUNCTION app.guard_tax_account_mapping_set()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  predecessor tax_account_mapping_sets%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM legal_entities entity
    JOIN ledgers ledger ON ledger.organization_id=entity.organization_id
      AND ledger.legal_entity_id=entity.id AND ledger.id=NEW.ledger_id
    JOIN tax_filing_templates template ON template.id=NEW.template_id
      AND template.currency_code=ledger.functional_currency
    WHERE entity.organization_id=NEW.organization_id
      AND entity.id=NEW.legal_entity_id AND entity.active AND ledger.active
  ) OR (NEW.version=1 AND NEW.supersedes_mapping_set_id IS NOT NULL)
    OR (NEW.version>1 AND NEW.supersedes_mapping_set_id IS NULL)
    OR (NEW.state='ACTIVE' AND EXISTS (
      SELECT 1 FROM tax_filing_templates template
      CROSS JOIN LATERAL jsonb_array_elements(template.definition -> 'fields') field
      WHERE template.id=NEW.template_id AND field ->> 'kind'='ACCOUNT'
        AND (field ->> 'required')::boolean
        AND NOT EXISTS (SELECT 1 FROM tax_account_mapping_lines line
          WHERE line.organization_id=NEW.organization_id
            AND line.mapping_set_id=NEW.id AND line.field_key=field ->> 'key')
    )) OR (NEW.state='INACTIVE' AND EXISTS (
      SELECT 1 FROM tax_account_mapping_lines line
      WHERE line.organization_id=NEW.organization_id AND line.mapping_set_id=NEW.id
    )) THEN
    RAISE EXCEPTION 'Tax mapping set scope, state, or required field coverage is invalid'
      USING ERRCODE='23514';
  END IF;
  IF NEW.version>1 THEN
    SELECT * INTO predecessor FROM tax_account_mapping_sets mapping
    WHERE mapping.organization_id=NEW.organization_id
      AND mapping.id=NEW.supersedes_mapping_set_id
      AND NOT EXISTS (SELECT 1 FROM tax_account_mapping_sets successor
        WHERE successor.organization_id=mapping.organization_id
          AND successor.supersedes_mapping_set_id=mapping.id
          AND successor.id<>NEW.id);
    IF predecessor.id IS NULL
      OR predecessor.legal_entity_id<>NEW.legal_entity_id
      OR predecessor.ledger_id<>NEW.ledger_id
      OR predecessor.template_id<>NEW.template_id
      OR predecessor.version<>NEW.version-1
      OR (NEW.effective_from<=predecessor.effective_from
        AND NEW.correction_of_mapping_set_id IS DISTINCT FROM predecessor.id) THEN
      RAISE EXCEPTION 'Tax mapping version must supersede the exact current scope prospectively'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_tax_account_mapping_set() FROM PUBLIC;
