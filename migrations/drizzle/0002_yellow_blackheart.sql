CREATE TABLE "membership_roles" (
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid NOT NULL,
	CONSTRAINT "membership_roles_organization_id_membership_id_role_id_pk" PRIMARY KEY("organization_id","membership_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"organization_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permissions_organization_id_role_id_permission_key_pk" PRIMARY KEY("organization_id","role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"system_template" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"journal_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"decision" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_number_sequences" (
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"key" text NOT NULL,
	"next_value" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "period_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"from_state" "period_state" NOT NULL,
	"to_state" "period_state" NOT NULL,
	"reason" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_journal_type_key_journal_type_definitions_key_fk";
--> statement-breakpoint
ALTER TABLE "journal_type_definitions" DROP CONSTRAINT "journal_type_definitions_pkey";--> statement-breakpoint
ALTER TABLE "journal_type_definitions" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "journal_type_definition_id" uuid;--> statement-breakpoint
UPDATE "journal_entries" AS entry
SET "journal_type_definition_id" = definition."id"
FROM "journal_type_definitions" AS definition
WHERE entry."journal_type_key" = definition."key"
  AND entry."journal_type_version" = definition."version";--> statement-breakpoint
ALTER TABLE "journal_entries" ALTER COLUMN "journal_type_definition_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_id_organization_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."organization_memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_approvals" ADD CONSTRAINT "journal_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_approvals" ADD CONSTRAINT "journal_approvals_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_approvals" ADD CONSTRAINT "journal_approvals_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_number_sequences" ADD CONSTRAINT "ledger_number_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_number_sequences" ADD CONSTRAINT "ledger_number_sequences_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_events" ADD CONSTRAINT "period_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_events" ADD CONSTRAINT "period_events_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_events" ADD CONSTRAINT "period_events_period_id_fiscal_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_org_key_unique" ON "roles" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_org_id_unique" ON "roles" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_approvals_actor_version_unique" ON "journal_approvals" USING btree ("journal_entry_id","journal_version","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_approvals_org_id_unique" ON "journal_approvals" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_number_sequences_ledger_key_unique" ON "ledger_number_sequences" USING btree ("ledger_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "period_events_org_request_unique" ON "period_events" USING btree ("organization_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "period_events_org_id_unique" ON "period_events" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_journal_type_definition_id_journal_type_definitions_id_fk" FOREIGN KEY ("journal_type_definition_id") REFERENCES "public"."journal_type_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" DROP COLUMN "role_key";--> statement-breakpoint
ALTER TABLE "organization_memberships" DROP COLUMN "can_post";--> statement-breakpoint
ALTER TABLE "organization_memberships" DROP COLUMN "can_post_adjustments";
