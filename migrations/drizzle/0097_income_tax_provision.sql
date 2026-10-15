CREATE TABLE "tax_provision_assumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"fiscal_year" integer NOT NULL,
	"year_start" date NOT NULL,
	"year_end" date NOT NULL,
	"version" integer NOT NULL,
	"state" text NOT NULL,
	"payload" jsonb NOT NULL,
	"supersedes_id" uuid,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_provision_assumptions_scope_check" CHECK ("tax_provision_assumptions"."fiscal_year" BETWEEN 1900 AND 2500 AND "tax_provision_assumptions"."version">0 AND "tax_provision_assumptions"."year_start"<="tax_provision_assumptions"."year_end" AND "tax_provision_assumptions"."year_end"-"tax_provision_assumptions"."year_start"<367),
	CONSTRAINT "tax_provision_assumptions_state_check" CHECK ("tax_provision_assumptions"."state" IN ('DRAFT','REVIEWED')),
	CONSTRAINT "tax_provision_assumptions_payload_check" CHECK (jsonb_typeof("tax_provision_assumptions"."payload")='object' AND length("tax_provision_assumptions"."reason") BETWEEN 8 AND 500),
	CONSTRAINT "tax_provision_assumptions_hash_check" CHECK ("tax_provision_assumptions"."command_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tax_provision_calculations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"assumptions_id" uuid NOT NULL,
	"fiscal_year" integer NOT NULL,
	"through_date" date NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"source_hash" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_provision_calculations_snapshot_check" CHECK (jsonb_typeof("tax_provision_calculations"."snapshot")='object' AND "tax_provision_calculations"."version">0 AND length("tax_provision_calculations"."reason") BETWEEN 8 AND 500),
	CONSTRAINT "tax_provision_calculations_hash_check" CHECK ("tax_provision_calculations"."command_hash" ~ '^[a-f0-9]{64}$' AND "tax_provision_calculations"."source_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tax_provision_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"calculation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"journal_id" uuid,
	"source_hash" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_provision_events_state_check" CHECK ("tax_provision_events"."action" IN ('REVIEW','DRAFT') AND "tax_provision_events"."version">0 AND ("tax_provision_events"."action"<>'REVIEW' OR "tax_provision_events"."journal_id" IS NULL)),
	CONSTRAINT "tax_provision_events_hash_check" CHECK ("tax_provision_events"."command_hash" ~ '^[a-f0-9]{64}$' AND "tax_provision_events"."source_hash" ~ '^[a-f0-9]{64}$' AND length("tax_provision_events"."reason") BETWEEN 8 AND 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_provision_assumptions_org_id" ON "tax_provision_assumptions" USING btree ("organization_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_provision_assumptions_scope_version" ON "tax_provision_assumptions" USING btree ("organization_id","ledger_id","fiscal_year","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_provision_assumptions_replay" ON "tax_provision_assumptions" USING btree ("organization_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_provision_calculations_org_id" ON "tax_provision_calculations" USING btree ("organization_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_provision_calculations_scope_version" ON "tax_provision_calculations" USING btree ("organization_id","ledger_id","through_date","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_provision_calculations_source" ON "tax_provision_calculations" USING btree ("organization_id","source_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_provision_calculations_replay" ON "tax_provision_calculations" USING btree ("organization_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_provision_events_version" ON "tax_provision_events" USING btree ("organization_id","calculation_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_provision_events_replay" ON "tax_provision_events" USING btree ("organization_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_provision_events_one_draft" ON "tax_provision_events" USING btree ("organization_id","calculation_id") WHERE "tax_provision_events"."action"='DRAFT';
--> statement-breakpoint
ALTER TABLE "tax_provision_assumptions" ADD CONSTRAINT "tax_provision_assumptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_provision_assumptions" ADD CONSTRAINT "tax_provision_assumptions_entity_fk" FOREIGN KEY ("organization_id","legal_entity_id") REFERENCES "public"."legal_entities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_provision_assumptions" ADD CONSTRAINT "tax_provision_assumptions_ledger_fk" FOREIGN KEY ("organization_id","ledger_id") REFERENCES "public"."ledgers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_provision_assumptions" ADD CONSTRAINT "tax_provision_assumptions_prior_fk" FOREIGN KEY ("organization_id","supersedes_id") REFERENCES "public"."tax_provision_assumptions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_provision_calculations" ADD CONSTRAINT "tax_provision_calculations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_provision_calculations" ADD CONSTRAINT "tax_provision_calculations_assumptions_fk" FOREIGN KEY ("organization_id","assumptions_id") REFERENCES "public"."tax_provision_assumptions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_provision_calculations" ADD CONSTRAINT "tax_provision_calculations_period_fk" FOREIGN KEY ("organization_id","period_id") REFERENCES "public"."fiscal_periods"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_provision_calculations" ADD CONSTRAINT "tax_provision_calculations_ledger_fk" FOREIGN KEY ("organization_id","ledger_id") REFERENCES "public"."ledgers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_provision_calculations" ADD CONSTRAINT "tax_provision_calculations_entity_fk" FOREIGN KEY ("organization_id","legal_entity_id") REFERENCES "public"."legal_entities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_provision_events" ADD CONSTRAINT "tax_provision_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_provision_events" ADD CONSTRAINT "tax_provision_events_calculation_fk" FOREIGN KEY ("organization_id","calculation_id") REFERENCES "public"."tax_provision_calculations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_provision_events" ADD CONSTRAINT "tax_provision_events_journal_fk" FOREIGN KEY ("organization_id","journal_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint

--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['tax_provision_assumptions','tax_provision_calculations','tax_provision_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id())',table_name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.guard_guidance_revision_immutable()',table_name||'_immutable',table_name);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.guard_tax_provision_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_assumption tax_provision_assumptions%ROWTYPE; assumption tax_provision_assumptions%ROWTYPE; calculation tax_provision_calculations%ROWTYPE;
 previous_event tax_provision_events%ROWTYPE; previous_version integer; amount numeric; journal journal_entries%ROWTYPE; required_permission text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tax-governance:'||NEW.organization_id::text,0));
 required_permission:=CASE WHEN TG_TABLE_NAME='tax_provision_assumptions' THEN 'tax.filing.configuration.manage' ELSE 'tax.filings.prepare' END;
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.created_by IS DISTINCT FROM app.current_actor_id() OR NOT app.current_actor_has_permission(required_permission) THEN
 RAISE EXCEPTION 'Provision changes require the authorized tenant actor' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='tax_provision_assumptions' THEN
  SELECT * INTO previous_assumption FROM tax_provision_assumptions WHERE organization_id=NEW.organization_id AND ledger_id=NEW.ledger_id AND fiscal_year=NEW.fiscal_year ORDER BY version DESC LIMIT 1;
  IF NEW.version<>coalesce(previous_assumption.version,0)+1 OR NEW.supersedes_id IS DISTINCT FROM previous_assumption.id
   OR NOT EXISTS(SELECT 1 FROM ledgers WHERE organization_id=NEW.organization_id AND id=NEW.ledger_id AND legal_entity_id=NEW.legal_entity_id AND active)
   OR (NEW.state='REVIEWED' AND (previous_assumption.state IS DISTINCT FROM 'DRAFT' OR NEW.payload IS DISTINCT FROM previous_assumption.payload OR NEW.year_start<>previous_assumption.year_start OR NEW.year_end<>previous_assumption.year_end)) THEN
   RAISE EXCEPTION 'Provision assumption scope, revision or review is stale' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='tax_provision_calculations' THEN
  SELECT * INTO assumption FROM tax_provision_assumptions WHERE organization_id=NEW.organization_id AND id=NEW.assumptions_id;
  SELECT max(version) INTO previous_version FROM tax_provision_calculations WHERE organization_id=NEW.organization_id AND ledger_id=NEW.ledger_id AND through_date=NEW.through_date;
  IF NEW.version<>coalesce(previous_version,0)+1 OR assumption.id IS NULL OR NEW.legal_entity_id<>assumption.legal_entity_id OR NEW.ledger_id<>assumption.ledger_id OR NEW.fiscal_year<>assumption.fiscal_year
   OR NEW.through_date NOT BETWEEN assumption.year_start AND assumption.year_end
   OR NOT EXISTS(SELECT 1 FROM fiscal_periods WHERE organization_id=NEW.organization_id AND id=NEW.period_id AND ledger_id=NEW.ledger_id AND fiscal_year=NEW.fiscal_year AND NEW.through_date BETWEEN starts_on AND ends_on)
   OR NEW.snapshot->'assumptions'->>'id' IS DISTINCT FROM assumption.id::text OR NEW.snapshot->'assumptions'->'payload' IS DISTINCT FROM assumption.payload
   OR NEW.snapshot->'scope'->>'periodId' IS DISTINCT FROM NEW.period_id::text OR NEW.snapshot->'scope'->>'throughDate' IS DISTINCT FROM NEW.through_date::text THEN
   RAISE EXCEPTION 'Provision calculation scope or source revision is invalid' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO calculation FROM tax_provision_calculations WHERE organization_id=NEW.organization_id AND id=NEW.calculation_id;
  SELECT * INTO previous_event FROM tax_provision_events WHERE organization_id=NEW.organization_id AND calculation_id=NEW.calculation_id ORDER BY version DESC LIMIT 1;
  IF calculation.id IS NULL OR NEW.source_hash<>calculation.source_hash OR NEW.version<>coalesce(previous_event.version,0)+1 OR previous_event.action='DRAFT' OR calculation.snapshot->>'ready' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'Provision review is stale, blocked or already generated' USING ERRCODE='23514'; END IF;
  IF NEW.action='DRAFT' THEN
   IF NOT app.current_actor_has_permission('ledger.journal.draft') THEN RAISE EXCEPTION 'Draft journal permission required' USING ERRCODE='42501'; END IF;
   amount:=(calculation.snapshot->>'incrementalAdjustment')::numeric;
   IF previous_event.action IS DISTINCT FROM 'REVIEW' OR ((amount=0) IS DISTINCT FROM (NEW.journal_id IS NULL)) THEN RAISE EXCEPTION 'Review the exact calculation before draft generation' USING ERRCODE='23514'; END IF;
   IF NEW.journal_id IS NOT NULL THEN
    SELECT * INTO journal FROM journal_entries WHERE organization_id=NEW.organization_id AND id=NEW.journal_id;
    IF journal.id IS NULL OR journal.status<>'DRAFT' OR journal.ledger_id<>calculation.ledger_id OR journal.legal_entity_id<>calculation.legal_entity_id OR journal.period_id<>calculation.period_id OR journal.accounting_date<>calculation.through_date OR journal.purpose<>'TAX_ADJUSTMENT'
     OR (SELECT count(*) FROM journal_lines WHERE organization_id=NEW.organization_id AND journal_entry_id=journal.id)<>2
     OR NOT EXISTS(SELECT 1 FROM journal_lines WHERE organization_id=NEW.organization_id AND journal_entry_id=journal.id AND account_combination_id=(calculation.snapshot->'assumptions'->'payload'->>'expenseCombinationId')::uuid AND debit_functional=greatest(amount,0) AND credit_functional=greatest(-amount,0))
     OR NOT EXISTS(SELECT 1 FROM journal_lines WHERE organization_id=NEW.organization_id AND journal_entry_id=journal.id AND account_combination_id=(calculation.snapshot->'assumptions'->'payload'->>'payableCombinationId')::uuid AND debit_functional=greatest(-amount,0) AND credit_functional=greatest(amount,0)) THEN
     RAISE EXCEPTION 'Provision journal does not match the reviewed balanced adjustment' USING ERRCODE='23514'; END IF;
   END IF;
  END IF;
 END IF;
 PERFORM app.append_tenant_business_audit(NEW.organization_id,'tax.provision.record',TG_TABLE_NAME,NEW.id::text,jsonb_build_object('version',NEW.version,'reason',NEW.reason),NULL);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_tax_provision_record() FROM PUBLIC;
CREATE TRIGGER tax_provision_assumptions_guard BEFORE INSERT ON tax_provision_assumptions FOR EACH ROW EXECUTE FUNCTION app.guard_tax_provision_record();
CREATE TRIGGER tax_provision_calculations_guard BEFORE INSERT ON tax_provision_calculations FOR EACH ROW EXECUTE FUNCTION app.guard_tax_provision_record();
CREATE TRIGGER tax_provision_events_guard BEFORE INSERT ON tax_provision_events FOR EACH ROW EXECUTE FUNCTION app.guard_tax_provision_record();
--> statement-breakpoint
CREATE FUNCTION app.guard_provision_posting_freshness() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE calculation tax_provision_calculations%ROWTYPE; latest_assumption uuid; ledger_fingerprint text;
BEGIN
 IF NEW.status='POSTED' AND OLD.status<>'POSTED' THEN
  SELECT saved.* INTO calculation FROM tax_provision_calculations saved JOIN tax_provision_events event ON event.organization_id=saved.organization_id AND event.calculation_id=saved.id
   WHERE event.organization_id=NEW.organization_id AND event.journal_id=NEW.id AND event.action='DRAFT';
  IF calculation.id IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('tax-governance:'||NEW.organization_id::text,0));
   SELECT id INTO latest_assumption FROM tax_provision_assumptions WHERE organization_id=NEW.organization_id AND ledger_id=NEW.ledger_id AND fiscal_year=calculation.fiscal_year ORDER BY version DESC LIMIT 1;
   SELECT md5(coalesce(string_agg(id::text||':'||content_hash,',' ORDER BY id),'')) INTO ledger_fingerprint FROM journal_entries
    WHERE organization_id=NEW.organization_id AND ledger_id=NEW.ledger_id AND legal_entity_id=NEW.legal_entity_id AND status='POSTED' AND accounting_date<=calculation.through_date;
   IF latest_assumption IS DISTINCT FROM calculation.assumptions_id OR ledger_fingerprint IS DISTINCT FROM calculation.snapshot->'sources'->>'ledgerFingerprint'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(calculation.snapshot->'sources'->'ccaSources') source JOIN asset_tax_schedules successor ON successor.organization_id=NEW.organization_id AND successor.supersedes_schedule_id=(source->>'id')::uuid)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(calculation.snapshot->'sources'->'ccaSources') source JOIN asset_tax_schedules schedule ON schedule.organization_id=NEW.organization_id AND schedule.id=(source->>'id')::uuid JOIN asset_tax_classifications successor ON successor.organization_id=schedule.organization_id AND successor.supersedes_classification_id=schedule.classification_id)
    OR EXISTS(SELECT 1 FROM journal_entries entry WHERE entry.organization_id=NEW.organization_id AND entry.ledger_id=NEW.ledger_id AND entry.legal_entity_id=NEW.legal_entity_id AND entry.status<>'POSTED' AND entry.id<>NEW.id AND entry.accounting_date BETWEEN (calculation.snapshot->>'yearStart')::date AND calculation.through_date
       AND NOT EXISTS(SELECT 1 FROM journal_transaction_controls control WHERE control.organization_id=entry.organization_id AND control.journal_entry_id=entry.id AND control.outcome='DELETED')
       AND NOT EXISTS(SELECT 1 FROM tax_provision_events event WHERE event.organization_id=entry.organization_id AND event.journal_id=entry.id AND event.action='DRAFT')) THEN
    RAISE EXCEPTION 'Provision sources changed; delete the stale unposted draft and calculate, review and generate a new adjustment' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_provision_posting_freshness() FROM PUBLIC;
CREATE TRIGGER provision_posting_freshness BEFORE UPDATE OF status ON journal_entries FOR EACH ROW EXECUTE FUNCTION app.guard_provision_posting_freshness();
--> statement-breakpoint
INSERT INTO demo_sandbox_reset_tables(table_name,purge_order)
SELECT reset_table.table_name,reset_state.maximum_order+reset_table.ordinal::integer
FROM (SELECT coalesce(max(purge_order),0) AS maximum_order FROM demo_sandbox_reset_tables) reset_state
CROSS JOIN unnest(ARRAY['tax_provision_events','tax_provision_calculations','tax_provision_assumptions']::text[]) WITH ORDINALITY AS reset_table(table_name,ordinal)
ON CONFLICT(table_name) DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION app.guard_generated_provision_journal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected_org uuid; selected_journal uuid;
BEGIN
 selected_org:=coalesce(NEW.organization_id,OLD.organization_id);
 IF TG_TABLE_NAME='journal_entries' THEN
  selected_journal:=OLD.id;
  IF NEW.description IS NOT DISTINCT FROM OLD.description AND NEW.accounting_date IS NOT DISTINCT FROM OLD.accounting_date AND NEW.ledger_id IS NOT DISTINCT FROM OLD.ledger_id AND NEW.legal_entity_id IS NOT DISTINCT FROM OLD.legal_entity_id AND NEW.period_id IS NOT DISTINCT FROM OLD.period_id AND NEW.purpose IS NOT DISTINCT FROM OLD.purpose AND (NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash OR (NEW.status='POSTED' AND OLD.status<>'POSTED')) THEN RETURN NEW; END IF;
 ELSE selected_journal:=coalesce(NEW.journal_entry_id,OLD.journal_entry_id); END IF;
 IF EXISTS(SELECT 1 FROM tax_provision_events WHERE organization_id=selected_org AND journal_id=selected_journal AND action='DRAFT') THEN
  RAISE EXCEPTION 'Provision-generated lines and inputs are immutable; delete an unposted draft and generate a reviewed replacement' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_generated_provision_journal() FROM PUBLIC;
CREATE TRIGGER generated_provision_header BEFORE UPDATE OF description,accounting_date,ledger_id,legal_entity_id,period_id,purpose,content_hash ON journal_entries FOR EACH ROW EXECUTE FUNCTION app.guard_generated_provision_journal();
CREATE TRIGGER generated_provision_lines BEFORE INSERT OR UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION app.guard_generated_provision_journal();
