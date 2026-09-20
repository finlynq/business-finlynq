CREATE TABLE "document_inbox_processing_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inbox_item_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	"correlation_id" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_inbox_processing_attempts_outcome_check" CHECK ("document_inbox_processing_attempts"."outcome" IN ('SUCCEEDED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "asset_tax_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"regime_key" text NOT NULL,
	"class_key" text NOT NULL,
	"pool_key" text NOT NULL,
	"prescribed_rate" numeric(12, 9) NOT NULL,
	"available_for_use_on" date NOT NULL,
	"business_use_percent" numeric(7, 4) NOT NULL,
	"tax_capital_cost" numeric(38, 9) NOT NULL,
	"assistance" numeric(38, 9) DEFAULT '0' NOT NULL,
	"rule_key" text NOT NULL,
	"rule_version" text NOT NULL,
	"authority_status" text NOT NULL,
	"source_uri" text NOT NULL,
	"version" integer NOT NULL,
	"supersedes_classification_id" uuid,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_tax_classifications_rate_check" CHECK (prescribed_rate > 0 AND prescribed_rate <= 1),
	CONSTRAINT "asset_tax_classifications_use_check" CHECK (business_use_percent > 0 AND business_use_percent <= 100),
	CONSTRAINT "asset_tax_classifications_amount_check" CHECK (tax_capital_cost > 0 AND assistance >= 0 AND assistance <= tax_capital_cost),
	CONSTRAINT "asset_tax_classifications_authority_check" CHECK (authority_status IN ('ENACTED', 'PROPOSED')),
	CONSTRAINT "asset_tax_classifications_hash_check" CHECK (command_hash ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "asset_tax_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"classification_id" uuid NOT NULL,
	"tax_year_start" integer NOT NULL,
	"tax_year_end" integer NOT NULL,
	"schedule_snapshot" jsonb NOT NULL,
	"maximum_cca" numeric(38, 9) NOT NULL,
	"claimed_cca" numeric(38, 9) NOT NULL,
	"closing_ucc" numeric(38, 9) NOT NULL,
	"version" integer NOT NULL,
	"supersedes_schedule_id" uuid,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_tax_schedules_year_check" CHECK (tax_year_start BETWEEN 1900 AND 2500 AND tax_year_end BETWEEN tax_year_start AND 2500),
	CONSTRAINT "asset_tax_schedules_amount_check" CHECK (maximum_cca >= 0 AND claimed_cca >= 0 AND claimed_cca <= maximum_cca AND closing_ucc >= 0),
	CONSTRAINT "asset_tax_schedules_snapshot_check" CHECK (jsonb_typeof(schedule_snapshot) = 'array'),
	CONSTRAINT "asset_tax_schedules_hash_check" CHECK (command_hash ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "bank_account_cutovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reconciliation_session_id" uuid NOT NULL,
	"predecessor_account_combination_id" uuid NOT NULL,
	"successor_account_combination_id" uuid NOT NULL,
	"effective_on" date NOT NULL,
	"migration_journal_line_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proof_snapshot" jsonb NOT NULL,
	"confirmation_hash" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_account_cutovers_hash_check" CHECK (confirmation_hash ~ '^[a-f0-9]{64}$' AND command_hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "bank_account_cutovers_reason_check" CHECK (char_length(btrim(reason)) BETWEEN 8 AND 500),
	CONSTRAINT "bank_account_cutovers_lines_check" CHECK (jsonb_typeof(migration_journal_line_ids) = 'array')
);
--> statement-breakpoint
CREATE TABLE "bank_accounting_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"observation_version_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"proposal_snapshot" jsonb NOT NULL,
	"proposal_hash" text NOT NULL,
	"supersedes_proposal_id" uuid,
	"journal_entry_id" uuid,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounting_proposals_version_check" CHECK (version > 0),
	CONSTRAINT "bank_accounting_proposals_status_check" CHECK (status IN ('PREPARED', 'REVIEWED', 'REJECTED', 'COMMITTED')),
	CONSTRAINT "bank_accounting_proposals_snapshot_check" CHECK (jsonb_typeof(proposal_snapshot) = 'object'),
	CONSTRAINT "bank_accounting_proposals_hash_check" CHECK (proposal_hash ~ '^[a-f0-9]{64}$' AND command_hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "bank_accounting_proposals_reason_check" CHECK (char_length(btrim(reason)) BETWEEN 8 AND 500)
);
--> statement-breakpoint
CREATE TABLE "tax_filing_asset_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"filing_id" uuid NOT NULL,
	"asset_tax_schedule_id" uuid NOT NULL,
	"adjustment_snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_filing_asset_adjustments_snapshot_check" CHECK (jsonb_typeof("tax_filing_asset_adjustments"."adjustment_snapshot") = 'object'),
	CONSTRAINT "tax_filing_asset_adjustments_reason_check" CHECK (char_length(btrim("tax_filing_asset_adjustments"."reason")) BETWEEN 8 AND 500),
	CONSTRAINT "tax_filing_asset_adjustments_hash_check" CHECK ("tax_filing_asset_adjustments"."command_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
DROP INDEX "asset_categories_scope_code_unique";--> statement-breakpoint
-- These two legacy-table guards reject UPDATE by design. Disable only the
-- named guards while owner-run migration code establishes deterministic
-- lineage for existing rows; transactional migration failure restores them.
ALTER TABLE "asset_categories" DISABLE TRIGGER "asset_categories_write_guard";--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" DISABLE TRIGGER "tax_account_mapping_sets_permission_guard";--> statement-breakpoint
ALTER TABLE "asset_categories" ADD COLUMN "category_key" uuid;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD COLUMN "supersedes_category_id" uuid;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD COLUMN "effective_from" date;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD COLUMN "command_hash" text;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD COLUMN "state" text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD COLUMN "effective_from" date;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD COLUMN "effective_to" date;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD COLUMN "supersedes_mapping_set_id" uuid;--> statement-breakpoint
UPDATE asset_categories
SET category_key = id,
    effective_from = DATE '1900-01-01' + greatest(version - 1, 0),
    reason = 'Legacy category lineage backfill',
    idempotency_key = 'legacy-asset-category:' || id::text,
    command_hash = encode(digest('legacy-asset-category:' || id::text, 'sha256'), 'hex');--> statement-breakpoint
WITH mapping_lineage AS (
  SELECT id,
    lag(id) OVER (
      PARTITION BY organization_id, ledger_id, template_id
      ORDER BY version, id
    ) AS predecessor_id
  FROM tax_account_mapping_sets
)
UPDATE tax_account_mapping_sets mapping
SET effective_from = DATE '1900-01-01' + greatest(mapping.version - 1, 0),
    supersedes_mapping_set_id = mapping_lineage.predecessor_id
FROM mapping_lineage
WHERE mapping_lineage.id = mapping.id;--> statement-breakpoint
ALTER TABLE "asset_categories" ALTER COLUMN "category_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_categories" ALTER COLUMN "effective_from" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_categories" ALTER COLUMN "reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_categories" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_categories" ALTER COLUMN "command_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ALTER COLUMN "effective_from" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_categories" ENABLE TRIGGER "asset_categories_write_guard";--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ENABLE TRIGGER "tax_account_mapping_sets_permission_guard";--> statement-breakpoint
ALTER TABLE "document_inbox_processing_attempts" ADD CONSTRAINT "document_inbox_processing_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_inbox_processing_attempts" ADD CONSTRAINT "document_inbox_processing_attempts_org_item_fk" FOREIGN KEY ("organization_id","inbox_item_id") REFERENCES "public"."document_inbox_items"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tax_classifications" ADD CONSTRAINT "asset_tax_classifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tax_classifications" ADD CONSTRAINT "asset_tax_classifications_org_asset_fk" FOREIGN KEY ("organization_id","asset_id") REFERENCES "public"."asset_register"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_tax_classifications_org_id_unique" ON "asset_tax_classifications" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "asset_tax_schedules" ADD CONSTRAINT "asset_tax_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tax_schedules" ADD CONSTRAINT "asset_tax_schedules_org_asset_fk" FOREIGN KEY ("organization_id","asset_id") REFERENCES "public"."asset_register"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tax_schedules" ADD CONSTRAINT "asset_tax_schedules_org_classification_fk" FOREIGN KEY ("organization_id","classification_id") REFERENCES "public"."asset_tax_classifications"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_tax_schedules_org_id_unique" ON "asset_tax_schedules" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "bank_account_cutovers" ADD CONSTRAINT "bank_account_cutovers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_account_cutovers" ADD CONSTRAINT "bank_account_cutovers_org_reconciliation_fk" FOREIGN KEY ("organization_id","reconciliation_session_id") REFERENCES "public"."bank_reconciliation_sessions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_account_cutovers" ADD CONSTRAINT "bank_account_cutovers_org_predecessor_fk" FOREIGN KEY ("organization_id","predecessor_account_combination_id") REFERENCES "public"."account_combinations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_account_cutovers" ADD CONSTRAINT "bank_account_cutovers_org_successor_fk" FOREIGN KEY ("organization_id","successor_account_combination_id") REFERENCES "public"."account_combinations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounting_proposals" ADD CONSTRAINT "bank_accounting_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounting_proposals" ADD CONSTRAINT "bank_accounting_proposals_org_observation_fk" FOREIGN KEY ("organization_id","observation_version_id") REFERENCES "public"."bank_observation_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounting_proposals" ADD CONSTRAINT "bank_accounting_proposals_org_journal_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_asset_adjustments" ADD CONSTRAINT "tax_filing_asset_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_asset_adjustments" ADD CONSTRAINT "tax_filing_asset_adjustments_org_filing_fk" FOREIGN KEY ("organization_id","filing_id") REFERENCES "public"."tax_filings"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_asset_adjustments" ADD CONSTRAINT "tax_filing_asset_adjustments_org_schedule_fk" FOREIGN KEY ("organization_id","asset_tax_schedule_id") REFERENCES "public"."asset_tax_schedules"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_inbox_processing_attempts_org_id_unique" ON "document_inbox_processing_attempts" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "document_inbox_processing_attempts_item_created_idx" ON "document_inbox_processing_attempts" USING btree ("organization_id","inbox_item_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "asset_tax_classifications_asset_version_unique" ON "asset_tax_classifications" USING btree ("asset_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_tax_classifications_org_idempotency_unique" ON "asset_tax_classifications" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "asset_tax_classifications_org_asset_idx" ON "asset_tax_classifications" USING btree ("organization_id","asset_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_tax_schedules_scope_version_unique" ON "asset_tax_schedules" USING btree ("asset_id","classification_id","tax_year_start","tax_year_end","version");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_tax_schedules_org_idempotency_unique" ON "asset_tax_schedules" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "asset_tax_schedules_org_asset_idx" ON "asset_tax_schedules" USING btree ("organization_id","asset_id","tax_year_end");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_account_cutovers_org_id_unique" ON "bank_account_cutovers" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_account_cutovers_reconciliation_unique" ON "bank_account_cutovers" USING btree ("reconciliation_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_account_cutovers_org_idempotency_unique" ON "bank_account_cutovers" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounting_proposals_org_id_unique" ON "bank_accounting_proposals" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounting_proposals_observation_version_unique" ON "bank_accounting_proposals" USING btree ("observation_version_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounting_proposals_org_idempotency_unique" ON "bank_accounting_proposals" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bank_accounting_proposals_org_status_idx" ON "bank_accounting_proposals" USING btree ("organization_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_asset_adjustments_org_id_unique" ON "tax_filing_asset_adjustments" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_asset_adjustments_filing_schedule_unique" ON "tax_filing_asset_adjustments" USING btree ("filing_id","asset_tax_schedule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_asset_adjustments_org_idempotency_unique" ON "tax_filing_asset_adjustments" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD CONSTRAINT "tax_account_mapping_sets_org_supersedes_fk" FOREIGN KEY ("organization_id","supersedes_mapping_set_id") REFERENCES "public"."tax_account_mapping_sets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_categories_scope_version_unique" ON "asset_categories" USING btree ("organization_id","ledger_id","code","version");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_categories_org_idempotency_unique" ON "asset_categories" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_categories_key_version_unique" ON "asset_categories" USING btree ("organization_id","category_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_account_mapping_sets_org_supersedes_unique" ON "tax_account_mapping_sets" USING btree ("organization_id","supersedes_mapping_set_id");--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_version_check" CHECK (version > 0);--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_reason_check" CHECK (char_length(btrim(reason)) BETWEEN 8 AND 500);--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_command_hash_check" CHECK (command_hash ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD CONSTRAINT "tax_account_mapping_sets_state_check" CHECK ("tax_account_mapping_sets"."state" IN ('ACTIVE', 'INACTIVE'));--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD CONSTRAINT "tax_account_mapping_sets_effective_check" CHECK ("tax_account_mapping_sets"."effective_to" IS NULL OR "tax_account_mapping_sets"."effective_to" >= "tax_account_mapping_sets"."effective_from");
--> statement-breakpoint

-- Every new workflow record is tenant-owned. Processing-attempt visibility
-- also follows the owning inbox module's existing read/manage permissions.
ALTER TABLE document_inbox_processing_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_inbox_processing_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_inbox_processing_attempts
  USING (
    organization_id = app.current_organization_id()
    AND EXISTS (
      SELECT 1 FROM document_inbox_items item
      WHERE item.organization_id = document_inbox_processing_attempts.organization_id
        AND item.id = document_inbox_processing_attempts.inbox_item_id
        AND (app.current_actor_has_permission(item.owner_module || '.read')
          OR app.current_actor_has_permission(item.owner_module || '.manage'))
    )
  )
  WITH CHECK (
    organization_id = app.current_organization_id()
    AND EXISTS (
      SELECT 1 FROM document_inbox_items item
      WHERE item.organization_id = document_inbox_processing_attempts.organization_id
        AND item.id = document_inbox_processing_attempts.inbox_item_id
        AND app.current_actor_has_permission(item.owner_module || '.manage')
    )
  );

ALTER TABLE asset_tax_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_tax_classifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_tax_classifications
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
ALTER TABLE asset_tax_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_tax_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_tax_schedules
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
ALTER TABLE bank_account_cutovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_account_cutovers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_account_cutovers
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
ALTER TABLE bank_accounting_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounting_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_accounting_proposals
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
ALTER TABLE tax_filing_asset_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_filing_asset_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_filing_asset_adjustments
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

CREATE FUNCTION app.guard_coordinated_workflow_append()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  required_permission text;
  inbox_owner_module text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;

  required_permission := CASE TG_TABLE_NAME
    WHEN 'asset_tax_classifications' THEN 'tax.mappings.manage'
    WHEN 'asset_tax_schedules' THEN 'tax.mappings.manage'
    WHEN 'tax_filing_asset_adjustments' THEN 'tax.filings.prepare'
    WHEN 'bank_account_cutovers' THEN 'banking.reconcile.prepare'
    WHEN 'bank_accounting_proposals' THEN CASE to_jsonb(NEW) ->> 'status'
      WHEN 'PREPARED' THEN 'banking.reconcile.prepare'
      WHEN 'REVIEWED' THEN 'banking.reconcile.review'
      WHEN 'REJECTED' THEN 'banking.reconcile.review'
      WHEN 'COMMITTED' THEN 'ledger.journal.draft'
      ELSE NULL
    END
    ELSE NULL
  END;

  IF TG_TABLE_NAME = 'document_inbox_processing_attempts' THEN
    SELECT item.owner_module INTO inbox_owner_module
    FROM document_inbox_items item
    WHERE item.organization_id = NEW.organization_id
      AND item.id = NEW.inbox_item_id;
    required_permission := inbox_owner_module || '.manage';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_id() IS NULL
    OR (to_jsonb(NEW)->>'created_by')::uuid IS DISTINCT FROM app.current_actor_id()
    OR required_permission IS NULL
    OR NOT app.current_actor_has_permission(required_permission) THEN
    RAISE EXCEPTION 'Workflow append permission or actor context is invalid'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_coordinated_workflow_append() FROM PUBLIC;

CREATE TRIGGER document_inbox_processing_attempts_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON document_inbox_processing_attempts
  FOR EACH ROW EXECUTE FUNCTION app.guard_coordinated_workflow_append();
CREATE TRIGGER asset_tax_classifications_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON asset_tax_classifications
  FOR EACH ROW EXECUTE FUNCTION app.guard_coordinated_workflow_append();
CREATE TRIGGER asset_tax_schedules_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON asset_tax_schedules
  FOR EACH ROW EXECUTE FUNCTION app.guard_coordinated_workflow_append();
CREATE TRIGGER bank_account_cutovers_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bank_account_cutovers
  FOR EACH ROW EXECUTE FUNCTION app.guard_coordinated_workflow_append();
CREATE TRIGGER bank_accounting_proposals_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bank_accounting_proposals
  FOR EACH ROW EXECUTE FUNCTION app.guard_coordinated_workflow_append();
CREATE TRIGGER tax_filing_asset_adjustments_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON tax_filing_asset_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.guard_coordinated_workflow_append();
--> statement-breakpoint

CREATE FUNCTION app.guard_asset_tax_classification_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.jurisdiction <> 'CA' OR NEW.regime_key <> 'CANADA_CCA'
    OR NEW.source_uri !~ '^https://'
    OR NOT EXISTS (
      SELECT 1 FROM asset_register asset
      WHERE asset.organization_id = NEW.organization_id
        AND asset.id = NEW.asset_id
        AND asset.kind = 'TANGIBLE'
        AND NEW.available_for_use_on >= asset.acquisition_date
    )
    OR (NEW.version = 1 AND NEW.supersedes_classification_id IS NOT NULL)
    OR (NEW.version > 1 AND NOT EXISTS (
      SELECT 1 FROM asset_tax_classifications predecessor
      WHERE predecessor.organization_id = NEW.organization_id
        AND predecessor.id = NEW.supersedes_classification_id
        AND predecessor.asset_id = NEW.asset_id
        AND predecessor.version = NEW.version - 1
        AND NOT EXISTS (
          SELECT 1 FROM asset_tax_classifications successor
          WHERE successor.organization_id = predecessor.organization_id
            AND successor.supersedes_classification_id = predecessor.id
        )
    )) THEN
    RAISE EXCEPTION 'Asset tax classification lineage or reviewed rule facts are invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_asset_tax_classification_integrity() FROM PUBLIC;
CREATE TRIGGER asset_tax_classification_integrity_guard
  BEFORE INSERT ON asset_tax_classifications
  FOR EACH ROW EXECUTE FUNCTION app.guard_asset_tax_classification_integrity();
--> statement-breakpoint

CREATE FUNCTION app.guard_asset_tax_schedule_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot_count integer;
  snapshot_maximum numeric(38,9);
  snapshot_claimed numeric(38,9);
  snapshot_closing numeric(38,9);
BEGIN
  SELECT count(*)::integer,
    coalesce(sum((line->>'maximumCca')::numeric), 0),
    coalesce(sum((line->>'claimedCca')::numeric), 0)
  INTO snapshot_count, snapshot_maximum, snapshot_claimed
  FROM jsonb_array_elements(NEW.schedule_snapshot) line;
  SELECT (line->>'closingUcc')::numeric INTO snapshot_closing
  FROM jsonb_array_elements(NEW.schedule_snapshot) line
  ORDER BY (line->>'taxYear')::integer DESC LIMIT 1;

  IF snapshot_count <> NEW.tax_year_end - NEW.tax_year_start + 1
    OR snapshot_maximum <> NEW.maximum_cca
    OR snapshot_claimed <> NEW.claimed_cca
    OR snapshot_closing <> NEW.closing_ucc
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.schedule_snapshot) line
      WHERE (line->>'taxYear')::integer NOT BETWEEN NEW.tax_year_start AND NEW.tax_year_end
        OR (line->>'maximumCca')::numeric < 0
        OR (line->>'claimedCca')::numeric < 0
        OR (line->>'claimedCca')::numeric > (line->>'maximumCca')::numeric
    )
    OR NOT EXISTS (
      SELECT 1 FROM asset_tax_classifications classification
      WHERE classification.organization_id = NEW.organization_id
        AND classification.id = NEW.classification_id
        AND classification.asset_id = NEW.asset_id
        AND classification.authority_status = 'ENACTED'
        AND NEW.tax_year_start = extract(year FROM classification.available_for_use_on)::integer
        AND NOT EXISTS (
          SELECT 1 FROM asset_tax_classifications successor
          WHERE successor.organization_id = classification.organization_id
            AND successor.supersedes_classification_id = classification.id
        )
    )
    OR (NEW.version = 1 AND NEW.supersedes_schedule_id IS NOT NULL)
    OR (NEW.version > 1 AND NOT EXISTS (
      SELECT 1 FROM asset_tax_schedules predecessor
      WHERE predecessor.organization_id = NEW.organization_id
        AND predecessor.id = NEW.supersedes_schedule_id
        AND predecessor.asset_id = NEW.asset_id
        AND predecessor.classification_id = NEW.classification_id
        AND predecessor.tax_year_start = NEW.tax_year_start
        AND predecessor.tax_year_end = NEW.tax_year_end
        AND predecessor.version = NEW.version - 1
        AND NOT EXISTS (
          SELECT 1 FROM asset_tax_schedules successor
          WHERE successor.organization_id = predecessor.organization_id
            AND successor.supersedes_schedule_id = predecessor.id
        )
    )) THEN
    RAISE EXCEPTION 'Asset tax schedule continuity, totals, or lineage are invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_asset_tax_schedule_integrity() FROM PUBLIC;
CREATE TRIGGER asset_tax_schedule_integrity_guard
  BEFORE INSERT ON asset_tax_schedules
  FOR EACH ROW EXECUTE FUNCTION app.guard_asset_tax_schedule_integrity();
--> statement-breakpoint

CREATE FUNCTION app.guard_bank_account_cutover_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.predecessor_account_combination_id = NEW.successor_account_combination_id
    OR NOT EXISTS (
      SELECT 1
      FROM bank_reconciliation_sessions reconciliation
      JOIN account_combinations predecessor
        ON predecessor.organization_id = reconciliation.organization_id
       AND predecessor.id = NEW.predecessor_account_combination_id
       AND predecessor.entity_id = reconciliation.legal_entity_id
       AND predecessor.ledger_id = reconciliation.ledger_id
       AND predecessor.active
      JOIN account_combinations successor
        ON successor.organization_id = reconciliation.organization_id
       AND successor.id = NEW.successor_account_combination_id
       AND successor.entity_id = reconciliation.legal_entity_id
       AND successor.ledger_id = reconciliation.ledger_id
       AND successor.active
      JOIN gl_accounts predecessor_account
        ON predecessor_account.organization_id = predecessor.organization_id
       AND predecessor_account.ledger_id = predecessor.ledger_id
       AND predecessor_account.id = predecessor.account_id
      JOIN gl_accounts successor_account
        ON successor_account.organization_id = successor.organization_id
       AND successor_account.ledger_id = successor.ledger_id
       AND successor_account.id = successor.account_id
      WHERE reconciliation.organization_id = NEW.organization_id
        AND reconciliation.id = NEW.reconciliation_session_id
        AND reconciliation.status = 'DRAFT'
        AND reconciliation.cash_account_combination_id = successor.id
        AND NEW.effective_on BETWEEN reconciliation.statement_start_on AND reconciliation.statement_end_on
        AND predecessor_account.class = successor_account.class
        AND predecessor_account.active AND predecessor_account.postable
        AND successor_account.active AND successor_account.postable
        AND predecessor_account.control_kind = 'NONE'
        AND successor_account.control_kind = 'NONE'
    ) THEN
    RAISE EXCEPTION 'Bank account cutover scope, state, or account lineage is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_account_cutover_integrity() FROM PUBLIC;
CREATE TRIGGER bank_account_cutover_integrity_guard
  BEFORE INSERT ON bank_account_cutovers
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_account_cutover_integrity();
--> statement-breakpoint

CREATE FUNCTION app.guard_bank_accounting_proposal_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor bank_accounting_proposals%ROWTYPE;
BEGIN
  IF (NEW.status = 'COMMITTED') IS DISTINCT FROM (NEW.journal_entry_id IS NOT NULL)
    OR (NEW.version = 1 AND (NEW.status <> 'PREPARED' OR NEW.supersedes_proposal_id IS NOT NULL))
    OR (NEW.version > 1 AND NEW.supersedes_proposal_id IS NULL) THEN
    RAISE EXCEPTION 'Bank proposal state and journal lineage are invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.version > 1 THEN
    SELECT * INTO predecessor FROM bank_accounting_proposals proposal
    WHERE proposal.organization_id = NEW.organization_id
      AND proposal.id = NEW.supersedes_proposal_id
      AND NOT EXISTS (
        SELECT 1 FROM bank_accounting_proposals successor
        WHERE successor.organization_id = proposal.organization_id
          AND successor.supersedes_proposal_id = proposal.id
      );
    IF predecessor.id IS NULL
      OR predecessor.observation_version_id <> NEW.observation_version_id
      OR predecessor.version <> NEW.version - 1
      OR predecessor.proposal_snapshot <> NEW.proposal_snapshot
      OR predecessor.proposal_hash <> NEW.proposal_hash
      OR (NEW.status IN ('REVIEWED', 'REJECTED') AND predecessor.status <> 'PREPARED')
      OR (NEW.status = 'COMMITTED' AND predecessor.status <> 'REVIEWED') THEN
      RAISE EXCEPTION 'Bank proposal supersession must preserve exact reviewed facts'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_accounting_proposal_integrity() FROM PUBLIC;
CREATE TRIGGER bank_accounting_proposal_integrity_guard
  BEFORE INSERT ON bank_accounting_proposals
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_accounting_proposal_integrity();
--> statement-breakpoint

CREATE FUNCTION app.guard_tax_filing_asset_adjustment_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM tax_filings filing
    JOIN asset_tax_schedules schedule
      ON schedule.organization_id = filing.organization_id
     AND schedule.id = NEW.asset_tax_schedule_id
    WHERE filing.organization_id = NEW.organization_id
      AND filing.id = NEW.filing_id
      AND extract(year FROM filing.period_end)::integer
        BETWEEN schedule.tax_year_start AND schedule.tax_year_end
      AND NOT EXISTS (
        SELECT 1 FROM asset_tax_schedules successor
        WHERE successor.organization_id = schedule.organization_id
          AND successor.supersedes_schedule_id = schedule.id
      )
  ) OR NEW.adjustment_snapshot->>'filingId' <> NEW.filing_id::text
    OR NEW.adjustment_snapshot->>'assetTaxScheduleId' <> NEW.asset_tax_schedule_id::text THEN
    RAISE EXCEPTION 'Tax filing asset adjustment scope or immutable snapshot is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_filing_asset_adjustment_integrity() FROM PUBLIC;
CREATE TRIGGER tax_filing_asset_adjustment_integrity_guard
  BEFORE INSERT ON tax_filing_asset_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_asset_adjustment_integrity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_asset_category_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor asset_categories%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ledgers ledger
    JOIN legal_entities entity
      ON entity.organization_id = ledger.organization_id
     AND entity.id = ledger.legal_entity_id AND entity.active
    WHERE ledger.organization_id = NEW.organization_id
      AND ledger.id = NEW.ledger_id
      AND ledger.legal_entity_id = NEW.legal_entity_id
      AND ledger.active
  ) OR EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      NEW.cost_account_combination_id,
      NEW.contra_account_combination_id,
      NEW.expense_account_combination_id,
      NEW.impairment_account_combination_id,
      NEW.disposal_account_combination_id
    ]::uuid[]) selected(id)
    WHERE selected.id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM account_combinations combination
      JOIN gl_accounts account
        ON account.organization_id = combination.organization_id
       AND account.ledger_id = combination.ledger_id
       AND account.id = combination.account_id
      WHERE combination.organization_id = NEW.organization_id
        AND combination.id = selected.id
        AND combination.entity_id = NEW.legal_entity_id
        AND combination.ledger_id = NEW.ledger_id
        AND combination.active AND account.active AND account.postable
        AND account.control_kind = 'NONE'
    )
  ) OR (NEW.version = 1 AND NEW.supersedes_category_id IS NOT NULL)
    OR (NEW.version > 1 AND NEW.supersedes_category_id IS NULL) THEN
    RAISE EXCEPTION 'Asset category account, ledger, or version lineage is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.version > 1 THEN
    SELECT * INTO predecessor FROM asset_categories category
    WHERE category.organization_id = NEW.organization_id
      AND category.id = NEW.supersedes_category_id
      AND NOT EXISTS (
        SELECT 1 FROM asset_categories successor
        WHERE successor.organization_id = category.organization_id
          AND successor.supersedes_category_id = category.id
      );
    IF predecessor.id IS NULL
      OR predecessor.category_key <> NEW.category_key
      OR predecessor.version <> NEW.version - 1
      OR predecessor.legal_entity_id <> NEW.legal_entity_id
      OR predecessor.ledger_id <> NEW.ledger_id
      OR predecessor.kind <> NEW.kind
      OR predecessor.code <> NEW.code
      OR NEW.effective_from <= predecessor.effective_from THEN
      RAISE EXCEPTION 'Asset category revision must supersede the exact current identity prospectively'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_asset_category_integrity() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.guard_asset_register_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM asset_categories category
    WHERE category.organization_id = NEW.organization_id
      AND category.id = NEW.category_id AND category.active
      AND category.kind = NEW.kind
      AND category.legal_entity_id = NEW.legal_entity_id
      AND category.ledger_id = NEW.ledger_id
      AND category.effective_from <= NEW.in_service_on
      AND NOT EXISTS (
        SELECT 1 FROM asset_categories successor
        WHERE successor.organization_id = category.organization_id
          AND successor.supersedes_category_id = category.id
      )
  ) THEN
    RAISE EXCEPTION 'Asset record does not match its current effective active category'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_asset_register_integrity() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_tax_account_mapping_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor tax_account_mapping_sets%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM legal_entities entity
    JOIN ledgers ledger
      ON ledger.organization_id = entity.organization_id
     AND ledger.legal_entity_id = entity.id
     AND ledger.id = NEW.ledger_id
    JOIN tax_filing_templates template
      ON template.id = NEW.template_id
     AND template.currency_code = ledger.functional_currency
    WHERE entity.organization_id = NEW.organization_id
      AND entity.id = NEW.legal_entity_id
      AND entity.active AND ledger.active
  ) OR (NEW.version = 1 AND NEW.supersedes_mapping_set_id IS NOT NULL)
    OR (NEW.version > 1 AND NEW.supersedes_mapping_set_id IS NULL)
    OR (NEW.state = 'ACTIVE' AND EXISTS (
      SELECT 1
      FROM tax_filing_templates template
      CROSS JOIN LATERAL jsonb_array_elements(template.definition -> 'fields') field
      WHERE template.id = NEW.template_id
        AND field ->> 'kind' = 'ACCOUNT'
        AND (field ->> 'required')::boolean
        AND NOT EXISTS (
          SELECT 1 FROM tax_account_mapping_lines line
          WHERE line.organization_id = NEW.organization_id
            AND line.mapping_set_id = NEW.id
            AND line.field_key = field ->> 'key'
        )
    )) OR (NEW.state = 'INACTIVE' AND EXISTS (
      SELECT 1 FROM tax_account_mapping_lines line
      WHERE line.organization_id = NEW.organization_id
        AND line.mapping_set_id = NEW.id
    )) THEN
    RAISE EXCEPTION 'Tax mapping set scope, state, or required field coverage is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.version > 1 THEN
    SELECT * INTO predecessor FROM tax_account_mapping_sets mapping
    WHERE mapping.organization_id = NEW.organization_id
      AND mapping.id = NEW.supersedes_mapping_set_id
      AND NOT EXISTS (
        SELECT 1 FROM tax_account_mapping_sets successor
        WHERE successor.organization_id = mapping.organization_id
          AND successor.supersedes_mapping_set_id = mapping.id
      );
    IF predecessor.id IS NULL
      OR predecessor.legal_entity_id <> NEW.legal_entity_id
      OR predecessor.ledger_id <> NEW.ledger_id
      OR predecessor.template_id <> NEW.template_id
      OR predecessor.version <> NEW.version - 1
      OR NEW.effective_from <= predecessor.effective_from THEN
      RAISE EXCEPTION 'Tax mapping version must supersede the exact current scope prospectively'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_account_mapping_set() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.guard_tax_filing_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_exception boolean;
  expected_status text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.reconciliation_snapshot) field
    WHERE field ->> 'status' <> 'MATCHED'
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.validation_snapshot) rule
    WHERE rule ->> 'status' = 'FAIL'
  ) INTO has_exception;
  expected_status := CASE
    WHEN has_exception THEN 'REVIEW_REQUIRED'
    WHEN NEW.filing_type = 'PREPARED' THEN 'READY'
    ELSE 'MATCHED'
  END;

  IF NEW.status <> expected_status OR NOT EXISTS (
    SELECT 1
    FROM tax_account_mapping_sets mapping_set
    JOIN tax_filing_templates template ON template.id = mapping_set.template_id
    JOIN ledgers ledger
      ON ledger.organization_id = mapping_set.organization_id
     AND ledger.id = mapping_set.ledger_id
     AND ledger.legal_entity_id = mapping_set.legal_entity_id
     AND ledger.functional_currency = template.currency_code
    WHERE mapping_set.organization_id = NEW.organization_id
      AND mapping_set.id = NEW.mapping_set_id
      AND mapping_set.legal_entity_id = NEW.legal_entity_id
      AND mapping_set.ledger_id = NEW.ledger_id
      AND mapping_set.template_id = NEW.template_id
      AND mapping_set.state = 'ACTIVE'
      AND mapping_set.effective_from <= NEW.period_end
      AND (mapping_set.effective_to IS NULL OR mapping_set.effective_to >= NEW.period_end)
      AND NOT EXISTS (
        SELECT 1 FROM tax_account_mapping_sets later
        WHERE later.organization_id = mapping_set.organization_id
          AND later.ledger_id = mapping_set.ledger_id
          AND later.template_id = mapping_set.template_id
          AND later.version > mapping_set.version
          AND later.effective_from <= NEW.period_end
      )
      AND (NEW.template_snapshot ->> 'id')::uuid = template.id
      AND (NEW.template_snapshot ->> 'mappingSetId')::uuid = mapping_set.id
      AND (NEW.template_snapshot ->> 'mappingVersion')::integer = mapping_set.version
      AND NEW.template_snapshot ->> 'sourceDigest' = template.source_digest
      AND NEW.template_snapshot -> 'definition' = template.definition
  ) THEN
    RAISE EXCEPTION 'Tax filing status, template, ledger, or effective mapping lineage is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_filing_integrity() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_match_allocation_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  observation_lock bigint;
  journal_line_lock bigint;
  observation_amount numeric(38,9);
  journal_line_amount numeric(38,9);
  observation_limit numeric(38,9);
  journal_line_limit numeric(38,9);
  observation_used numeric(38,9);
  journal_line_used numeric(38,9);
BEGIN
  observation_lock := hashtextextended(
    'business-finlynq:bank-observation:' || NEW.observation_version_id::text, 0
  );
  journal_line_lock := hashtextextended(
    'business-finlynq:bank-journal-line:' || NEW.journal_line_id::text, 0
  );
  PERFORM pg_advisory_xact_lock(least(observation_lock, journal_line_lock));
  IF observation_lock <> journal_line_lock THEN
    PERFORM pg_advisory_xact_lock(greatest(observation_lock, journal_line_lock));
  END IF;

  SELECT version.amount
  INTO observation_amount
  FROM bank_reconciliation_sessions reconciliation
  JOIN bank_observations observation
    ON observation.organization_id = reconciliation.organization_id
   AND observation.external_account_id = reconciliation.external_account_id
  JOIN bank_observation_versions version
    ON version.organization_id = observation.organization_id
   AND version.observation_id = observation.id
   AND version.id = NEW.observation_version_id
  WHERE reconciliation.organization_id = NEW.organization_id
    AND reconciliation.id = NEW.reconciliation_session_id
    AND reconciliation.status = 'DRAFT'
    AND version.status = 'POSTED'
    AND version.currency_code = reconciliation.currency_code
    AND version.posted_on BETWEEN reconciliation.statement_start_on AND reconciliation.statement_end_on
    AND NOT EXISTS (
      SELECT 1 FROM bank_observation_versions newer
      WHERE newer.organization_id = version.organization_id
        AND newer.observation_id = version.observation_id
        AND newer.version_number > version.version_number
    );

  SELECT line.debit_transaction - line.credit_transaction
  INTO journal_line_amount
  FROM bank_reconciliation_sessions reconciliation
  JOIN journal_lines line
    ON line.organization_id = reconciliation.organization_id
   AND line.id = NEW.journal_line_id
   AND line.transaction_currency = reconciliation.currency_code
  JOIN journal_entries journal
    ON journal.organization_id = line.organization_id
   AND journal.id = line.journal_entry_id
   AND journal.status = 'POSTED'
  WHERE reconciliation.organization_id = NEW.organization_id
    AND reconciliation.id = NEW.reconciliation_session_id
    AND reconciliation.status = 'DRAFT'
    AND journal.accounting_date BETWEEN reconciliation.statement_start_on AND reconciliation.statement_end_on
    AND (
      line.account_combination_id = reconciliation.cash_account_combination_id
      OR EXISTS (
        SELECT 1 FROM bank_account_cutovers cutover
        WHERE cutover.organization_id = reconciliation.organization_id
          AND cutover.reconciliation_session_id = reconciliation.id
          AND cutover.predecessor_account_combination_id = line.account_combination_id
          AND journal.accounting_date <= cutover.effective_on
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM bank_account_cutovers cutover
      WHERE cutover.organization_id = reconciliation.organization_id
        AND cutover.reconciliation_session_id = reconciliation.id
        AND cutover.migration_journal_line_ids ? line.id::text
    );

  IF observation_amount IS NULL OR journal_line_amount IS NULL THEN
    RAISE EXCEPTION 'A bank match requires current posted evidence and an authorized posted cash line in a draft reconciliation'
      USING ERRCODE = '23514';
  END IF;
  IF observation_amount = 0 OR journal_line_amount = 0
    OR sign(observation_amount) <> sign(journal_line_amount) THEN
    RAISE EXCEPTION 'A bank match requires bank and cash-line evidence with the same non-zero direction'
      USING ERRCODE = '23514';
  END IF;
  observation_limit := abs(observation_amount);
  journal_line_limit := abs(journal_line_amount);

  SELECT coalesce(sum(allocation.allocated_amount), 0)
  INTO observation_used
  FROM bank_match_allocations allocation
  JOIN bank_reconciliation_sessions reconciliation
    ON reconciliation.organization_id = allocation.organization_id
   AND reconciliation.id = allocation.reconciliation_session_id
   AND reconciliation.status <> 'VOIDED'
  LEFT JOIN bank_match_allocation_voids void
    ON void.organization_id = allocation.organization_id
   AND void.allocation_id = allocation.id
  WHERE allocation.organization_id = NEW.organization_id
    AND allocation.observation_version_id = NEW.observation_version_id
    AND void.id IS NULL;

  SELECT coalesce(sum(allocation.allocated_amount), 0)
  INTO journal_line_used
  FROM bank_match_allocations allocation
  JOIN bank_reconciliation_sessions reconciliation
    ON reconciliation.organization_id = allocation.organization_id
   AND reconciliation.id = allocation.reconciliation_session_id
   AND reconciliation.status <> 'VOIDED'
  LEFT JOIN bank_match_allocation_voids void
    ON void.organization_id = allocation.organization_id
   AND void.allocation_id = allocation.id
  WHERE allocation.organization_id = NEW.organization_id
    AND allocation.journal_line_id = NEW.journal_line_id
    AND void.id IS NULL;

  IF observation_used + NEW.allocated_amount > observation_limit
    OR journal_line_used + NEW.allocated_amount > journal_line_limit THEN
    RAISE EXCEPTION 'The allocation exceeds globally available bank or cash-line evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_match_allocation_cap() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION app.audit_coordinated_workflow_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_action text;
  selected_type text;
  selected_metadata jsonb;
  selected_row jsonb := to_jsonb(NEW);
BEGIN
  selected_action := CASE TG_TABLE_NAME
    WHEN 'document_inbox_processing_attempts' THEN 'document-inbox.processing-attempted'
    WHEN 'asset_tax_classifications' THEN 'assets.tax-classification.version-created'
    WHEN 'asset_tax_schedules' THEN 'assets.tax-schedule.version-created'
    WHEN 'bank_account_cutovers' THEN 'bank.reconciliation.account-cutover-created'
    WHEN 'bank_accounting_proposals' THEN 'bank.accounting-proposal.' || lower(selected_row ->> 'status')
    WHEN 'tax_filing_asset_adjustments' THEN 'tax.filing.asset-adjustment-attached'
  END;
  selected_type := CASE TG_TABLE_NAME
    WHEN 'document_inbox_processing_attempts' THEN 'document_inbox_item'
    WHEN 'asset_tax_classifications' THEN 'asset_tax_classification'
    WHEN 'asset_tax_schedules' THEN 'asset_tax_schedule'
    WHEN 'bank_account_cutovers' THEN 'bank_account_cutover'
    WHEN 'bank_accounting_proposals' THEN 'bank_accounting_proposal'
    WHEN 'tax_filing_asset_adjustments' THEN 'tax_filing_asset_adjustment'
  END;
  selected_metadata := CASE TG_TABLE_NAME
    WHEN 'document_inbox_processing_attempts' THEN jsonb_build_object(
      'inboxItemId', selected_row ->> 'inbox_item_id', 'operation', selected_row ->> 'operation',
      'outcome', selected_row ->> 'outcome', 'errorCode', selected_row ->> 'error_code'
    )
    WHEN 'asset_tax_classifications' THEN jsonb_build_object(
      'assetId', selected_row ->> 'asset_id', 'classKey', selected_row ->> 'class_key',
      'poolKey', selected_row ->> 'pool_key', 'ruleKey', selected_row ->> 'rule_key',
      'ruleVersion', selected_row ->> 'rule_version',
      'authorityStatus', selected_row ->> 'authority_status',
      'version', selected_row -> 'version',
      'supersedesClassificationId', selected_row ->> 'supersedes_classification_id',
      'commandHash', selected_row ->> 'command_hash'
    )
    WHEN 'asset_tax_schedules' THEN jsonb_build_object(
      'assetId', selected_row ->> 'asset_id',
      'classificationId', selected_row ->> 'classification_id',
      'taxYearStart', selected_row -> 'tax_year_start',
      'taxYearEnd', selected_row -> 'tax_year_end',
      'version', selected_row -> 'version',
      'supersedesScheduleId', selected_row ->> 'supersedes_schedule_id',
      'commandHash', selected_row ->> 'command_hash'
    )
    WHEN 'bank_account_cutovers' THEN jsonb_build_object(
      'reconciliationId', selected_row ->> 'reconciliation_session_id',
      'predecessorAccountCombinationId', selected_row ->> 'predecessor_account_combination_id',
      'successorAccountCombinationId', selected_row ->> 'successor_account_combination_id',
      'effectiveOn', selected_row ->> 'effective_on',
      'confirmationHash', selected_row ->> 'confirmation_hash',
      'commandHash', selected_row ->> 'command_hash'
    )
    WHEN 'bank_accounting_proposals' THEN jsonb_build_object(
      'observationVersionId', selected_row ->> 'observation_version_id',
      'version', selected_row -> 'version', 'status', selected_row ->> 'status',
      'proposalHash', selected_row ->> 'proposal_hash',
      'supersedesProposalId', selected_row ->> 'supersedes_proposal_id',
      'journalEntryId', selected_row ->> 'journal_entry_id',
      'commandHash', selected_row ->> 'command_hash'
    )
    WHEN 'tax_filing_asset_adjustments' THEN jsonb_build_object(
      'filingId', selected_row ->> 'filing_id',
      'assetTaxScheduleId', selected_row ->> 'asset_tax_schedule_id',
      'commandHash', selected_row ->> 'command_hash'
    )
  END;
  PERFORM app.append_tenant_business_audit(
    (selected_row ->> 'organization_id')::uuid, selected_action, selected_type,
    selected_row ->> 'id',
    jsonb_strip_nulls(selected_metadata), NULL
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.audit_coordinated_workflow_event() FROM PUBLIC;
CREATE TRIGGER document_inbox_processing_attempts_business_audit
  AFTER INSERT ON document_inbox_processing_attempts
  FOR EACH ROW EXECUTE FUNCTION app.audit_coordinated_workflow_event();
CREATE TRIGGER asset_tax_classifications_business_audit
  AFTER INSERT ON asset_tax_classifications
  FOR EACH ROW EXECUTE FUNCTION app.audit_coordinated_workflow_event();
CREATE TRIGGER asset_tax_schedules_business_audit
  AFTER INSERT ON asset_tax_schedules
  FOR EACH ROW EXECUTE FUNCTION app.audit_coordinated_workflow_event();
CREATE TRIGGER bank_account_cutovers_business_audit
  AFTER INSERT ON bank_account_cutovers
  FOR EACH ROW EXECUTE FUNCTION app.audit_coordinated_workflow_event();
CREATE TRIGGER bank_accounting_proposals_business_audit
  AFTER INSERT ON bank_accounting_proposals
  FOR EACH ROW EXECUTE FUNCTION app.audit_coordinated_workflow_event();
CREATE TRIGGER tax_filing_asset_adjustments_business_audit
  AFTER INSERT ON tax_filing_asset_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.audit_coordinated_workflow_event();
--> statement-breakpoint

REVOKE ALL ON document_inbox_processing_attempts, asset_tax_classifications,
  asset_tax_schedules, bank_account_cutovers, bank_accounting_proposals,
  tax_filing_asset_adjustments FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT SELECT, INSERT ON document_inbox_processing_attempts, asset_tax_classifications,
      asset_tax_schedules, bank_account_cutovers, bank_accounting_proposals,
      tax_filing_asset_adjustments TO business_finlynq_app;
    REVOKE UPDATE, DELETE ON document_inbox_processing_attempts, asset_tax_classifications,
      asset_tax_schedules, bank_account_cutovers, bank_accounting_proposals,
      tax_filing_asset_adjustments FROM business_finlynq_app;
  END IF;
END
$$;
--> statement-breakpoint

INSERT INTO demo_sandbox_reset_tables(table_name, purge_order)
SELECT reset_table.table_name, reset_state.maximum_order + reset_table.ordinal::integer
FROM (SELECT coalesce(max(purge_order), 0) AS maximum_order FROM demo_sandbox_reset_tables) reset_state
CROSS JOIN unnest(ARRAY[
  'document_inbox_processing_attempts',
  'tax_filing_asset_adjustments',
  'asset_tax_schedules',
  'asset_tax_classifications',
  'bank_accounting_proposals',
  'bank_account_cutovers'
]::text[]) WITH ORDINALITY AS reset_table(table_name, ordinal);
