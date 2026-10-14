ALTER TABLE "tax_filing_configurations" ADD COLUMN "correction_of_configuration_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_filing_configurations" ADD CONSTRAINT "tax_filing_configurations_org_correction_fk" FOREIGN KEY ("organization_id","correction_of_configuration_id") REFERENCES "public"."tax_filing_configurations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_configurations" ADD CONSTRAINT "tax_filing_configurations_correction_lineage_check" CHECK ("tax_filing_configurations"."correction_of_configuration_id" IS NULL OR "tax_filing_configurations"."correction_of_configuration_id" = "tax_filing_configurations"."supersedes_configuration_id");--> statement-breakpoint

-- The original governance trigger also handles filing lifecycle and canonical
-- selection records. Replace only its configuration branch. A correction can
-- move the effective start backwards only when the superseded revision has no
-- filing snapshot, and the revised date still respects the earlier lineage.
CREATE FUNCTION app.guard_tax_filing_configuration_integrity_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM legal_entities entity
    JOIN ledgers ledger ON ledger.organization_id=entity.organization_id
      AND ledger.legal_entity_id=entity.id AND ledger.id=NEW.ledger_id
    JOIN tax_filing_templates template ON template.id=NEW.template_id
      AND template.template_key=NEW.filing_type_key
      AND template.effective_from<=NEW.effective_from
      AND (template.effective_to IS NULL OR
        (NEW.effective_to IS NOT NULL AND template.effective_to>=NEW.effective_to))
    JOIN tax_account_mapping_sets mapping ON mapping.organization_id=entity.organization_id
      AND mapping.id=NEW.mapping_set_id AND mapping.legal_entity_id=entity.id
      AND mapping.ledger_id=ledger.id AND mapping.template_id=template.id
      AND mapping.state='ACTIVE' AND mapping.effective_from<=NEW.effective_from
      AND (mapping.effective_to IS NULL OR
        (NEW.effective_to IS NOT NULL AND mapping.effective_to>=NEW.effective_to))
    WHERE entity.organization_id=NEW.organization_id AND entity.id=NEW.legal_entity_id
      AND (NEW.registration_id IS NULL OR EXISTS (
        SELECT 1 FROM entity_tax_registrations registration
        WHERE registration.organization_id=NEW.organization_id
          AND registration.id=NEW.registration_id
          AND registration.legal_entity_id=NEW.legal_entity_id
          AND registration.valid_from<=NEW.effective_from
          AND (registration.valid_to IS NULL OR registration.valid_to>=coalesce(NEW.effective_to,NEW.effective_from))
      ))
      AND (NEW.filing_type_key<>'ca.gst-hst.return' OR NEW.registration_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Tax filing configuration dependencies are invalid' USING ERRCODE='23514';
  END IF;

  IF NOT (
    (NEW.version=1 AND NEW.supersedes_configuration_id IS NULL
      AND NEW.correction_of_configuration_id IS NULL)
    OR EXISTS (
      SELECT 1 FROM tax_filing_configurations prior
      WHERE prior.organization_id=NEW.organization_id
        AND prior.id=NEW.supersedes_configuration_id
        AND prior.legal_entity_id=NEW.legal_entity_id
        AND prior.ledger_id=NEW.ledger_id
        AND prior.registration_id IS NOT DISTINCT FROM NEW.registration_id
        AND prior.filing_type_key=NEW.filing_type_key
        AND prior.version+1=NEW.version
        AND (
          (NEW.correction_of_configuration_id IS NULL
            AND prior.effective_from<=NEW.effective_from
            AND NOT (prior.state='ACTIVE' AND prior.effective_to IS NOT NULL
              AND NEW.state='ACTIVE' AND NEW.effective_from<=prior.effective_to))
          OR (
            NEW.correction_of_configuration_id=prior.id
            AND NOT EXISTS (SELECT 1 FROM tax_filings filing
              WHERE filing.organization_id=prior.organization_id
                AND filing.configuration_id=prior.id)
            AND (
              prior.supersedes_configuration_id IS NULL
              OR EXISTS (
                SELECT 1 FROM tax_filing_configurations predecessor
                WHERE predecessor.organization_id=prior.organization_id
                  AND predecessor.id=prior.supersedes_configuration_id
                  AND predecessor.effective_from<=NEW.effective_from
                  AND NOT (predecessor.state='ACTIVE' AND predecessor.effective_to IS NOT NULL
                    AND NEW.state='ACTIVE' AND NEW.effective_from<=predecessor.effective_to)
              )
            )
          )
        )
    )
  ) THEN
    RAISE EXCEPTION 'Tax filing configuration revision lineage is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_tax_filing_configuration_integrity_v2() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER tax_filing_configurations_integrity_guard ON tax_filing_configurations;--> statement-breakpoint
CREATE TRIGGER tax_filing_configurations_integrity_guard
  BEFORE INSERT ON tax_filing_configurations
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_configuration_integrity_v2();
--> statement-breakpoint

-- Keep the exact correction lineage and before/after selection in the
-- append-only business-audit chain as well as on the immutable revision rows.
CREATE OR REPLACE FUNCTION app.audit_tax_filing_governance_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id,
    CASE TG_TABLE_NAME
      WHEN 'tax_filing_configurations' THEN 'tax.filing.configuration-version-created'
      WHEN 'tax_filing_canonical_selections' THEN 'tax.filing.canonical-version-created'
      ELSE 'tax.filing.lifecycle-version-created'
    END,
    TG_TABLE_NAME,NEW.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'version',NEW.version,'state',NEW.state,'commandHash',NEW.command_hash,
      'filingId',to_jsonb(NEW)->>'filing_id','templateId',to_jsonb(NEW)->>'template_id',
      'mappingSetId',to_jsonb(NEW)->>'mapping_set_id',
      'supersedesConfigurationId',to_jsonb(NEW)->>'supersedes_configuration_id',
      'correctionOfConfigurationId',to_jsonb(NEW)->>'correction_of_configuration_id',
      'effectiveFrom',to_jsonb(NEW)->>'effective_from',
      'effectiveTo',to_jsonb(NEW)->>'effective_to',
      'reason',to_jsonb(NEW)->>'reason'
    )),NULL
  );
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.audit_tax_filing_governance_event() FROM PUBLIC;
