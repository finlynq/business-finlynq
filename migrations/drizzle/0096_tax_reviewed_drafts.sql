CREATE TABLE "tax_draft_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"payload" jsonb NOT NULL,
	"review" jsonb,
	"review_hash" text,
	"result" jsonb,
	"correction_of_draft_id" uuid,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_draft_version_check" CHECK ("tax_draft_revisions"."version" > 0),
	CONSTRAINT "tax_draft_kind_check" CHECK ("tax_draft_revisions"."kind" IN ('MAPPING','CONFIGURATION','WORKPAPER')),
	CONSTRAINT "tax_draft_state_check" CHECK ("tax_draft_revisions"."state" IN ('DRAFT','REVIEWED','LOCKED','DISCARDED')),
	CONSTRAINT "tax_draft_payload_check" CHECK (jsonb_typeof("tax_draft_revisions"."payload")='object' AND ("tax_draft_revisions"."review" IS NULL OR jsonb_typeof("tax_draft_revisions"."review")='object') AND ("tax_draft_revisions"."result" IS NULL OR jsonb_typeof("tax_draft_revisions"."result")='object')),
	CONSTRAINT "tax_draft_review_check" CHECK (("tax_draft_revisions"."state" NOT IN ('REVIEWED','LOCKED') OR ("tax_draft_revisions"."review" IS NOT NULL AND "tax_draft_revisions"."review_hash" IS NOT NULL)) AND ("tax_draft_revisions"."state"<>'LOCKED' OR "tax_draft_revisions"."result" IS NOT NULL)),
	CONSTRAINT "tax_draft_hash_check" CHECK ("tax_draft_revisions"."command_hash" ~ '^[a-f0-9]{64}$' AND ("tax_draft_revisions"."review_hash" IS NULL OR "tax_draft_revisions"."review_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "tax_draft_reason_check" CHECK (length("tax_draft_revisions"."reason") BETWEEN 8 AND 500)
);
--> statement-breakpoint
CREATE TABLE "tax_workpaper_control_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"filing_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_workpaper_control_version_check" CHECK ("tax_workpaper_control_events"."version" > 0),
	CONSTRAINT "tax_workpaper_control_action_check" CHECK ("tax_workpaper_control_events"."action" IN ('CREATED','DELETE','RESTORE','REVIEW','LOCK','EXPORT')),
	CONSTRAINT "tax_workpaper_control_hash_check" CHECK ("tax_workpaper_control_events"."command_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "tax_workpaper_control_reason_check" CHECK (length("tax_workpaper_control_events"."reason") BETWEEN 8 AND 500)
);
--> statement-breakpoint
ALTER TABLE "tax_draft_revisions" ADD CONSTRAINT "tax_draft_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_workpaper_control_events" ADD CONSTRAINT "tax_workpaper_control_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_workpaper_control_events" ADD CONSTRAINT "tax_workpaper_control_filing_fk" FOREIGN KEY ("organization_id","filing_id") REFERENCES "public"."tax_filings"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_draft_revision_unique" ON "tax_draft_revisions" USING btree ("organization_id","draft_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_draft_replay_unique" ON "tax_draft_revisions" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_workpaper_control_version_unique" ON "tax_workpaper_control_events" USING btree ("organization_id","filing_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_workpaper_control_replay_unique" ON "tax_workpaper_control_events" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
ALTER TABLE tax_draft_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_draft_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_draft_revisions USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
ALTER TABLE tax_workpaper_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_workpaper_control_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_workpaper_control_events USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
REVOKE ALL ON tax_draft_revisions,tax_workpaper_control_events FROM PUBLIC;
CREATE TRIGGER tax_draft_revision_immutable BEFORE UPDATE OR DELETE ON tax_draft_revisions FOR EACH ROW EXECUTE FUNCTION app.guard_guidance_revision_immutable();
CREATE TRIGGER tax_workpaper_control_immutable BEFORE UPDATE OR DELETE ON tax_workpaper_control_events FOR EACH ROW EXECUTE FUNCTION app.guard_guidance_revision_immutable();
--> statement-breakpoint
CREATE FUNCTION app.tax_workpaper_deleted(selected_organization uuid,selected_filing uuid) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT action='DELETE' FROM tax_workpaper_control_events
 WHERE organization_id=selected_organization AND filing_id=selected_filing AND action IN ('DELETE','RESTORE') ORDER BY version DESC LIMIT 1),false)
$$;
--> statement-breakpoint
CREATE FUNCTION app.guard_tax_draft_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE predecessor tax_draft_revisions%ROWTYPE; required_permission text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tax-governance:'||NEW.organization_id::text,0));
 required_permission:=CASE NEW.kind WHEN 'MAPPING' THEN 'tax.mappings.manage' WHEN 'CONFIGURATION' THEN 'tax.filing.configuration.manage' ELSE 'tax.filings.prepare' END;
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.created_by IS DISTINCT FROM app.current_actor_id() OR NOT app.current_actor_has_permission(required_permission) THEN
  RAISE EXCEPTION 'Tax drafting requires the authorized tenant actor' USING ERRCODE='42501'; END IF;
 SELECT * INTO predecessor FROM tax_draft_revisions WHERE organization_id=NEW.organization_id AND draft_id=NEW.draft_id ORDER BY version DESC LIMIT 1;
 IF NEW.version<>coalesce(predecessor.version,0)+1 OR (predecessor.id IS NULL AND NEW.state<>'DRAFT') OR predecessor.state='LOCKED'
  OR (predecessor.id IS NOT NULL AND NEW.kind<>predecessor.kind)
  OR (NEW.state='LOCKED' AND (predecessor.state<>'REVIEWED' OR NEW.review_hash IS DISTINCT FROM predecessor.review_hash OR NEW.payload IS DISTINCT FROM predecessor.payload))
  OR (NEW.state IN ('REVIEWED','DISCARDED') AND NEW.payload IS DISTINCT FROM predecessor.payload)
  OR (predecessor.state='DISCARDED' AND (NEW.state<>'DRAFT' OR NEW.payload IS DISTINCT FROM predecessor.payload)) THEN
  RAISE EXCEPTION 'Tax draft revision or approval is stale or locked' USING ERRCODE='23514'; END IF;
 IF NEW.correction_of_draft_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tax_draft_revisions WHERE organization_id=NEW.organization_id AND draft_id=NEW.correction_of_draft_id AND kind=NEW.kind AND state='LOCKED') THEN
  RAISE EXCEPTION 'Correction requires a locked original draft' USING ERRCODE='23514'; END IF;
 IF NEW.result->>'filingId' IS NOT NULL AND app.tax_workpaper_deleted(NEW.organization_id,(NEW.result->>'filingId')::uuid) THEN RAISE EXCEPTION 'Restore this deleted workpaper before locking it' USING ERRCODE='23514'; END IF;
 PERFORM app.append_tenant_business_audit(NEW.organization_id,'tax.draft.'||lower(NEW.state),'tax-draft',NEW.draft_id::text,
 jsonb_build_object('revisionId',NEW.id,'version',NEW.version,'kind',NEW.kind,'reviewHash',NEW.review_hash,'correctionOfDraftId',NEW.correction_of_draft_id,'reason',NEW.reason),NULL);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_tax_draft_revision() FROM PUBLIC;
CREATE TRIGGER tax_draft_revision_guard BEFORE INSERT ON tax_draft_revisions FOR EACH ROW EXECUTE FUNCTION app.guard_tax_draft_revision();
--> statement-breakpoint
CREATE FUNCTION app.guard_tax_workpaper_control() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_version integer; required_permission text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tax-governance:'||NEW.organization_id::text,0));
 required_permission:=CASE NEW.action WHEN 'CREATED' THEN 'tax.filings.prepare' WHEN 'EXPORT' THEN 'tax.read' ELSE 'tax.filing.canonical.manage' END;
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.created_by IS DISTINCT FROM app.current_actor_id() OR NOT app.current_actor_has_permission(required_permission) THEN
  RAISE EXCEPTION 'Workpaper control requires the authorized tenant actor' USING ERRCODE='42501'; END IF;
 SELECT max(version) INTO previous_version FROM tax_workpaper_control_events WHERE organization_id=NEW.organization_id AND filing_id=NEW.filing_id;
 IF NEW.version<>coalesce(previous_version,0)+1 OR (NEW.action='CREATED' AND (previous_version IS NOT NULL OR pg_trigger_depth()<2)) THEN
  RAISE EXCEPTION 'Workpaper control version is stale' USING ERRCODE='23514'; END IF;
 IF NEW.action<>'RESTORE' AND app.tax_workpaper_deleted(NEW.organization_id,NEW.filing_id) THEN RAISE EXCEPTION 'Restore this deleted draft before use' USING ERRCODE='23514'; END IF;
 IF NEW.action='RESTORE' AND NOT app.tax_workpaper_deleted(NEW.organization_id,NEW.filing_id) THEN RAISE EXCEPTION 'Only a deleted draft can be restored' USING ERRCODE='23514'; END IF;
 IF NEW.action='DELETE' AND (
  NOT EXISTS(SELECT 1 FROM tax_workpaper_control_events WHERE organization_id=NEW.organization_id AND filing_id=NEW.filing_id AND action='CREATED')
  OR EXISTS(SELECT 1 FROM tax_workpaper_control_events WHERE organization_id=NEW.organization_id AND filing_id=NEW.filing_id AND action IN ('EXPORT','REVIEW','LOCK'))
  OR EXISTS(SELECT 1 FROM tax_filings WHERE organization_id=NEW.organization_id AND id=NEW.filing_id AND (filing_type<>'PREPARED' OR external_reference IS NOT NULL OR source_file_name IS NOT NULL OR coalesce(template_snapshot->'inputReportedValues','{}'::jsonb)<>'{}'::jsonb OR template_snapshot->>'refreshedFromFilingId' IS NOT NULL OR template_snapshot->>'correctionOfFilingId' IS NOT NULL))
  OR EXISTS(SELECT 1 FROM tax_filings WHERE organization_id=NEW.organization_id AND (template_snapshot->>'refreshedFromFilingId'=NEW.filing_id::text OR template_snapshot->>'correctionOfFilingId'=NEW.filing_id::text))
  OR EXISTS(SELECT 1 FROM tax_filing_canonical_selections WHERE organization_id=NEW.organization_id AND filing_id=NEW.filing_id)
  OR EXISTS(SELECT 1 FROM tax_filing_lifecycle_events WHERE organization_id=NEW.organization_id AND (replacement_filing_id=NEW.filing_id OR (filing_id=NEW.filing_id AND state IN ('ARCHIVED','SUPERSEDED'))))
  OR EXISTS(SELECT 1 FROM tax_filing_asset_adjustments WHERE organization_id=NEW.organization_id AND filing_id=NEW.filing_id)
  OR EXISTS(SELECT 1 FROM tax_draft_revisions WHERE organization_id=NEW.organization_id AND state='LOCKED' AND result->>'filingId'=NEW.filing_id::text)
 ) THEN RAISE EXCEPTION 'This workpaper is retained, referenced, reviewed or locked' USING ERRCODE='23514'; END IF;
 PERFORM app.append_tenant_business_audit(NEW.organization_id,'tax.workpaper.'||lower(NEW.action),'tax-workpaper',NEW.filing_id::text,
 jsonb_build_object('eventId',NEW.id,'version',NEW.version,'reason',NEW.reason),NULL);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_tax_workpaper_control() FROM PUBLIC;
CREATE TRIGGER tax_workpaper_control_guard BEFORE INSERT ON tax_workpaper_control_events FOR EACH ROW EXECUTE FUNCTION app.guard_tax_workpaper_control();
--> statement-breakpoint
CREATE FUNCTION app.capture_tax_workpaper_creation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO tax_workpaper_control_events(organization_id,filing_id,version,action,reason,idempotency_key,command_hash,created_by)
 VALUES(NEW.organization_id,NEW.id,1,'CREATED','Workpaper preparation captured before any review or export','created:'||NEW.id::text,NEW.command_hash,NEW.created_by);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.capture_tax_workpaper_creation() FROM PUBLIC;
CREATE TRIGGER tax_workpaper_creation_capture AFTER INSERT ON tax_filings FOR EACH ROW EXECUTE FUNCTION app.capture_tax_workpaper_creation();
--> statement-breakpoint
CREATE FUNCTION app.guard_tax_workpaper_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target_id uuid; second_id uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tax-governance:'||NEW.organization_id::text,0));
 target_id:=CASE WHEN TG_TABLE_NAME='tax_filings' THEN (to_jsonb(NEW)->'template_snapshot'->>'refreshedFromFilingId')::uuid ELSE (to_jsonb(NEW)->>'filing_id')::uuid END;
 second_id:=coalesce((to_jsonb(NEW)->>'replacement_filing_id')::uuid,(to_jsonb(NEW)->'template_snapshot'->>'correctionOfFilingId')::uuid);
 IF TG_TABLE_NAME='tax_filings' AND second_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM tax_filings original JOIN tax_filing_templates old_template ON old_template.id=original.template_id
  JOIN tax_filing_templates new_template ON new_template.id=(to_jsonb(NEW)->>'template_id')::uuid AND new_template.template_key=old_template.template_key
  WHERE original.organization_id=NEW.organization_id AND original.id=second_id AND original.filing_type='PREPARED'
    AND original.legal_entity_id=(to_jsonb(NEW)->>'legal_entity_id')::uuid AND original.ledger_id=(to_jsonb(NEW)->>'ledger_id')::uuid
    AND original.period_start=(to_jsonb(NEW)->>'period_start')::date AND original.period_end=(to_jsonb(NEW)->>'period_end')::date
    AND to_jsonb(NEW)->>'filing_type'='PREPARED'
 ) THEN RAISE EXCEPTION 'Workpaper correction lineage is outside the exact original scope' USING ERRCODE='23514'; END IF;
 IF app.tax_workpaper_deleted(NEW.organization_id,target_id) OR app.tax_workpaper_deleted(NEW.organization_id,second_id) THEN
 RAISE EXCEPTION 'Restore this deleted workpaper before referencing it' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_tax_workpaper_reference() FROM PUBLIC;
CREATE TRIGGER tax_workpaper_refresh_reference BEFORE INSERT ON tax_filings FOR EACH ROW EXECUTE FUNCTION app.guard_tax_workpaper_reference();
CREATE TRIGGER tax_workpaper_canonical_reference BEFORE INSERT ON tax_filing_canonical_selections FOR EACH ROW EXECUTE FUNCTION app.guard_tax_workpaper_reference();
CREATE TRIGGER tax_workpaper_lifecycle_reference BEFORE INSERT ON tax_filing_lifecycle_events FOR EACH ROW EXECUTE FUNCTION app.guard_tax_workpaper_reference();

CREATE TRIGGER tax_workpaper_asset_reference BEFORE INSERT ON tax_filing_asset_adjustments FOR EACH ROW EXECUTE FUNCTION app.guard_tax_workpaper_reference();

--> statement-breakpoint
INSERT INTO demo_sandbox_reset_tables(table_name,purge_order)
SELECT reset_table.table_name,reset_state.maximum_order+reset_table.ordinal::integer
FROM (SELECT coalesce(max(purge_order),0) AS maximum_order FROM demo_sandbox_reset_tables) reset_state
CROSS JOIN unnest(ARRAY['tax_draft_revisions','tax_workpaper_control_events']::text[]) WITH ORDINALITY AS reset_table(table_name,ordinal)
ON CONFLICT(table_name) DO NOTHING;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_tax_filing_governance_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME='tax_filing_configurations' THEN
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
      (NEW.version=1 AND NEW.supersedes_configuration_id IS NULL)
      OR EXISTS (
        SELECT 1 FROM tax_filing_configurations prior
        WHERE prior.organization_id=NEW.organization_id
          AND prior.id=NEW.supersedes_configuration_id
          AND prior.legal_entity_id=NEW.legal_entity_id
          AND prior.registration_id IS NOT DISTINCT FROM NEW.registration_id
          AND prior.filing_type_key=NEW.filing_type_key
          AND prior.version+1=NEW.version
          AND prior.effective_from<=NEW.effective_from
          AND NOT (prior.state='ACTIVE' AND prior.effective_to IS NOT NULL
            AND NEW.state='ACTIVE' AND NEW.effective_from<=prior.effective_to)
      )
    ) THEN
      RAISE EXCEPTION 'Tax filing configuration revision lineage is invalid' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='tax_filing_lifecycle_events' THEN
    IF NOT (
      (NEW.version=1 AND NEW.supersedes_event_id IS NULL AND NEW.replacement_filing_id IS NULL
        AND EXISTS (
          SELECT 1 FROM tax_filings filing
          WHERE filing.organization_id=NEW.organization_id AND filing.id=NEW.filing_id
            AND ((filing.filing_type='PREPARED' AND (NEW.state='CURRENT' OR (NEW.state='HISTORICAL' AND filing.template_snapshot->>'correctionOfFilingId' IS NOT NULL)))
              OR (filing.filing_type='HISTORICAL_IMPORT' AND NEW.state='HISTORICAL'))
        ))
      OR (NEW.version>1 AND EXISTS (
        SELECT 1 FROM tax_filing_lifecycle_events prior
        WHERE prior.organization_id=NEW.organization_id AND prior.id=NEW.supersedes_event_id
          AND prior.filing_id=NEW.filing_id AND prior.version+1=NEW.version
      ))
    ) THEN
      RAISE EXCEPTION 'Tax filing lifecycle lineage is invalid' USING ERRCODE='23514';
    END IF;
    IF (NEW.state='SUPERSEDED') IS DISTINCT FROM (NEW.replacement_filing_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Superseded lifecycle requires exactly one replacement' USING ERRCODE='23514';
    END IF;
    IF NEW.replacement_filing_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM tax_filings original
      JOIN tax_filing_configurations original_configuration
        ON original_configuration.organization_id=original.organization_id
       AND original_configuration.id=original.configuration_id
      JOIN tax_filings replacement
        ON replacement.organization_id=original.organization_id
       AND replacement.id=NEW.replacement_filing_id
       AND replacement.legal_entity_id=original.legal_entity_id
       AND replacement.period_start=original.period_start
       AND replacement.period_end=original.period_end
      JOIN tax_filing_configurations replacement_configuration
        ON replacement_configuration.organization_id=replacement.organization_id
       AND replacement_configuration.id=replacement.configuration_id
       AND replacement_configuration.registration_id IS NOT DISTINCT FROM original_configuration.registration_id
       AND replacement_configuration.filing_type_key=original_configuration.filing_type_key
      JOIN tax_filing_lifecycle_events replacement_lifecycle
        ON replacement_lifecycle.organization_id=replacement.organization_id
       AND replacement_lifecycle.filing_id=replacement.id
       AND replacement_lifecycle.state NOT IN ('ARCHIVED','SUPERSEDED')
       AND NOT EXISTS (SELECT 1 FROM tax_filing_lifecycle_events successor
         WHERE successor.organization_id=replacement_lifecycle.organization_id
           AND successor.supersedes_event_id=replacement_lifecycle.id)
      WHERE original.organization_id=NEW.organization_id AND original.id=NEW.filing_id
    ) THEN
      RAISE EXCEPTION 'Tax filing replacement scope or lifecycle is invalid' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM tax_filings filing
      JOIN tax_filing_configurations configuration
        ON configuration.organization_id=filing.organization_id AND configuration.id=filing.configuration_id
      JOIN tax_filing_lifecycle_events lifecycle
        ON lifecycle.organization_id=filing.organization_id AND lifecycle.filing_id=filing.id
      WHERE filing.organization_id=NEW.organization_id AND filing.id=NEW.filing_id
        AND filing.legal_entity_id=NEW.legal_entity_id
        AND configuration.registration_id IS NOT DISTINCT FROM NEW.registration_id
        AND configuration.filing_type_key=NEW.filing_type_key
        AND filing.period_start=NEW.period_start AND filing.period_end=NEW.period_end
        AND lifecycle.state NOT IN ('ARCHIVED','SUPERSEDED')
        AND NOT EXISTS (SELECT 1 FROM tax_filing_lifecycle_events successor
          WHERE successor.organization_id=lifecycle.organization_id
            AND successor.supersedes_event_id=lifecycle.id)
    ) OR NOT (
      (NEW.version=1 AND NEW.supersedes_selection_id IS NULL)
      OR EXISTS (
        SELECT 1 FROM tax_filing_canonical_selections prior
        WHERE prior.organization_id=NEW.organization_id AND prior.id=NEW.supersedes_selection_id
          AND prior.legal_entity_id=NEW.legal_entity_id
          AND prior.registration_id IS NOT DISTINCT FROM NEW.registration_id
          AND prior.filing_type_key=NEW.filing_type_key
          AND prior.period_start=NEW.period_start AND prior.period_end=NEW.period_end
          AND prior.version+1=NEW.version
      )
    ) THEN
      RAISE EXCEPTION 'Tax filing canonical selection scope or lineage is invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
