CREATE TABLE "journal_evidence_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"evidence_asset_id" uuid NOT NULL,
	"source_inbox_item_id" uuid,
	"evidence_revision" integer NOT NULL,
	"journal_content_hash" text NOT NULL,
	"document_date" date NOT NULL,
	"document_reference" text NOT NULL,
	"document_currency" text NOT NULL,
	"document_total" numeric(38, 9) NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_evidence_links" ADD CONSTRAINT "journal_evidence_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_evidence_links" ADD CONSTRAINT "journal_evidence_links_org_journal_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_evidence_links" ADD CONSTRAINT "journal_evidence_links_org_asset_fk" FOREIGN KEY ("organization_id","evidence_asset_id") REFERENCES "public"."document_evidence_assets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_evidence_links" ADD CONSTRAINT "journal_evidence_links_org_inbox_fk" FOREIGN KEY ("organization_id","source_inbox_item_id") REFERENCES "public"."document_inbox_items"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_evidence_links_org_id_unique" ON "journal_evidence_links" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_evidence_links_org_journal_asset_unique" ON "journal_evidence_links" USING btree ("organization_id","journal_entry_id","evidence_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_evidence_links_org_journal_revision_unique" ON "journal_evidence_links" USING btree ("organization_id","journal_entry_id","evidence_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_evidence_links_org_idempotency_journal_unique" ON "journal_evidence_links" USING btree ("organization_id","idempotency_key","journal_entry_id");
--> statement-breakpoint
ALTER TABLE journal_evidence_links ADD CONSTRAINT journal_evidence_links_metadata_check CHECK (
  evidence_revision > 0
  AND journal_content_hash ~ '^[a-f0-9]{64}$'
  AND length(btrim(document_reference)) BETWEEN 1 AND 100
  AND document_currency ~ '^[A-Z]{3}$'
  AND length(btrim(reason)) BETWEEN 8 AND 500
  AND length(idempotency_key) BETWEEN 1 AND 200
  AND command_hash ~ '^[a-f0-9]{64}$'
);
ALTER TABLE journal_evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_evidence_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_evidence_links
  USING (organization_id = app.current_organization_id()
    AND app.current_actor_has_permission('mcp.ledger.read')
    AND EXISTS (SELECT 1 FROM document_evidence_assets asset
      WHERE asset.organization_id = journal_evidence_links.organization_id
        AND asset.id = journal_evidence_links.evidence_asset_id
        AND (app.current_actor_has_permission(asset.owner_module || '.read')
          OR app.current_actor_has_permission(asset.owner_module || '.manage'))))
  WITH CHECK (organization_id = app.current_organization_id()
    AND app.current_actor_has_permission('ledger.journal.draft')
    AND EXISTS (SELECT 1 FROM document_evidence_assets asset
      WHERE asset.organization_id = journal_evidence_links.organization_id
        AND asset.id = journal_evidence_links.evidence_asset_id
        AND app.current_actor_has_permission(asset.owner_module || '.manage')));
CREATE TRIGGER journal_evidence_links_append_only BEFORE UPDATE OR DELETE ON journal_evidence_links
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
--> statement-breakpoint
INSERT INTO public.audit_outbox_pair_contract(audit_action,outbox_topic,aggregate_type,contract_version)
VALUES ('journal-evidence.linked','journal-evidence.linked','journal_evidence_link','business-audit-outbox-v1');
--> statement-breakpoint
CREATE FUNCTION app.guard_journal_evidence_link()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  selected_journal journal_entries%ROWTYPE;
  selected_asset document_evidence_assets%ROWTYPE;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.created_by IS DISTINCT FROM app.current_actor_id()
    OR NOT app.current_actor_has_permission('mcp.ledger.read')
    OR NOT app.current_actor_has_permission('ledger.journal.draft') THEN
    RAISE EXCEPTION 'Journal evidence permission is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_journal FROM journal_entries
    WHERE organization_id = NEW.organization_id AND id = NEW.journal_entry_id;
  SELECT * INTO selected_asset FROM document_evidence_assets
    WHERE organization_id = NEW.organization_id AND id = NEW.evidence_asset_id;
  IF selected_journal.id IS NULL OR selected_journal.status <> 'POSTED'
    OR selected_journal.content_hash IS DISTINCT FROM NEW.journal_content_hash
    OR selected_asset.id IS NULL
    OR NOT app.current_actor_has_permission(selected_asset.owner_module || '.manage') THEN
    RAISE EXCEPTION 'Journal evidence target or asset is unavailable' USING ERRCODE = '42501';
  END IF;
  IF selected_asset.storage_backend = 'CLOUD' THEN
    IF NEW.source_inbox_item_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM document_inbox_items item
      JOIN document_storage_connections connection
        ON connection.organization_id = item.organization_id
       AND connection.id = item.connection_id
      WHERE item.organization_id = NEW.organization_id
        AND item.id = NEW.source_inbox_item_id
        AND item.connection_id = selected_asset.storage_connection_id
        AND item.provider_file_id = selected_asset.provider_file_id
        AND item.owner_module = selected_asset.owner_module
        AND connection.legal_entity_id = selected_journal.legal_entity_id
        AND ((item.asset_id = selected_asset.id AND item.status IN ('READY_TO_FILE','FILED','FILING_FAILED'))
          OR (item.asset_id IS NULL AND item.status = 'CLAIMED'
            AND item.claimed_by = NEW.created_by))
    ) THEN
      RAISE EXCEPTION 'Cloud evidence source or company is unavailable' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.source_inbox_item_id IS NOT NULL THEN
    RAISE EXCEPTION 'Database evidence cannot claim an inbox source' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_evidence_links prior
    JOIN journal_entries prior_journal
      ON prior_journal.organization_id = prior.organization_id
     AND prior_journal.id = prior.journal_entry_id
    WHERE prior.organization_id = NEW.organization_id
      AND prior.evidence_asset_id = NEW.evidence_asset_id
      AND (prior_journal.legal_entity_id <> selected_journal.legal_entity_id
        OR prior_journal.ledger_id <> selected_journal.ledger_id)
  ) THEN
    RAISE EXCEPTION 'An original document cannot cross companies or ledgers' USING ERRCODE = '23514';
  END IF;
  IF NEW.evidence_revision IS DISTINCT FROM (
    SELECT count(*)::integer + 1 FROM journal_evidence_links prior
    WHERE prior.organization_id = NEW.organization_id
      AND prior.journal_entry_id = NEW.journal_entry_id
  ) THEN
    RAISE EXCEPTION 'Journal evidence revision changed; refresh the target' USING ERRCODE = '40001';
  END IF;
  PERFORM app.append_tenant_business_audit(NEW.organization_id,
    'journal-evidence.linked','journal_evidence_link',NEW.id::text,
    jsonb_build_object('journalId',NEW.journal_entry_id,'assetId',NEW.evidence_asset_id,
      'sourceInboxItemId',NEW.source_inbox_item_id,
      'assetSha256',selected_asset.sha256,'revision',NEW.evidence_revision,
      'documentDate',NEW.document_date,'documentReference',NEW.document_reference,
      'documentCurrency',NEW.document_currency,'documentTotal',NEW.document_total,
      'reason',NEW.reason),
    'journal-evidence.linked');
  RETURN NEW;
END $$;
CREATE TRIGGER journal_evidence_links_guard BEFORE INSERT ON journal_evidence_links
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_evidence_link();
REVOKE ALL ON FUNCTION app.guard_journal_evidence_link() FROM PUBLIC;
REVOKE ALL ON journal_evidence_links FROM PUBLIC;
--> statement-breakpoint
INSERT INTO demo_sandbox_reset_tables(table_name,purge_order)
SELECT 'journal_evidence_links', max(purge_order) + 1 FROM demo_sandbox_reset_tables;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT SELECT, INSERT ON journal_evidence_links TO business_finlynq_app;
    REVOKE UPDATE, DELETE ON journal_evidence_links FROM business_finlynq_app;
  END IF;
END $$;
