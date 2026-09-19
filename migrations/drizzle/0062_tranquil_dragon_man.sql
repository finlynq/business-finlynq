CREATE TABLE "customer_delivery_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_account_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"preferences_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"delivery_method" text DEFAULT 'EMAIL' NOT NULL,
	"auto_send_on_issue" boolean DEFAULT false NOT NULL,
	"payment_profile_id" uuid,
	"suppression_status" text DEFAULT 'NONE' NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_booking_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"mode" text DEFAULT 'REVIEW_ONLY' NOT NULL,
	"conditions" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_ingestion_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"connection_id" uuid,
	"provider" text DEFAULT 'RESEND' NOT NULL,
	"label" text NOT NULL,
	"purpose" text DEFAULT 'PAYABLES' NOT NULL,
	"address_digest" text NOT NULL,
	"address_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"hourly_limit" integer DEFAULT 25 NOT NULL,
	"max_payload_bytes" integer DEFAULT 10485760 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_operation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category" text NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_id" uuid,
	"outcome" text NOT NULL,
	"safe_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_email_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"attachment_key" text NOT NULL,
	"filename_ciphertext" text NOT NULL,
	"content_ciphertext" text,
	"key_version" integer NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"page_count" integer,
	"evidence_purpose" text DEFAULT 'INVOICE' NOT NULL,
	"status" text DEFAULT 'STAGED' NOT NULL,
	"quarantine_code" text,
	"inbox_item_id" uuid,
	"evidence_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"alias_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"sender_auth" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"envelope_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"routing_result" text NOT NULL,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"error_code" text,
	"transient_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"source_content_hash" text NOT NULL,
	"pdf_artifact_id" uuid NOT NULL,
	"provider" text DEFAULT 'RESEND' NOT NULL,
	"provider_message_id" text,
	"recipients_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"template_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"failure_code" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"manual_resend" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"payload_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_instruction_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"currency_code" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"details_ciphertext" text NOT NULL,
	"masked_summary" jsonb NOT NULL,
	"key_version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"retired_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_invoice_pdf_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"source_content_hash" text NOT NULL,
	"template_version" text NOT NULL,
	"payment_profile_id" uuid,
	"payment_profile_version" integer,
	"asset_id" uuid NOT NULL,
	"preview" boolean DEFAULT false NOT NULL,
	"sha256" text NOT NULL,
	"render_facts" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_delivery_preferences_org_id_unique" ON "customer_delivery_preferences" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_booking_rules_org_id_unique" ON "email_booking_rules" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_ingestion_aliases_org_id_unique" ON "email_ingestion_aliases" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_operation_events_org_id_unique" ON "email_operation_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_email_attachments_org_id_unique" ON "inbound_email_attachments" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_email_messages_org_id_unique" ON "inbound_email_messages" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_delivery_attempts_org_id_unique" ON "invoice_delivery_attempts" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_delivery_events_org_id_unique" ON "invoice_delivery_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_instruction_profiles_org_id_unique" ON "payment_instruction_profiles" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoice_pdf_artifacts_org_id_unique" ON "sales_invoice_pdf_artifacts" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "customer_delivery_preferences" ADD CONSTRAINT "customer_delivery_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_delivery_preferences" ADD CONSTRAINT "customer_delivery_preferences_tenant_account_fk" FOREIGN KEY ("organization_id","party_account_id") REFERENCES "public"."party_accounts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_delivery_preferences" ADD CONSTRAINT "customer_delivery_preferences_tenant_profile_fk" FOREIGN KEY ("organization_id","payment_profile_id") REFERENCES "public"."payment_instruction_profiles"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_booking_rules" ADD CONSTRAINT "email_booking_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_ingestion_aliases" ADD CONSTRAINT "email_ingestion_aliases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_ingestion_aliases" ADD CONSTRAINT "email_ingestion_aliases_tenant_entity_fk" FOREIGN KEY ("organization_id","legal_entity_id") REFERENCES "public"."legal_entities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_operation_events" ADD CONSTRAINT "email_operation_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_email_attachments" ADD CONSTRAINT "inbound_email_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_email_attachments" ADD CONSTRAINT "inbound_email_attachments_tenant_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."inbound_email_messages"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_email_attachments" ADD CONSTRAINT "inbound_email_attachments_tenant_inbox_fk" FOREIGN KEY ("organization_id","inbox_item_id") REFERENCES "public"."document_inbox_items"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_email_attachments" ADD CONSTRAINT "inbound_email_attachments_tenant_evidence_fk" FOREIGN KEY ("organization_id","evidence_asset_id") REFERENCES "public"."document_evidence_assets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_email_messages" ADD CONSTRAINT "inbound_email_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_email_messages" ADD CONSTRAINT "inbound_email_messages_tenant_alias_fk" FOREIGN KEY ("organization_id","alias_id") REFERENCES "public"."email_ingestion_aliases"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_delivery_attempts" ADD CONSTRAINT "invoice_delivery_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_delivery_attempts" ADD CONSTRAINT "invoice_delivery_attempts_tenant_source_fk" FOREIGN KEY ("organization_id","source_document_id") REFERENCES "public"."source_documents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_delivery_attempts" ADD CONSTRAINT "invoice_delivery_attempts_tenant_pdf_fk" FOREIGN KEY ("organization_id","pdf_artifact_id") REFERENCES "public"."sales_invoice_pdf_artifacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_delivery_events" ADD CONSTRAINT "invoice_delivery_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_delivery_events" ADD CONSTRAINT "invoice_delivery_events_tenant_attempt_fk" FOREIGN KEY ("organization_id","attempt_id") REFERENCES "public"."invoice_delivery_attempts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_instruction_profiles" ADD CONSTRAINT "payment_instruction_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_instruction_profiles" ADD CONSTRAINT "payment_instruction_profiles_tenant_entity_fk" FOREIGN KEY ("organization_id","legal_entity_id") REFERENCES "public"."legal_entities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoice_pdf_artifacts" ADD CONSTRAINT "sales_invoice_pdf_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoice_pdf_artifacts" ADD CONSTRAINT "sales_invoice_pdf_artifacts_tenant_source_fk" FOREIGN KEY ("organization_id","source_document_id") REFERENCES "public"."source_documents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoice_pdf_artifacts" ADD CONSTRAINT "sales_invoice_pdf_artifacts_tenant_asset_fk" FOREIGN KEY ("organization_id","asset_id") REFERENCES "public"."document_evidence_assets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoice_pdf_artifacts" ADD CONSTRAINT "sales_invoice_pdf_artifacts_tenant_profile_fk" FOREIGN KEY ("organization_id","payment_profile_id") REFERENCES "public"."payment_instruction_profiles"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_delivery_preferences_account_unique" ON "customer_delivery_preferences" USING btree ("organization_id","party_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_booking_rules_name_version_unique" ON "email_booking_rules" USING btree ("organization_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "email_booking_rules_idempotency_unique" ON "email_booking_rules" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "email_booking_rules_active_idx" ON "email_booking_rules" USING btree ("organization_id","active","priority","id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_ingestion_aliases_address_unique" ON "email_ingestion_aliases" USING btree ("address_digest");--> statement-breakpoint
CREATE INDEX "email_ingestion_aliases_org_status_idx" ON "email_ingestion_aliases" USING btree ("organization_id","status","id");--> statement-breakpoint
CREATE INDEX "email_operation_events_dashboard_idx" ON "email_operation_events" USING btree ("organization_id","category","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_email_attachments_message_key_unique" ON "inbound_email_attachments" USING btree ("message_id","attachment_key");--> statement-breakpoint
CREATE INDEX "inbound_email_attachments_checksum_idx" ON "inbound_email_attachments" USING btree ("organization_id","sha256");--> statement-breakpoint
CREATE INDEX "inbound_email_attachments_ops_idx" ON "inbound_email_attachments" USING btree ("organization_id","status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_email_messages_event_alias_unique" ON "inbound_email_messages" USING btree ("provider","provider_event_id","alias_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_email_messages_message_alias_unique" ON "inbound_email_messages" USING btree ("provider","provider_message_id","alias_id");--> statement-breakpoint
CREATE INDEX "inbound_email_messages_ops_idx" ON "inbound_email_messages" USING btree ("organization_id","status","next_retry_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_delivery_attempts_idempotency_unique" ON "invoice_delivery_attempts" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "invoice_delivery_attempts_source_idx" ON "invoice_delivery_attempts" USING btree ("organization_id","source_document_id","created_at");--> statement-breakpoint
CREATE INDEX "invoice_delivery_attempts_ops_idx" ON "invoice_delivery_attempts" USING btree ("organization_id","status","next_retry_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_delivery_events_provider_event_unique" ON "invoice_delivery_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "invoice_delivery_events_attempt_idx" ON "invoice_delivery_events" USING btree ("organization_id","attempt_id","event_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_instruction_profiles_name_version_unique" ON "payment_instruction_profiles" USING btree ("organization_id","legal_entity_id","currency_code","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_instruction_profiles_idempotency_unique" ON "payment_instruction_profiles" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_instruction_profiles_lookup_idx" ON "payment_instruction_profiles" USING btree ("organization_id","legal_entity_id","currency_code","active");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoice_pdf_artifacts_source_unique_v1" ON "sales_invoice_pdf_artifacts" USING btree ("organization_id","source_document_id","source_version","source_content_hash","template_version","preview");
