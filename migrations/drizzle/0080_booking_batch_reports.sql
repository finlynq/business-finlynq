CREATE TABLE "booking_batch_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"phase" text NOT NULL,
	"status" text NOT NULL,
	"completeness" text NOT NULL,
	"snapshot_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"snapshot_hash" text NOT NULL,
	"command_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"review_report_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_batch_reports_version_positive" CHECK ("booking_batch_reports"."version" > 0 AND "booking_batch_reports"."key_version" > 0),
	CONSTRAINT "booking_batch_reports_phase_check" CHECK ("booking_batch_reports"."phase" IN ('REVIEW','OUTCOME')),
	CONSTRAINT "booking_batch_reports_status_check" CHECK ("booking_batch_reports"."status" IN ('DRAFT','PARTIALLY_POSTED','POSTED')),
	CONSTRAINT "booking_batch_reports_completeness_check" CHECK ("booking_batch_reports"."completeness" IN ('COMPLETE','HELD','STALE')),
	CONSTRAINT "booking_batch_reports_hash_check" CHECK ("booking_batch_reports"."snapshot_hash" ~ '^[a-f0-9]{64}$' AND "booking_batch_reports"."command_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "booking_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"record_refs" jsonb NOT NULL,
	"required_permissions" text[] NOT NULL,
	"definition_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"command_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_batches_key_version_positive" CHECK ("booking_batches"."key_version" > 0),
	CONSTRAINT "booking_batches_hash_check" CHECK ("booking_batches"."command_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "booking_batches_record_refs_check" CHECK (jsonb_typeof("booking_batches"."record_refs") = 'array' AND jsonb_array_length("booking_batches"."record_refs") BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "booking_batch_reports" ADD CONSTRAINT "booking_batch_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_batches_org_id_unique" ON "booking_batches" USING btree ("organization_id","id");--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "booking_batch_reports" ADD CONSTRAINT "booking_batch_reports_batch_fk" FOREIGN KEY ("organization_id","batch_id") REFERENCES "public"."booking_batches"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_batches" ADD CONSTRAINT "booking_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_batches" ADD CONSTRAINT "booking_batches_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_batches" ADD CONSTRAINT "booking_batches_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_batch_reports_org_id_unique" ON "booking_batch_reports" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_batch_reports_version_unique" ON "booking_batch_reports" USING btree ("organization_id","batch_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_batch_reports_org_idempotency_unique" ON "booking_batch_reports" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_batches_org_idempotency_unique" ON "booking_batches" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
ALTER TABLE booking_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON booking_batches USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
ALTER TABLE booking_batch_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_batch_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON booking_batch_reports USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
--> statement-breakpoint
CREATE FUNCTION app.guard_booking_report_append() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_permissions text[]; selected_permission text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Booking review evidence is append-only' USING ERRCODE='55000'; END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR app.current_actor_id() IS NULL
    OR NEW.created_by IS DISTINCT FROM app.current_actor_id() OR NOT app.current_actor_has_permission('mcp.ledger.read') THEN
    RAISE EXCEPTION 'Booking report permission or actor context is invalid' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='booking_batches' THEN
    IF NOT EXISTS(SELECT 1 FROM ledgers l WHERE l.organization_id=NEW.organization_id AND l.id=NEW.ledger_id AND l.legal_entity_id=NEW.legal_entity_id) THEN
      RAISE EXCEPTION 'Booking company and ledger do not match' USING ERRCODE='23514';
    END IF;
    IF NOT NEW.required_permissions @> ARRAY['mcp.ledger.read']::text[] OR NOT NEW.required_permissions <@ ARRAY['mcp.ledger.read','payables.read','receivables.read']::text[] THEN
      RAISE EXCEPTION 'Invalid booking read permissions' USING ERRCODE='23514';
    END IF;
    selected_permissions:=NEW.required_permissions;
  ELSE
    SELECT b.required_permissions INTO selected_permissions FROM booking_batches b WHERE b.organization_id=NEW.organization_id AND b.id=NEW.batch_id;
    IF selected_permissions IS NULL THEN RAISE EXCEPTION 'Booking batch is unavailable' USING ERRCODE='42501'; END IF;
    IF NEW.review_report_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking_batch_reports r WHERE r.organization_id=NEW.organization_id AND r.batch_id=NEW.batch_id AND r.id=NEW.review_report_id AND r.phase='REVIEW') THEN
      RAISE EXCEPTION 'Booking review must belong to this batch' USING ERRCODE='23514';
    END IF;
  END IF;
  FOREACH selected_permission IN ARRAY selected_permissions LOOP
    IF NOT app.current_actor_has_permission(selected_permission) THEN RAISE EXCEPTION 'Booking read permission is required' USING ERRCODE='42501'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_booking_report_append() FROM PUBLIC;
CREATE TRIGGER booking_batches_append_guard BEFORE INSERT OR UPDATE OR DELETE ON booking_batches FOR EACH ROW EXECUTE FUNCTION app.guard_booking_report_append();
CREATE TRIGGER booking_batch_reports_append_guard BEFORE INSERT OR UPDATE OR DELETE ON booking_batch_reports FOR EACH ROW EXECUTE FUNCTION app.guard_booking_report_append();
--> statement-breakpoint
CREATE FUNCTION app.audit_booking_report_append() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM app.append_tenant_business_audit(NEW.organization_id,CASE TG_TABLE_NAME WHEN 'booking_batches' THEN 'booking.batch-created' ELSE 'booking.report-created' END,
    TG_TABLE_NAME,NEW.id::text,jsonb_strip_nulls(jsonb_build_object('commandHash',NEW.command_hash,'batchId',to_jsonb(NEW)->>'batch_id','version',to_jsonb(NEW)->>'version','phase',to_jsonb(NEW)->>'phase','snapshotHash',to_jsonb(NEW)->>'snapshot_hash')),NULL);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.audit_booking_report_append() FROM PUBLIC;
CREATE TRIGGER booking_batches_business_audit AFTER INSERT ON booking_batches FOR EACH ROW EXECUTE FUNCTION app.audit_booking_report_append();
CREATE TRIGGER booking_batch_reports_business_audit AFTER INSERT ON booking_batch_reports FOR EACH ROW EXECUTE FUNCTION app.audit_booking_report_append();
--> statement-breakpoint
REVOKE ALL ON booking_batches,booking_batch_reports FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='business_finlynq_app') THEN
    GRANT SELECT,INSERT ON booking_batches,booking_batch_reports TO business_finlynq_app;
    REVOKE UPDATE,DELETE ON booking_batches,booking_batch_reports FROM business_finlynq_app;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO demo_sandbox_reset_tables(table_name,purge_order)
SELECT entry.table_name,reset_state.maximum_order+entry.ordinal::integer
FROM (SELECT coalesce(max(purge_order),0) AS maximum_order FROM demo_sandbox_reset_tables) reset_state
CROSS JOIN unnest(ARRAY['booking_batch_reports','booking_batches']::text[]) WITH ORDINALITY AS entry(table_name,ordinal)
ON CONFLICT(table_name) DO NOTHING;
