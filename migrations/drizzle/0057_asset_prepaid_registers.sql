CREATE TABLE "asset_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"cost_account_combination_id" uuid NOT NULL,
	"contra_account_combination_id" uuid,
	"expense_account_combination_id" uuid NOT NULL,
	"impairment_account_combination_id" uuid,
	"disposal_account_combination_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_categories_kind_check" CHECK (kind IN ('TANGIBLE', 'INTANGIBLE', 'PREPAID')),
	CONSTRAINT "asset_categories_mapping_check" CHECK ((kind = 'PREPAID') OR contra_account_combination_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "asset_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"effective_on" date NOT NULL,
	"amount" numeric(38, 9),
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_lifecycle_events_type_check" CHECK (event_type IN ('CREATED', 'SCHEDULED', 'DRAFT_CREATED', 'POSTED', 'IMPAIRED', 'TRANSFERRED', 'DISPOSED', 'RETIRED', 'TERMINATED', 'ADJUSTED', 'REVERSED'))
);
--> statement-breakpoint
CREATE TABLE "asset_register" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"asset_number" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"classification" text DEFAULT 'FINITE_LIFE' NOT NULL,
	"acquisition_date" date NOT NULL,
	"in_service_on" date NOT NULL,
	"schedule_end_on" date,
	"cost" numeric(38, 9) NOT NULL,
	"residual_value" numeric(38, 9) DEFAULT '0' NOT NULL,
	"useful_life_months" integer,
	"recognition_frequency" text DEFAULT 'MONTHLY' NOT NULL,
	"location" text,
	"custodian" text,
	"vendor_name" text,
	"source_reference" text,
	"evidence_asset_id" uuid,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"recognized_to_date" numeric(38, 9) DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_register_kind_check" CHECK (kind IN ('TANGIBLE', 'INTANGIBLE', 'PREPAID')),
	CONSTRAINT "asset_register_classification_check" CHECK (classification IN ('FINITE_LIFE', 'INDEFINITE_LIFE')),
	CONSTRAINT "asset_register_status_check" CHECK (status IN ('ACTIVE', 'IMPAIRED', 'DISPOSED', 'RETIRED', 'TERMINATED')),
	CONSTRAINT "asset_register_amount_check" CHECK (cost > 0 AND residual_value >= 0 AND residual_value <= cost AND recognized_to_date >= 0 AND recognized_to_date <= cost),
	CONSTRAINT "asset_register_schedule_check" CHECK ((classification = 'INDEFINITE_LIFE' AND kind = 'INTANGIBLE' AND useful_life_months IS NULL AND schedule_end_on IS NULL) OR (classification = 'FINITE_LIFE' AND useful_life_months BETWEEN 1 AND 1200 AND schedule_end_on IS NOT NULL)),
	CONSTRAINT "asset_register_dates_check" CHECK (acquisition_date <= in_service_on AND (schedule_end_on IS NULL OR schedule_end_on >= in_service_on))
);
--> statement-breakpoint
CREATE TABLE "asset_schedule_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"period_start_on" date NOT NULL,
	"period_end_on" date NOT NULL,
	"due_on" date NOT NULL,
	"amount" numeric(38, 9) NOT NULL,
	"status" text DEFAULT 'DUE' NOT NULL,
	"journal_entry_id" uuid,
	"idempotency_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"adjustment_reason" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_schedule_entries_status_check" CHECK (status IN ('DUE', 'DRAFTED', 'POSTED', 'SKIPPED', 'ADJUSTED', 'REVERSED')),
	CONSTRAINT "asset_schedule_entries_amount_check" CHECK (amount > 0 AND sequence_number > 0 AND period_start_on <= period_end_on AND due_on >= period_start_on),
	CONSTRAINT "asset_schedule_entries_journal_check" CHECK ((status = 'DUE' AND journal_entry_id IS NULL) OR (status <> 'DUE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "asset_categories_org_id_unique" ON "asset_categories" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_categories_scope_code_unique" ON "asset_categories" USING btree ("organization_id","ledger_id","code");--> statement-breakpoint
CREATE INDEX "asset_categories_org_kind_idx" ON "asset_categories" USING btree ("organization_id","kind","display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_lifecycle_events_org_id_unique" ON "asset_lifecycle_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "asset_lifecycle_events_org_asset_idx" ON "asset_lifecycle_events" USING btree ("organization_id","asset_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_register_org_id_unique" ON "asset_register" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_register_org_number_unique" ON "asset_register" USING btree ("organization_id","asset_number");--> statement-breakpoint
CREATE INDEX "asset_register_org_kind_status_idx" ON "asset_register" USING btree ("organization_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_schedule_entries_org_id_unique" ON "asset_schedule_entries" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_schedule_entries_asset_sequence_unique" ON "asset_schedule_entries" USING btree ("asset_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_schedule_entries_org_idempotency_unique" ON "asset_schedule_entries" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "asset_schedule_entries_org_due_idx" ON "asset_schedule_entries" USING btree ("organization_id","status","due_on");--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_org_entity_fk" FOREIGN KEY ("organization_id","legal_entity_id") REFERENCES "public"."legal_entities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_org_ledger_fk" FOREIGN KEY ("organization_id","ledger_id") REFERENCES "public"."ledgers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_org_cost_account_fk" FOREIGN KEY ("organization_id","cost_account_combination_id") REFERENCES "public"."account_combinations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_org_contra_account_fk" FOREIGN KEY ("organization_id","contra_account_combination_id") REFERENCES "public"."account_combinations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_org_expense_account_fk" FOREIGN KEY ("organization_id","expense_account_combination_id") REFERENCES "public"."account_combinations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_org_impairment_account_fk" FOREIGN KEY ("organization_id","impairment_account_combination_id") REFERENCES "public"."account_combinations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_org_disposal_account_fk" FOREIGN KEY ("organization_id","disposal_account_combination_id") REFERENCES "public"."account_combinations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_lifecycle_events" ADD CONSTRAINT "asset_lifecycle_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_lifecycle_events" ADD CONSTRAINT "asset_lifecycle_events_org_asset_fk" FOREIGN KEY ("organization_id","asset_id") REFERENCES "public"."asset_register"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_lifecycle_events" ADD CONSTRAINT "asset_lifecycle_events_org_journal_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_register" ADD CONSTRAINT "asset_register_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_register" ADD CONSTRAINT "asset_register_org_category_fk" FOREIGN KEY ("organization_id","category_id") REFERENCES "public"."asset_categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_register" ADD CONSTRAINT "asset_register_org_entity_fk" FOREIGN KEY ("organization_id","legal_entity_id") REFERENCES "public"."legal_entities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_register" ADD CONSTRAINT "asset_register_org_ledger_fk" FOREIGN KEY ("organization_id","ledger_id") REFERENCES "public"."ledgers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_register" ADD CONSTRAINT "asset_register_org_evidence_fk" FOREIGN KEY ("organization_id","evidence_asset_id") REFERENCES "public"."document_evidence_assets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_schedule_entries" ADD CONSTRAINT "asset_schedule_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_schedule_entries" ADD CONSTRAINT "asset_schedule_entries_org_asset_fk" FOREIGN KEY ("organization_id","asset_id") REFERENCES "public"."asset_register"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_schedule_entries" ADD CONSTRAINT "asset_schedule_entries_org_journal_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE restrict ON UPDATE no action;
