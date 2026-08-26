CREATE TYPE "public"."journal_origin" AS ENUM('USER', 'SYSTEM', 'IMPORT', 'API', 'MCP');--> statement-breakpoint
CREATE TYPE "public"."journal_purpose" AS ENUM('ROUTINE', 'ADJUSTING', 'REVERSAL', 'OPENING', 'CLOSING', 'REVALUATION', 'TAX_ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."journal_relation_kind" AS ENUM('REVERSAL_OF', 'REPLACEMENT_OF', 'REVERSES_ON_OPEN');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."account_class" AS ENUM('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');--> statement-breakpoint
CREATE TYPE "public"."accounting_profile" AS ENUM('CAN_ASPE', 'US_GAAP_NONPUBLIC');--> statement-breakpoint
CREATE TYPE "public"."control_account_kind" AS ENUM('NONE', 'AR', 'AP');--> statement-breakpoint
CREATE TYPE "public"."custom_slot_state" AS ENUM('EMPTY', 'CONFIGURED_UNBOUND', 'ACTIVE_LOCKED', 'INACTIVE_LOCKED');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('PRIMARY', 'SECONDARY', 'CONSOLIDATION');--> statement-breakpoint
CREATE TYPE "public"."period_state" AS ENUM('OPEN', 'ADJUSTMENT_ONLY', 'HARD_CLOSED', 'SEALED');--> statement-breakpoint
CREATE TYPE "public"."open_item_status" AS ENUM('OPEN', 'PARTIALLY_SETTLED', 'SETTLED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."party_role_kind" AS ENUM('CUSTOMER', 'SUPPLIER');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"delegated_identity" text,
	"auth_method" text NOT NULL,
	"source_surface" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"request_id" text NOT NULL,
	"reason" text,
	"safe_metadata" jsonb NOT NULL,
	"previous_event_hash" text,
	"event_hash" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organization_key_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"key_provider" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"can_post" boolean DEFAULT false NOT NULL,
	"can_post_adjustments" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_lookup_hash" text NOT NULL,
	"email_ciphertext" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"journal_type_key" text NOT NULL,
	"journal_type_version" integer NOT NULL,
	"source_document_id" uuid,
	"source_event_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"origin" "journal_origin" NOT NULL,
	"purpose" "journal_purpose" NOT NULL,
	"status" "journal_status" DEFAULT 'DRAFT' NOT NULL,
	"accounting_date" date NOT NULL,
	"functional_currency" text NOT NULL,
	"journal_number" integer,
	"description" text NOT NULL,
	"total_debit_functional" numeric(38, 9) DEFAULT '0' NOT NULL,
	"total_credit_functional" numeric(38, 9) DEFAULT '0' NOT NULL,
	"content_hash" text,
	"approval_version" integer,
	"created_by" uuid,
	"approved_by" uuid,
	"posted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"posted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "journal_entry_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_journal_id" uuid NOT NULL,
	"to_journal_id" uuid NOT NULL,
	"kind" "journal_relation_kind" NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_combination_id" uuid NOT NULL,
	"debit_functional" numeric(38, 9) DEFAULT '0' NOT NULL,
	"credit_functional" numeric(38, 9) DEFAULT '0' NOT NULL,
	"transaction_currency" text NOT NULL,
	"debit_transaction" numeric(38, 9) DEFAULT '0' NOT NULL,
	"credit_transaction" numeric(38, 9) DEFAULT '0' NOT NULL,
	"fx_rate" numeric(38, 18) NOT NULL,
	"fx_rate_source" text NOT NULL,
	"fx_rate_effective_at" timestamp with time zone NOT NULL,
	"party_account_id" uuid,
	"subledger_event_id" uuid,
	"tax_snapshot_id" uuid,
	"memo" text
);
--> statement-breakpoint
CREATE TABLE "journal_type_definitions" (
	"key" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"owner_module" text NOT NULL,
	"display_name" text NOT NULL,
	"correction_route" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"owner_module" text NOT NULL,
	"source_type" text NOT NULL,
	"source_number" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_combinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"subaccount_id" uuid,
	"department_id" uuid,
	"intercompany_entity_id" uuid,
	"custom_1_id" uuid,
	"custom_2_id" uuid,
	"custom_3_id" uuid,
	"custom_4_id" uuid,
	"custom_5_id" uuid,
	"custom_6_id" uuid,
	"custom_7_id" uuid,
	"custom_8_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"schema_version" numeric(10, 0) DEFAULT '1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"fiscal_year" integer NOT NULL,
	"period_number" integer NOT NULL,
	"label" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"state" "period_state" DEFAULT 'OPEN' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gl_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"class" "account_class" NOT NULL,
	"control_kind" "control_account_kind" DEFAULT 'NONE' NOT NULL,
	"postable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date
);
--> statement-breakpoint
CREATE TABLE "ledgers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" "ledger_kind" DEFAULT 'PRIMARY' NOT NULL,
	"accounting_profile" "accounting_profile" NOT NULL,
	"functional_currency" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"first_posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"country_code" text NOT NULL,
	"region_code" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segment_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"ordinal" integer NOT NULL,
	"display_name" text NOT NULL,
	"state" "custom_slot_state" NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"protected_use_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "segment_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date
);
--> statement-breakpoint
CREATE TABLE "open_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"party_account_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"status" "open_item_status" DEFAULT 'OPEN' NOT NULL,
	"transaction_currency" text NOT NULL,
	"original_transaction_amount" numeric(38, 9) NOT NULL,
	"open_transaction_amount" numeric(38, 9) NOT NULL,
	"original_functional_amount" numeric(38, 9) NOT NULL,
	"carrying_functional_amount" numeric(38, 9) NOT NULL,
	"due_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_number" text NOT NULL,
	"display_name_ciphertext" text NOT NULL,
	"search_token" text NOT NULL,
	"internal_legal_entity_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"role" "party_role_kind" NOT NULL,
	"account_number" text NOT NULL,
	"control_account_id" uuid NOT NULL,
	"transaction_currency" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subledger_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"party_account_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_version" text NOT NULL,
	"event_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_tax_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"regime_key" text NOT NULL,
	"registration_ciphertext" text NOT NULL,
	"key_version" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date
);
--> statement-breakpoint
CREATE TABLE "tax_determination_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"tax_pack_version_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"status" text NOT NULL,
	"rule_key" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"currency" text NOT NULL,
	"taxable_basis" numeric(38, 9) NOT NULL,
	"total_tax" numeric(38, 9) NOT NULL,
	"fact_snapshot" jsonb NOT NULL,
	"evidence_snapshot" jsonb NOT NULL,
	"component_snapshot" jsonb NOT NULL,
	"rounding_snapshot" jsonb NOT NULL,
	"gl_mapping_snapshot" jsonb NOT NULL,
	"decision_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_pack_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_key" text NOT NULL,
	"version" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source_uri" text NOT NULL,
	"source_digest" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_key_versions" ADD CONSTRAINT "organization_key_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_id_fiscal_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_journal_type_key_journal_type_definitions_key_fk" FOREIGN KEY ("journal_type_key") REFERENCES "public"."journal_type_definitions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_relations" ADD CONSTRAINT "journal_entry_relations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_relations" ADD CONSTRAINT "journal_entry_relations_from_journal_id_journal_entries_id_fk" FOREIGN KEY ("from_journal_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_relations" ADD CONSTRAINT "journal_entry_relations_to_journal_id_journal_entries_id_fk" FOREIGN KEY ("to_journal_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_combination_id_account_combinations_id_fk" FOREIGN KEY ("account_combination_id") REFERENCES "public"."account_combinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_account_id_party_accounts_id_fk" FOREIGN KEY ("party_account_id") REFERENCES "public"."party_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_subledger_event_id_subledger_events_id_fk" FOREIGN KEY ("subledger_event_id") REFERENCES "public"."subledger_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_account_id_gl_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_subaccount_id_segment_values_id_fk" FOREIGN KEY ("subaccount_id") REFERENCES "public"."segment_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_department_id_segment_values_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."segment_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_intercompany_entity_id_legal_entities_id_fk" FOREIGN KEY ("intercompany_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_custom_1_id_segment_values_id_fk" FOREIGN KEY ("custom_1_id") REFERENCES "public"."segment_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_custom_2_id_segment_values_id_fk" FOREIGN KEY ("custom_2_id") REFERENCES "public"."segment_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_custom_3_id_segment_values_id_fk" FOREIGN KEY ("custom_3_id") REFERENCES "public"."segment_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_custom_4_id_segment_values_id_fk" FOREIGN KEY ("custom_4_id") REFERENCES "public"."segment_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_custom_5_id_segment_values_id_fk" FOREIGN KEY ("custom_5_id") REFERENCES "public"."segment_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_custom_6_id_segment_values_id_fk" FOREIGN KEY ("custom_6_id") REFERENCES "public"."segment_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_custom_7_id_segment_values_id_fk" FOREIGN KEY ("custom_7_id") REFERENCES "public"."segment_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_combinations" ADD CONSTRAINT "account_combinations_custom_8_id_segment_values_id_fk" FOREIGN KEY ("custom_8_id") REFERENCES "public"."segment_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_definitions" ADD CONSTRAINT "segment_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_values" ADD CONSTRAINT "segment_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_values" ADD CONSTRAINT "segment_values_definition_id_segment_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."segment_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_items" ADD CONSTRAINT "open_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_items" ADD CONSTRAINT "open_items_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_items" ADD CONSTRAINT "open_items_party_account_id_party_accounts_id_fk" FOREIGN KEY ("party_account_id") REFERENCES "public"."party_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_items" ADD CONSTRAINT "open_items_source_event_id_subledger_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."subledger_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_internal_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("internal_legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_accounts" ADD CONSTRAINT "party_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_accounts" ADD CONSTRAINT "party_accounts_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_accounts" ADD CONSTRAINT "party_accounts_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_accounts" ADD CONSTRAINT "party_accounts_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_accounts" ADD CONSTRAINT "party_accounts_control_account_id_gl_accounts_id_fk" FOREIGN KEY ("control_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_addresses" ADD CONSTRAINT "party_addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_addresses" ADD CONSTRAINT "party_addresses_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subledger_events" ADD CONSTRAINT "subledger_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subledger_events" ADD CONSTRAINT "subledger_events_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subledger_events" ADD CONSTRAINT "subledger_events_party_account_id_party_accounts_id_fk" FOREIGN KEY ("party_account_id") REFERENCES "public"."party_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tax_registrations" ADD CONSTRAINT "entity_tax_registrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tax_registrations" ADD CONSTRAINT "entity_tax_registrations_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_determination_snapshots" ADD CONSTRAINT "tax_determination_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_determination_snapshots" ADD CONSTRAINT "tax_determination_snapshots_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_determination_snapshots" ADD CONSTRAINT "tax_determination_snapshots_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_determination_snapshots" ADD CONSTRAINT "tax_determination_snapshots_tax_pack_version_id_tax_pack_versions_id_fk" FOREIGN KEY ("tax_pack_version_id") REFERENCES "public"."tax_pack_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_org_request_action_unique" ON "audit_events" USING btree ("organization_id","request_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_org_id_unique" ON "outbox_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_key_versions_org_version_unique" ON "organization_key_versions" USING btree ("organization_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_memberships_org_user_unique" ON "organization_memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lookup_hash_unique" ON "users" USING btree ("email_lookup_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_org_idempotency_unique" ON "journal_entries" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_ledger_number_unique" ON "journal_entries" USING btree ("ledger_id","journal_number");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_org_id_unique" ON "journal_entries" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entry_relations_unique" ON "journal_entry_relations" USING btree ("from_journal_id","to_journal_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_entry_number_unique" ON "journal_lines" USING btree ("journal_entry_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_org_id_unique" ON "journal_lines" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_type_key_version_unique" ON "journal_type_definitions" USING btree ("key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "source_documents_org_type_number_version_unique" ON "source_documents" USING btree ("organization_id","source_type","source_number","version");--> statement-breakpoint
CREATE UNIQUE INDEX "source_documents_org_id_unique" ON "source_documents" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_combinations_org_id_unique" ON "account_combinations" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_periods_ledger_number_unique" ON "fiscal_periods" USING btree ("ledger_id","fiscal_year","period_number");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_periods_org_id_unique" ON "fiscal_periods" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "gl_accounts_ledger_code_unique" ON "gl_accounts" USING btree ("ledger_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "gl_accounts_org_id_unique" ON "gl_accounts" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledgers_org_code_unique" ON "ledgers" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "ledgers_org_id_unique" ON "ledgers" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_entities_org_code_unique" ON "legal_entities" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_entities_org_id_unique" ON "legal_entities" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "segment_definitions_org_key_unique" ON "segment_definitions" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "segment_definitions_org_ordinal_unique" ON "segment_definitions" USING btree ("organization_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "segment_values_definition_code_unique" ON "segment_values" USING btree ("definition_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "segment_values_org_id_unique" ON "segment_values" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "open_items_org_id_unique" ON "open_items" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "parties_org_number_unique" ON "parties" USING btree ("organization_id","party_number");--> statement-breakpoint
CREATE UNIQUE INDEX "parties_org_id_unique" ON "parties" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_accounts_entity_role_number_unique" ON "party_accounts" USING btree ("legal_entity_id","role","account_number");--> statement-breakpoint
CREATE UNIQUE INDEX "party_accounts_org_id_unique" ON "party_accounts" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_addresses_org_id_unique" ON "party_addresses" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "subledger_events_org_id_unique" ON "subledger_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_tax_registrations_org_id_unique" ON "entity_tax_registrations" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_determination_snapshots_org_id_unique" ON "tax_determination_snapshots" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_pack_versions_key_version_unique" ON "tax_pack_versions" USING btree ("pack_key","version");