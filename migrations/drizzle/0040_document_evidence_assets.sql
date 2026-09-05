CREATE TABLE "document_evidence_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_module" text NOT NULL,
	"filename_ciphertext" text NOT NULL,
	"content_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"scanner_version" text NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_evidence_assets" ADD CONSTRAINT "document_evidence_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_evidence_assets_org_id_unique" ON "document_evidence_assets" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_evidence_assets_org_idempotency_unique" ON "document_evidence_assets" USING btree ("organization_id","idempotency_key");

--> statement-breakpoint
ALTER TABLE document_evidence_assets
  ADD CONSTRAINT document_evidence_assets_metadata_check CHECK (
    owner_module IN ('receivables','payables')
    AND mime_type IN ('application/pdf','image/png','image/jpeg')
    AND byte_size BETWEEN 1 AND 2097152
    AND key_version > 0 AND sha256 ~ '^[a-f0-9]{64}$'
    AND command_hash ~ '^[a-f0-9]{64}$'
    AND length(scanner_version) BETWEEN 1 AND 200
    AND length(filename_ciphertext) BETWEEN 1 AND 4096
    AND length(content_ciphertext) BETWEEN 1 AND 4000000
  );
ALTER TABLE document_evidence_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_evidence_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_evidence_assets
  USING (organization_id = app.current_organization_id()
    AND (app.current_actor_has_permission(owner_module || '.read')
      OR app.current_actor_has_permission(owner_module || '.manage')))
  WITH CHECK (organization_id = app.current_organization_id()
    AND app.current_actor_has_permission(owner_module || '.manage'));
CREATE TRIGGER document_evidence_assets_append_only BEFORE UPDATE OR DELETE ON document_evidence_assets
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
--> statement-breakpoint
INSERT INTO public.audit_outbox_pair_contract(audit_action, outbox_topic, aggregate_type, contract_version)
VALUES ('document-evidence.uploaded', 'document-evidence.uploaded', 'document_evidence_asset', 'business-audit-outbox-v1');
--> statement-breakpoint
CREATE FUNCTION app.guard_document_evidence_asset()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.uploaded_by IS DISTINCT FROM app.current_actor_id()
    OR NOT app.current_actor_has_permission(NEW.owner_module || '.manage')
    OR NEW.scanned_at < now() - interval '5 minutes' OR NEW.scanned_at > now() + interval '1 minute'
    OR NOT EXISTS (SELECT 1 FROM organization_key_versions
      WHERE organization_id = NEW.organization_id AND version = NEW.key_version AND active)
    OR (EXISTS (SELECT 1 FROM organizations WHERE id = NEW.organization_id AND is_demo)
      AND NOT app.current_demo_session_is_valid()) THEN
    RAISE EXCEPTION 'Evidence upload authorization or metadata is invalid' USING ERRCODE = '42501';
  END IF;
  PERFORM app.append_tenant_business_audit(NEW.organization_id,
    'document-evidence.uploaded', 'document_evidence_asset', NEW.id::text,
    jsonb_build_object('sha256',NEW.sha256,'byteSize',NEW.byte_size,'mimeType',NEW.mime_type,
      'ownerModule',NEW.owner_module,'keyVersion',NEW.key_version,
      'scannerVersion',NEW.scanner_version,'scannedAt',NEW.scanned_at),
    'document-evidence.uploaded');
  RETURN NEW;
END $$;
CREATE TRIGGER document_evidence_assets_guard BEFORE INSERT ON document_evidence_assets
  FOR EACH ROW EXECUTE FUNCTION app.guard_document_evidence_asset();
REVOKE ALL ON FUNCTION app.guard_document_evidence_asset() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.guard_source_document_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  refs jsonb := coalesce(NEW.snapshot->'evidence', '[]'::jsonb);
  prior_refs jsonb := '[]'::jsonb;
  prior_status text;
  ref jsonb;
BEGIN
  IF jsonb_typeof(refs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Evidence references must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(refs) > 20 THEN
    RAISE EXCEPTION 'Too many evidence references' USING ERRCODE = '22023';
  END IF;
  IF NEW.supersedes_source_document_id IS NOT NULL THEN
    SELECT coalesce(snapshot->'evidence','[]'::jsonb), status INTO prior_refs, prior_status
      FROM source_documents WHERE organization_id = NEW.organization_id AND id = NEW.supersedes_source_document_id;
    IF (NEW.status <> 'DRAFT' OR prior_status <> 'DRAFT') AND refs IS DISTINCT FROM prior_refs THEN
      RAISE EXCEPTION 'Posted evidence lineage is immutable' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.status <> 'DRAFT' AND refs <> '[]'::jsonb THEN
    RAISE EXCEPTION 'Evidence must originate from a draft' USING ERRCODE = '42501';
  END IF;
  IF jsonb_array_length(refs) <> (SELECT count(DISTINCT value->>'assetId') FROM jsonb_array_elements(refs)) THEN
    RAISE EXCEPTION 'Duplicate evidence reference' USING ERRCODE = '22023';
  END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
    IF NEW.source_type NOT IN ('receivables.sales-invoice','payables.supplier-bill')
      OR jsonb_typeof(ref) IS DISTINCT FROM 'object'
      OR ref - 'assetId' - 'purpose' <> '{}'::jsonb
      OR coalesce(ref->>'purpose','') NOT IN ('INVOICE','RECEIPT','SUPPORTING')
      OR NOT EXISTS (SELECT 1 FROM document_evidence_assets
        WHERE organization_id = NEW.organization_id AND owner_module = NEW.owner_module
          AND id::text = ref->>'assetId') THEN
      RAISE EXCEPTION 'Evidence reference is unavailable for this document' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER source_documents_evidence_guard BEFORE INSERT ON source_documents
  FOR EACH ROW EXECUTE FUNCTION app.guard_source_document_evidence();
REVOKE ALL ON FUNCTION app.guard_source_document_evidence() FROM PUBLIC;
REVOKE ALL ON document_evidence_assets FROM PUBLIC;
--> statement-breakpoint
INSERT INTO demo_sandbox_reset_tables(table_name, purge_order)
SELECT 'document_evidence_assets', max(purge_order) + 1 FROM demo_sandbox_reset_tables;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT SELECT, INSERT ON document_evidence_assets TO business_finlynq_app;
    REVOKE UPDATE, DELETE ON document_evidence_assets FROM business_finlynq_app;
  END IF;
END $$;
