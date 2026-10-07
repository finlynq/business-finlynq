ALTER TABLE "document_storage_connections" ADD COLUMN "setup_key" text;--> statement-breakpoint
ALTER TABLE "document_storage_connections" ADD COLUMN "setup_hash" text;--> statement-breakpoint
ALTER TABLE "document_storage_connections" ADD COLUMN "reuse_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "document_storage_connections" ADD COLUMN "sharing_consent_ciphertext" text;--> statement-breakpoint
ALTER TABLE "document_storage_connections" ADD CONSTRAINT "document_storage_connections_reuse_connection_id_document_storage_connections_id_fk" FOREIGN KEY ("reuse_connection_id") REFERENCES "public"."document_storage_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_storage_connections_setup_unique" ON "document_storage_connections" USING btree ("organization_id","created_by","setup_key");--> statement-breakpoint
ALTER TABLE "document_storage_connections" ADD CONSTRAINT "document_storage_connections_setup_check" CHECK (("document_storage_connections"."setup_key" IS NULL AND "document_storage_connections"."setup_hash" IS NULL AND "document_storage_connections"."reuse_connection_id" IS NULL AND "document_storage_connections"."sharing_consent_ciphertext" IS NULL) OR ("document_storage_connections"."setup_key" ~ '^[a-f0-9]{64}$' AND "document_storage_connections"."setup_hash" ~ '^[a-f0-9]{64}$'));--> statement-breakpoint
CREATE FUNCTION app.guard_storage_setup_consent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF (NEW.setup_key IS NULL) IS DISTINCT FROM (NEW.setup_hash IS NULL)
    OR (NEW.setup_key IS NULL AND (NEW.reuse_connection_id IS NOT NULL OR NEW.sharing_consent_ciphertext IS NOT NULL)) THEN
    RAISE EXCEPTION 'Incomplete storage setup identity' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND
    (NEW.setup_key,NEW.setup_hash,NEW.reuse_connection_id) IS DISTINCT FROM (OLD.setup_key,OLD.setup_hash,OLD.reuse_connection_id) THEN
    RAISE EXCEPTION 'Storage setup identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.setup_key IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.active OR NEW.sharing_consent_ciphertext IS NOT NULL OR NEW.oauth_state_hash IS NOT NULL
      OR NOT app.current_actor_has_permission(NEW.owner_module||'.manage') THEN
      RAISE EXCEPTION 'Storage setup must begin without sharing or provider authorization' USING ERRCODE='42501';
    END IF;
    IF NEW.reuse_connection_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM document_storage_connections donor WHERE donor.id=NEW.reuse_connection_id
      AND donor.organization_id=NEW.organization_id AND donor.legal_entity_id=NEW.legal_entity_id
      AND donor.created_by=NEW.created_by AND donor.provider='ONEDRIVE' AND NEW.provider='ONEDRIVE'
      AND donor.active AND app.current_actor_has_permission(donor.owner_module||'.manage')
    ) THEN RAISE EXCEPTION 'Storage grant reuse scope is invalid' USING ERRCODE='42501'; END IF;
  ELSE
    IF NEW.label IS DISTINCT FROM OLD.label THEN
      RAISE EXCEPTION 'Prepared storage scope is immutable' USING ERRCODE='55000';
    END IF;
    IF OLD.sharing_consent_ciphertext IS NOT NULL AND NEW.sharing_consent_ciphertext IS DISTINCT FROM OLD.sharing_consent_ciphertext THEN
      RAISE EXCEPTION 'Storage sharing approval evidence is immutable' USING ERRCODE='55000';
    END IF;
    IF NEW.sharing_consent_ciphertext IS DISTINCT FROM OLD.sharing_consent_ciphertext THEN
      IF NEW.created_by IS DISTINCT FROM app.current_actor_id()
        OR current_setting('app.source_surface',true) IS DISTINCT FROM 'UI'
        OR coalesce(current_setting('app.mcp_connection_id',true),'') <> ''
        OR coalesce(current_setting('app.session_id',true),'') = ''
        OR NOT app.current_actor_has_permission(NEW.owner_module||'.manage') THEN
        RAISE EXCEPTION 'The requesting user must approve sharing in a signed-in browser' USING ERRCODE='42501';
      END IF;
      PERFORM app.append_tenant_business_audit(NEW.organization_id,'document-storage.sharing-approved','document_storage_connection',NEW.id::text,
        jsonb_build_object('companyId',NEW.legal_entity_id,'ownerModule',NEW.owner_module,'provider',NEW.provider,'setupHash',NEW.setup_hash,'reuseConnectionId',NEW.reuse_connection_id,'sharedWithAuthorizedModuleMembers',true),NULL);
    END IF;
    IF (NEW.active AND NOT OLD.active) OR (NEW.oauth_state_hash IS DISTINCT FROM OLD.oauth_state_hash AND NEW.oauth_state_hash IS NOT NULL) THEN
      IF NEW.created_by IS DISTINCT FROM app.current_actor_id() OR NOT app.current_actor_has_permission(NEW.owner_module||'.manage') THEN
        RAISE EXCEPTION 'The requesting user must complete this storage setup' USING ERRCODE='42501';
      END IF;
    END IF;
  END IF;
  IF (NEW.active OR NEW.oauth_state_hash IS NOT NULL) AND NEW.sharing_consent_ciphertext IS NULL THEN
    RAISE EXCEPTION 'Storage sharing approval is required before connecting' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_storage_setup_consent() FROM PUBLIC;
CREATE TRIGGER document_storage_connections_setup_guard BEFORE INSERT OR UPDATE ON document_storage_connections FOR EACH ROW EXECUTE FUNCTION app.guard_storage_setup_consent();
