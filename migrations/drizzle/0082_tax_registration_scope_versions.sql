CREATE TABLE "tax_registration_scope_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"destination_city" text,
	"location_code" text,
	"configuration_evidence" text NOT NULL,
	"reason" text NOT NULL,
	"historical_evidence_count" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_registration_scope_version_check" CHECK ("tax_registration_scope_versions"."version" >= 2 AND "tax_registration_scope_versions"."historical_evidence_count" >= 0),
	CONSTRAINT "tax_registration_scope_hash_check" CHECK ("tax_registration_scope_versions"."idempotency_key" ~ '^[a-f0-9]{64}$' AND "tax_registration_scope_versions"."command_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "tax_registration_scope_evidence_check" CHECK (length("tax_registration_scope_versions"."configuration_evidence") BETWEEN 8 AND 1000 AND length("tax_registration_scope_versions"."reason") BETWEEN 8 AND 500),
	CONSTRAINT "tax_registration_scope_destination_check" CHECK (("tax_registration_scope_versions"."destination_city" IS NULL OR length("tax_registration_scope_versions"."destination_city") BETWEEN 1 AND 100) AND ("tax_registration_scope_versions"."location_code" IS NULL OR length("tax_registration_scope_versions"."location_code") BETWEEN 1 AND 40))
);
--> statement-breakpoint
ALTER TABLE "tax_registration_scope_versions" ADD CONSTRAINT "tax_registration_scope_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_registration_scope_versions" ADD CONSTRAINT "tax_registration_scope_registration_fk" FOREIGN KEY ("organization_id","registration_id") REFERENCES "public"."entity_tax_registrations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_registration_scope_org_id_unique" ON "tax_registration_scope_versions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_registration_scope_version_unique" ON "tax_registration_scope_versions" USING btree ("organization_id","registration_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_registration_scope_replay_unique" ON "tax_registration_scope_versions" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
ALTER TABLE tax_registration_scope_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_registration_scope_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_registration_scope_versions USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
CREATE TRIGGER tax_registration_scope_append_only BEFORE UPDATE OR DELETE ON tax_registration_scope_versions FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
--> statement-breakpoint
CREATE FUNCTION app.accounting_correct_tax_registration_scope(
  selected_registration_id uuid, expected_version integer, selected_city text, selected_location text,
  selected_evidence text, selected_reason text, selected_key text, selected_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  admin_context record; registration entity_tax_registrations%ROWTYPE;
  replay tax_registration_scope_versions%ROWTYPE; saved tax_registration_scope_versions%ROWTYPE;
  current_version integer; evidence_count integer;
  city text := nullif(regexp_replace(trim(selected_city),'[[:space:]]+',' ','g'),'');
  location text := nullif(upper(trim(selected_location)),'');
BEGIN
  SELECT * INTO admin_context FROM app.organization_admin_authorize('organization.settings.manage',true);
  IF selected_registration_id IS NULL OR expected_version IS NULL OR expected_version < 1
    OR selected_evidence IS NULL OR length(trim(selected_evidence)) NOT BETWEEN 8 AND 1000
    OR selected_reason IS NULL OR length(trim(selected_reason)) NOT BETWEEN 8 AND 500
    OR selected_key IS NULL OR selected_key !~ '^[a-f0-9]{64}$' OR selected_hash IS NULL OR selected_hash !~ '^[a-f0-9]{64}$'
    OR (city IS NOT NULL AND length(city)>100) OR (location IS NOT NULL AND length(location)>40) THEN
    RAISE EXCEPTION 'TAX_REGISTRATION_SCOPE_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO registration FROM entity_tax_registrations WHERE organization_id=admin_context.organization_id AND id=selected_registration_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM legal_entities WHERE organization_id=admin_context.organization_id AND id=registration.legal_entity_id AND active) THEN
    RAISE EXCEPTION 'TAX_REGISTRATION_UNAVAILABLE' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(admin_context.organization_id::text||'|tax-registration|'||registration.legal_entity_id::text||'|'||registration.regime_key,0));
  SELECT * INTO replay FROM tax_registration_scope_versions WHERE organization_id=admin_context.organization_id AND idempotency_key=selected_key;
  IF FOUND THEN
    IF replay.command_hash IS DISTINCT FROM selected_hash OR replay.registration_id IS DISTINCT FROM selected_registration_id
      OR replay.version IS DISTINCT FROM expected_version+1 OR replay.destination_city IS DISTINCT FROM city
      OR replay.location_code IS DISTINCT FROM location OR replay.configuration_evidence IS DISTINCT FROM trim(selected_evidence)
      OR replay.reason IS DISTINCT FROM trim(selected_reason) THEN
      RAISE EXCEPTION 'TAX_REGISTRATION_SCOPE_REPLAY_CONFLICT' USING ERRCODE='40001';
    END IF;
    RETURN jsonb_build_object('registrationId',replay.registration_id,'scopeVersion',replay.version,'correctionId',replay.id,'preservedPostedEvidenceCount',replay.historical_evidence_count,'idempotentReplay',true);
  END IF;
  SELECT coalesce(max(version),1) INTO current_version FROM tax_registration_scope_versions WHERE organization_id=admin_context.organization_id AND registration_id=registration.id;
  IF expected_version <> current_version THEN RAISE EXCEPTION 'TAX_REGISTRATION_SCOPE_STALE' USING ERRCODE='40001'; END IF;
  IF registration.regime_key='ca.on.hst' AND (registration.destination_country IS DISTINCT FROM 'CA' OR registration.destination_region IS DISTINCT FROM 'ON' OR city IS NOT NULL OR location IS NOT NULL) THEN
    RAISE EXCEPTION 'TAX_REGISTRATION_PROVINCE_SCOPE_REQUIRED' USING ERRCODE='22023';
  END IF;
  IF registration.regime_key='us.wa.sales-use' AND (upper(coalesce(city,''))='SEATTLE') <> (coalesce(location,'')='1726') THEN
    RAISE EXCEPTION 'TAX_REGISTRATION_CITY_SCOPE_REQUIRED' USING ERRCODE='22023';
  END IF;
  SELECT count(*)::integer INTO evidence_count FROM tax_determination_snapshots snapshot
    WHERE snapshot.organization_id=admin_context.organization_id AND snapshot.fact_snapshot->>'registrationId'=registration.id::text
    AND EXISTS (SELECT 1 FROM journal_entries journal WHERE journal.organization_id=snapshot.organization_id AND journal.source_document_id=snapshot.source_document_id AND journal.status='POSTED');
  INSERT INTO tax_registration_scope_versions(organization_id,registration_id,version,destination_city,location_code,configuration_evidence,reason,historical_evidence_count,idempotency_key,command_hash,created_by)
    VALUES(admin_context.organization_id,registration.id,current_version+1,city,location,trim(selected_evidence),trim(selected_reason),evidence_count,selected_key,selected_hash,app.current_actor_id()) RETURNING * INTO saved;
  PERFORM app.append_tenant_business_audit(admin_context.organization_id,'accounting.tax_registration.scope-corrected','entity_tax_registration',registration.id::text,
    jsonb_build_object('scopeVersion',saved.version,'correctionId',saved.id,'destinationCity',city,'locationCode',location,'preservedPostedEvidenceCount',evidence_count,'postedSnapshotsPreserved',true,'commandHash',selected_hash),NULL);
  RETURN jsonb_build_object('registrationId',registration.id,'scopeVersion',saved.version,'correctionId',saved.id,'preservedPostedEvidenceCount',evidence_count,'idempotentReplay',false);
END $$;
REVOKE ALL ON FUNCTION app.accounting_correct_tax_registration_scope(uuid,integer,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON tax_registration_scope_versions FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='business_finlynq_app') THEN
    GRANT SELECT ON tax_registration_scope_versions TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.accounting_correct_tax_registration_scope(uuid,integer,text,text,text,text,text,text) TO business_finlynq_app;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO demo_sandbox_reset_tables(table_name,purge_order)
VALUES ('tax_registration_scope_versions',(SELECT coalesce(max(purge_order),0)+1 FROM demo_sandbox_reset_tables)) ON CONFLICT(table_name) DO NOTHING;
