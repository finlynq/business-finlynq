CREATE TABLE "document_inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"owner_module" text NOT NULL,
	"provider_file_id" text NOT NULL,
	"content_version" text NOT NULL,
	"metadata_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"claim_id" uuid,
	"claimed_by" uuid,
	"claimed_session_id" uuid,
	"lease_until" timestamp with time zone,
	"asset_id" uuid,
	"source_document_id" uuid,
	"completion_hash" text,
	"processing_ciphertext" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_storage_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"owner_module" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"config_ciphertext" text,
	"credentials_ciphertext" text,
	"key_version" integer NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_cursor" text
);
--> statement-breakpoint
CREATE TABLE "document_storage_oauth" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"verifier_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "document_evidence_assets" ALTER COLUMN "content_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "document_evidence_assets" ADD COLUMN "storage_backend" text DEFAULT 'DATABASE' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_evidence_assets" ADD COLUMN "storage_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "document_evidence_assets" ADD COLUMN "provider_file_id" text;--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD CONSTRAINT "document_inbox_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_storage_connections" ADD CONSTRAINT "document_storage_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_storage_oauth" ADD CONSTRAINT "document_storage_oauth_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_inbox_items_org_id_unique" ON "document_inbox_items" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_inbox_items_file_unique" ON "document_inbox_items" USING btree ("organization_id","connection_id","provider_file_id");--> statement-breakpoint
CREATE INDEX "document_inbox_items_status_idx" ON "document_inbox_items" USING btree ("organization_id","status","id");--> statement-breakpoint
CREATE INDEX "document_inbox_items_checksum_idx" ON "document_inbox_items" USING btree ("organization_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "document_storage_connections_org_id_unique" ON "document_storage_connections" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_storage_oauth_state_unique" ON "document_storage_oauth" USING btree ("state_hash");
--> statement-breakpoint
ALTER TABLE document_storage_connections
  ADD CONSTRAINT document_storage_connections_entity_fk FOREIGN KEY (organization_id, legal_entity_id) REFERENCES legal_entities(organization_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT document_storage_connections_valid CHECK (owner_module IN ('payables','receivables') AND provider IN ('GOOGLE_DRIVE','ONEDRIVE') AND key_version > 0 AND length(label) BETWEEN 1 AND 100 AND (NOT active OR (config_ciphertext IS NOT NULL AND credentials_ciphertext IS NOT NULL)));
ALTER TABLE document_storage_oauth
  ADD CONSTRAINT document_storage_oauth_connection_fk FOREIGN KEY (organization_id,connection_id) REFERENCES document_storage_connections(organization_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT document_storage_oauth_valid CHECK (state_hash ~ '^[a-f0-9]{64}$' AND key_version > 0);
ALTER TABLE document_inbox_items
  ADD CONSTRAINT document_inbox_items_connection_fk FOREIGN KEY (organization_id,connection_id) REFERENCES document_storage_connections(organization_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT document_inbox_items_asset_fk FOREIGN KEY (organization_id,asset_id) REFERENCES document_evidence_assets(organization_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT document_inbox_items_source_fk FOREIGN KEY (organization_id,source_document_id) REFERENCES source_documents(organization_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT document_inbox_items_valid CHECK (owner_module IN ('payables','receivables') AND key_version > 0 AND byte_size >= 0
    AND status IN ('PENDING','CLAIMED','NEEDS_REVIEW','READY_TO_FILE','FILED','FILING_FAILED')
    AND (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$')
    AND (status <> 'CLAIMED' OR (claim_id IS NOT NULL AND claimed_by IS NOT NULL AND claimed_session_id IS NOT NULL AND lease_until IS NOT NULL))
    AND (status NOT IN ('READY_TO_FILE','FILED','FILING_FAILED') OR (asset_id IS NOT NULL AND completion_hash IS NOT NULL AND processing_ciphertext IS NOT NULL)));
ALTER TABLE document_evidence_assets
  ADD CONSTRAINT document_evidence_assets_connection_fk FOREIGN KEY (organization_id,storage_connection_id) REFERENCES document_storage_connections(organization_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT document_evidence_assets_backend_check CHECK (
    (storage_backend = 'DATABASE' AND content_ciphertext IS NOT NULL AND storage_connection_id IS NULL AND provider_file_id IS NULL)
    OR (storage_backend = 'CLOUD' AND content_ciphertext IS NULL AND storage_connection_id IS NOT NULL AND length(provider_file_id) BETWEEN 1 AND 512));
--> statement-breakpoint
ALTER TABLE document_storage_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_storage_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_storage_connections
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission(owner_module||'.read') OR app.current_actor_has_permission(owner_module||'.manage') OR app.current_actor_has_permission('organization.settings.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND (app.current_actor_has_permission(owner_module||'.read') OR app.current_actor_has_permission(owner_module||'.manage') OR app.current_actor_has_permission('organization.settings.manage')));
ALTER TABLE document_storage_oauth ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_storage_oauth FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_storage_oauth
  USING (organization_id=app.current_organization_id() AND actor_id=app.current_actor_id() AND session_id=nullif(current_setting('app.session_id',true),'')::uuid AND app.current_actor_has_permission('organization.settings.manage'))
  WITH CHECK (organization_id=app.current_organization_id() AND actor_id=app.current_actor_id() AND session_id=nullif(current_setting('app.session_id',true),'')::uuid AND app.current_actor_has_permission('organization.settings.manage'));
ALTER TABLE document_inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_inbox_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_inbox_items
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission(owner_module||'.read') OR app.current_actor_has_permission(owner_module||'.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_has_permission(owner_module||'.manage'));
--> statement-breakpoint
INSERT INTO audit_outbox_pair_contract(audit_action,outbox_topic,aggregate_type,contract_version)
SELECT action,action,'document_storage_connection','business-audit-outbox-v1' FROM unnest(ARRAY[
  'document-storage.created','document-storage.authorization-started','document-storage.connected',
  'document-storage.disconnected','document-storage.refreshed','document-storage.synced','document-storage.changed']) action;
INSERT INTO audit_outbox_pair_contract(audit_action,outbox_topic,aggregate_type,contract_version)
SELECT action,action,'document_inbox_item','business-audit-outbox-v1' FROM unnest(ARRAY[
  'document-inbox.discovered','document-inbox.uploaded','document-inbox.claimed','document-inbox.pending',
  'document-inbox.needs_review','document-inbox.ready_to_file','document-inbox.filed','document-inbox.filing_failed','document-inbox.changed']) action;
CREATE FUNCTION app.guard_document_storage_connection() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admin boolean := app.current_actor_has_permission('organization.settings.manage'); refresh_only boolean := false; audit_action text;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW.organization_id AND active AND NOT is_demo AND organization_mode='REAL') THEN
    RAISE EXCEPTION 'Cloud storage requires an active real organization' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.organization_id,NEW.legal_entity_id,NEW.owner_module,NEW.provider,NEW.created_by) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.legal_entity_id,OLD.owner_module,OLD.provider,OLD.created_by) THEN
      RAISE EXCEPTION 'Storage connection identity is immutable' USING ERRCODE='42501';
    END IF;
    refresh_only := (to_jsonb(NEW)-'credentials_ciphertext') IS NOT DISTINCT FROM (to_jsonb(OLD)-'credentials_ciphertext');
    IF NOT admin AND NOT refresh_only AND (to_jsonb(NEW)-'sync_cursor'-'last_synced_at'-'credentials_ciphertext') IS DISTINCT FROM (to_jsonb(OLD)-'sync_cursor'-'last_synced_at'-'credentials_ciphertext') THEN
      RAISE EXCEPTION 'Storage settings require organization administration' USING ERRCODE='42501';
    END IF;
  ELSIF NOT admin OR NEW.created_by IS DISTINCT FROM app.current_actor_id() THEN
    RAISE EXCEPTION 'Storage setup requires organization administration' USING ERRCODE='42501';
  END IF;
  IF NOT refresh_only AND NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW.organization_id AND writes_enabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Organization writes are disabled' USING ERRCODE='42501';
  END IF;
  IF NOT admin AND NOT app.current_actor_has_permission(NEW.owner_module || CASE WHEN refresh_only THEN '.read' ELSE '.manage' END) AND NOT (refresh_only AND app.current_actor_has_permission(NEW.owner_module||'.manage')) THEN
    RAISE EXCEPTION 'Storage operation is not authorized' USING ERRCODE='42501';
  END IF;
  audit_action := 'document-storage.' || CASE
    WHEN TG_OP='INSERT' THEN 'created'
    WHEN NEW.active IS DISTINCT FROM OLD.active THEN CASE WHEN NEW.active THEN 'connected' ELSE 'disconnected' END
    WHEN (to_jsonb(NEW)->>'oauth_state_hash') IS DISTINCT FROM (to_jsonb(OLD)->>'oauth_state_hash') THEN
      CASE WHEN (to_jsonb(NEW)->>'oauth_state_hash') IS NULL THEN CASE WHEN NEW.active THEN 'connected' ELSE 'disconnected' END ELSE 'authorization-started' END
    WHEN refresh_only THEN 'refreshed'
    WHEN (NEW.sync_cursor,NEW.last_synced_at) IS DISTINCT FROM (OLD.sync_cursor,OLD.last_synced_at) THEN 'synced'
    ELSE 'changed' END;
  PERFORM app.append_tenant_business_audit(NEW.organization_id,audit_action,'document_storage_connection',NEW.id::text,
    jsonb_build_object('provider',NEW.provider,'active',NEW.active,'ownerModule',NEW.owner_module),audit_action);
  RETURN NEW;
END $$;
CREATE TRIGGER document_storage_connections_guard BEFORE INSERT OR UPDATE ON document_storage_connections FOR EACH ROW EXECUTE FUNCTION app.guard_document_storage_connection();
CREATE TRIGGER document_storage_connections_no_delete BEFORE DELETE ON document_storage_connections FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE FUNCTION app.guard_document_inbox_item() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE audit_action text;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NOT app.current_actor_has_permission(NEW.owner_module||'.manage')
    OR NOT EXISTS (SELECT 1 FROM document_storage_connections c JOIN organizations o ON o.id=c.organization_id
      WHERE c.organization_id=NEW.organization_id AND c.id=NEW.connection_id AND c.owner_module=NEW.owner_module AND c.active
        AND o.active AND NOT o.is_demo AND o.organization_mode='REAL' AND o.writes_enabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Inbox operation is not authorized' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.id,NEW.organization_id,NEW.connection_id,NEW.owner_module,NEW.provider_file_id) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.connection_id,OLD.owner_module,OLD.provider_file_id) THEN
    RAISE EXCEPTION 'Inbox identity is immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND OLD.completion_hash IS NOT NULL AND (NEW.asset_id,NEW.source_document_id,NEW.completion_hash,NEW.sha256) IS DISTINCT FROM (OLD.asset_id,OLD.source_document_id,OLD.completion_hash,OLD.sha256) THEN
    RAISE EXCEPTION 'Completed inbox association is immutable' USING ERRCODE='42501';
  END IF;
  NEW.updated_at := now();
  audit_action := 'document-inbox.' || CASE
    WHEN TG_OP='INSERT' THEN 'discovered'
    WHEN NEW.status IS DISTINCT FROM OLD.status OR NEW.status='CLAIMED' THEN lower(NEW.status)
    WHEN (to_jsonb(NEW)->>'upload_key') IS DISTINCT FROM (to_jsonb(OLD)->>'upload_key') THEN 'uploaded'
    ELSE 'changed' END;
  PERFORM app.append_tenant_business_audit(NEW.organization_id,audit_action,'document_inbox_item',NEW.id::text,
    jsonb_build_object('status',NEW.status,'assetId',NEW.asset_id,'sourceDocumentId',NEW.source_document_id),audit_action);
  RETURN NEW;
END $$;
CREATE TRIGGER document_inbox_items_guard BEFORE INSERT OR UPDATE ON document_inbox_items FOR EACH ROW EXECUTE FUNCTION app.guard_document_inbox_item();
CREATE TRIGGER document_inbox_items_no_delete BEFORE DELETE ON document_inbox_items FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
REVOKE ALL ON FUNCTION app.guard_document_storage_connection(), app.guard_document_inbox_item() FROM PUBLIC;
REVOKE ALL ON document_storage_connections,document_storage_oauth,document_inbox_items FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='business_finlynq_app') THEN
    GRANT SELECT,INSERT,UPDATE ON document_storage_connections,document_storage_oauth,document_inbox_items TO business_finlynq_app;
    REVOKE DELETE ON document_storage_connections,document_storage_oauth,document_inbox_items FROM business_finlynq_app;
  END IF;
END $$;
