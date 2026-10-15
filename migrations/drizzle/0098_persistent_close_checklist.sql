CREATE TABLE "close_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"template_revision_id" uuid NOT NULL,
	"task_definitions" jsonb NOT NULL,
	CONSTRAINT "close_instances_valid" CHECK (jsonb_typeof("close_instances"."task_definitions")='array' AND "close_instances"."command_hash"~'^[a-f0-9]{64}$' AND length("close_instances"."reason") BETWEEN 8 AND 500)
);
--> statement-breakpoint
CREATE TABLE "close_notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"instance_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"due_within_days" integer NOT NULL,
	"events" jsonb NOT NULL,
	CONSTRAINT "close_notifications_valid" CHECK ("close_notification_preferences"."version">0 AND "close_notification_preferences"."due_within_days" BETWEEN 0 AND 30 AND jsonb_typeof("close_notification_preferences"."events")='array' AND "close_notification_preferences"."command_hash"~'^[a-f0-9]{64}$' AND length("close_notification_preferences"."reason") BETWEEN 8 AND 500)
);
--> statement-breakpoint
CREATE TABLE "close_notification_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"instance_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"notice_key" text NOT NULL,
	"as_of_date" date NOT NULL,
	CONSTRAINT "close_receipts_valid" CHECK ("close_notification_receipts"."notice_key"~'^[a-f0-9]{64}$' AND "close_notification_receipts"."command_hash"~'^[a-f0-9]{64}$' AND length("close_notification_receipts"."reason") BETWEEN 8 AND 500)
);
--> statement-breakpoint
CREATE TABLE "close_task_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"instance_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"review" jsonb,
	"source_hash" text,
	"carried_from_revision_id" uuid,
	CONSTRAINT "close_tasks_valid" CHECK ("close_task_revisions"."version">0 AND length("close_task_revisions"."task_key") BETWEEN 1 AND 180 AND jsonb_typeof("close_task_revisions"."definition")='object' AND jsonb_typeof("close_task_revisions"."input")='object' AND "close_task_revisions"."command_hash"~'^[a-f0-9]{64}$' AND length("close_task_revisions"."reason") BETWEEN 8 AND 500),
	CONSTRAINT "close_tasks_review" CHECK (("close_task_revisions"."source_hash" IS NULL OR "close_task_revisions"."source_hash"~'^[a-f0-9]{64}$') AND ("close_task_revisions"."input"->>'status' NOT IN ('REVIEWED','COMPLETE','NOT_APPLICABLE') OR ("close_task_revisions"."review" IS NOT NULL AND "close_task_revisions"."source_hash" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "close_template_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "close_templates_valid" CHECK ("close_template_revisions"."version">0 AND jsonb_typeof("close_template_revisions"."definition")='object' AND "close_template_revisions"."command_hash"~'^[a-f0-9]{64}$' AND length("close_template_revisions"."reason") BETWEEN 8 AND 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "close_instances_org_id" ON "close_instances" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "close_instances_period" ON "close_instances" USING btree ("organization_id","period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "close_instances_replay" ON "close_instances" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "close_notifications_version" ON "close_notification_preferences" USING btree ("organization_id","instance_id","recipient_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "close_notifications_replay" ON "close_notification_preferences" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "close_receipts_notice" ON "close_notification_receipts" USING btree ("organization_id","recipient_id","notice_key");--> statement-breakpoint
CREATE UNIQUE INDEX "close_receipts_replay" ON "close_notification_receipts" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "close_tasks_org_id" ON "close_task_revisions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "close_tasks_version" ON "close_task_revisions" USING btree ("organization_id","instance_id","task_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "close_tasks_replay" ON "close_task_revisions" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "close_templates_org_id" ON "close_template_revisions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "close_templates_version" ON "close_template_revisions" USING btree ("organization_id","template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "close_templates_replay" ON "close_template_revisions" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "close_instances" ADD CONSTRAINT "close_instances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_instances" ADD CONSTRAINT "close_instances_entity_fk" FOREIGN KEY ("organization_id","legal_entity_id") REFERENCES "public"."legal_entities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_instances" ADD CONSTRAINT "close_instances_ledger_fk" FOREIGN KEY ("organization_id","ledger_id") REFERENCES "public"."ledgers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_instances" ADD CONSTRAINT "close_instances_period_fk" FOREIGN KEY ("organization_id","period_id") REFERENCES "public"."fiscal_periods"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_instances" ADD CONSTRAINT "close_instances_template_fk" FOREIGN KEY ("organization_id","template_revision_id") REFERENCES "public"."close_template_revisions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_notification_preferences" ADD CONSTRAINT "close_notification_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_notification_preferences" ADD CONSTRAINT "close_notifications_instance_fk" FOREIGN KEY ("organization_id","instance_id") REFERENCES "public"."close_instances"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_notification_receipts" ADD CONSTRAINT "close_notification_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_notification_receipts" ADD CONSTRAINT "close_receipts_instance_fk" FOREIGN KEY ("organization_id","instance_id") REFERENCES "public"."close_instances"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_task_revisions" ADD CONSTRAINT "close_task_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_task_revisions" ADD CONSTRAINT "close_tasks_instance_fk" FOREIGN KEY ("organization_id","instance_id") REFERENCES "public"."close_instances"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_task_revisions" ADD CONSTRAINT "close_tasks_origin_fk" FOREIGN KEY ("organization_id","carried_from_revision_id") REFERENCES "public"."close_task_revisions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_template_revisions" ADD CONSTRAINT "close_template_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['close_template_revisions','close_instances','close_task_revisions','close_notification_preferences','close_notification_receipts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id())',name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.guard_guidance_revision_immutable()',name||'_immutable',name);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.guard_close_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_version integer; previous_task close_task_revisions%ROWTYPE; origin_task close_task_revisions%ROWTYPE; target close_instances%ROWTYPE; origin close_instances%ROWTYPE; member_id uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tax-governance:'||NEW.organization_id::text,0));
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.created_by IS DISTINCT FROM app.current_actor_id() OR NOT app.current_actor_has_permission('ledger.period.close') THEN RAISE EXCEPTION 'Close changes require the authorized tenant actor' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='close_template_revisions' THEN
  SELECT max(version) INTO previous_version FROM close_template_revisions WHERE organization_id=NEW.organization_id AND template_id=NEW.template_id;
  IF NEW.version<>coalesce(previous_version,0)+1 THEN RAISE EXCEPTION 'Stale close template revision' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='close_instances' THEN
  IF NOT EXISTS(SELECT 1 FROM fiscal_periods period JOIN ledgers ledger ON ledger.organization_id=period.organization_id AND ledger.id=period.ledger_id WHERE period.organization_id=NEW.organization_id AND period.id=NEW.period_id AND ledger.id=NEW.ledger_id AND ledger.legal_entity_id=NEW.legal_entity_id)
   OR NOT EXISTS(SELECT 1 FROM close_template_revisions template WHERE template.organization_id=NEW.organization_id AND template.id=NEW.template_revision_id AND template.definition->'tasks'=NEW.task_definitions) THEN RAISE EXCEPTION 'Close instance scope or template mismatch' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='close_task_revisions' THEN
  SELECT * INTO target FROM close_instances WHERE organization_id=NEW.organization_id AND id=NEW.instance_id;
  SELECT * INTO previous_task FROM close_task_revisions WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id AND task_key=NEW.task_key ORDER BY version DESC LIMIT 1;
  IF target.id IS NULL OR NEW.version<>coalesce(previous_task.version,0)+1 OR (previous_task.id IS NOT NULL AND (NEW.definition IS DISTINCT FROM previous_task.definition OR NEW.carried_from_revision_id IS DISTINCT FROM previous_task.carried_from_revision_id)) THEN RAISE EXCEPTION 'Stale close task or changed origin' USING ERRCODE='23514'; END IF;
  IF NEW.carried_from_revision_id IS NULL THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(target.task_definitions) definition WHERE definition->>'key'=NEW.task_key AND definition=NEW.definition) THEN RAISE EXCEPTION 'Task is absent from the immutable instance template' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT * INTO origin_task FROM close_task_revisions WHERE organization_id=NEW.organization_id AND id=NEW.carried_from_revision_id;
   SELECT * INTO origin FROM close_instances WHERE organization_id=NEW.organization_id AND id=origin_task.instance_id;
   IF origin.id IS NULL OR origin.ledger_id<>target.ledger_id OR origin.legal_entity_id<>target.legal_entity_id OR NEW.definition->>'source' IS DISTINCT FROM origin_task.definition->>'source'
    OR NOT EXISTS(SELECT 1 FROM fiscal_periods a,fiscal_periods b WHERE a.organization_id=NEW.organization_id AND b.organization_id=NEW.organization_id AND a.id=origin.period_id AND b.id=target.period_id AND b.starts_on>a.ends_on)
    OR (previous_task.id IS NULL AND (NEW.review IS NOT NULL OR NEW.input->>'status'<>'NOT_STARTED')) THEN RAISE EXCEPTION 'Invalid carry-forward scope or copied completion' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.input->>'status' NOT IN ('NOT_STARTED','READY','IN_PROGRESS','BLOCKED','REVIEWED','COMPLETE','NOT_APPLICABLE') THEN RAISE EXCEPTION 'Invalid close status' USING ERRCODE='23514'; END IF;
  FOREACH member_id IN ARRAY ARRAY[(NEW.input->>'ownerId')::uuid,(NEW.input->>'reviewerId')::uuid] LOOP
   IF member_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM organization_memberships membership JOIN users person ON person.id=membership.user_id AND person.active WHERE membership.organization_id=NEW.organization_id AND membership.user_id=member_id AND membership.active) THEN RAISE EXCEPTION 'Close assignee must be an active tenant member' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF NEW.input->>'status' IN ('REVIEWED','COMPLETE','NOT_APPLICABLE') THEN
   IF NEW.input->>'reviewerId' IS DISTINCT FROM NEW.created_by::text OR NEW.input->>'ownerId' IS NULL OR jsonb_array_length(NEW.input->'evidence')=0 OR NEW.input->>'blockingReason' IS NOT NULL OR NEW.review->>'actorId' IS DISTINCT FROM NEW.created_by::text
    OR (NEW.definition->>'source'='SIGNOFF' AND NEW.input->>'status'='NOT_APPLICABLE') THEN RAISE EXCEPTION 'Close review requires assigned reviewer and explicit evidence' USING ERRCODE='23514'; END IF;
   IF NEW.input->>'status'='COMPLETE' AND (previous_task.input->>'status' IS DISTINCT FROM 'REVIEWED' OR NEW.source_hash IS DISTINCT FROM previous_task.source_hash OR (NEW.input-'status') IS DISTINCT FROM (previous_task.input-'status')) THEN RAISE EXCEPTION 'Complete only the exact reviewed task revision' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  IF NEW.recipient_id IS DISTINCT FROM NEW.created_by THEN RAISE EXCEPTION 'Recipients must opt in or acknowledge their own notices' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='close_notification_preferences' THEN
   SELECT max(version) INTO previous_version FROM close_notification_preferences WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id AND recipient_id=NEW.recipient_id;
   IF NEW.version<>coalesce(previous_version,0)+1 THEN RAISE EXCEPTION 'Stale close notification preference' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 PERFORM app.append_tenant_business_audit(NEW.organization_id,'close.record',TG_TABLE_NAME,NEW.id::text,jsonb_build_object('reason',NEW.reason),NULL);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_close_record() FROM PUBLIC;
CREATE TRIGGER close_templates_guard BEFORE INSERT ON close_template_revisions FOR EACH ROW EXECUTE FUNCTION app.guard_close_record();
CREATE TRIGGER close_instances_guard BEFORE INSERT ON close_instances FOR EACH ROW EXECUTE FUNCTION app.guard_close_record();
CREATE TRIGGER close_tasks_guard BEFORE INSERT ON close_task_revisions FOR EACH ROW EXECUTE FUNCTION app.guard_close_record();
CREATE TRIGGER close_preferences_guard BEFORE INSERT ON close_notification_preferences FOR EACH ROW EXECUTE FUNCTION app.guard_close_record();
CREATE TRIGGER close_receipts_guard BEFORE INSERT ON close_notification_receipts FOR EACH ROW EXECUTE FUNCTION app.guard_close_record();
--> statement-breakpoint
INSERT INTO demo_sandbox_reset_tables(table_name,purge_order)
SELECT reset_table.table_name,reset_state.maximum_order+reset_table.ordinal::integer
FROM (SELECT coalesce(max(purge_order),0) AS maximum_order FROM demo_sandbox_reset_tables) reset_state
CROSS JOIN unnest(ARRAY['close_notification_receipts','close_notification_preferences','close_task_revisions','close_instances','close_template_revisions']::text[]) WITH ORDINALITY AS reset_table(table_name,ordinal)
ON CONFLICT(table_name) DO NOTHING;

--> statement-breakpoint
CREATE FUNCTION app.close_assignable_members() RETURNS TABLE(id uuid,display_name_ciphertext text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT person.id,person.display_name_ciphertext FROM organization_memberships membership JOIN users person ON person.id=membership.user_id AND person.active
 WHERE membership.organization_id=app.current_organization_id() AND membership.active AND (app.current_actor_has_permission('mcp.ledger.read') OR app.current_actor_has_permission('ledger.period.close')) ORDER BY person.id;
$$;
REVOKE ALL ON FUNCTION app.close_assignable_members() FROM PUBLIC;
