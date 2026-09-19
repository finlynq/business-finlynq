CREATE TABLE "email_booking_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inbox_item_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"rule_id" uuid,
	"rule_version" integer,
	"facts_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"source_document_id" uuid,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_delivery_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"outbound_enabled" boolean DEFAULT false NOT NULL,
	"auto_send_enabled" boolean DEFAULT false NOT NULL,
	"transient_retention_days" integer DEFAULT 30 NOT NULL,
	"quarantine_retention_days" integer DEFAULT 30 NOT NULL,
	"operation_retention_days" integer DEFAULT 90 NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_email_messages" ALTER COLUMN "envelope_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingestion_aliases" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingestion_aliases" ADD COLUMN "command_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_invoice_pdf_artifacts" ADD COLUMN "render_facts_ciphertext" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_invoice_pdf_artifacts" ADD COLUMN "key_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "email_booking_evaluations" ADD CONSTRAINT "email_booking_evaluations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_booking_evaluations" ADD CONSTRAINT "email_booking_evaluations_tenant_inbox_fk" FOREIGN KEY ("organization_id","inbox_item_id") REFERENCES "public"."document_inbox_items"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_booking_evaluations" ADD CONSTRAINT "email_booking_evaluations_tenant_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."inbound_email_messages"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_booking_evaluations" ADD CONSTRAINT "email_booking_evaluations_tenant_rule_fk" FOREIGN KEY ("organization_id","rule_id") REFERENCES "public"."email_booking_rules"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_booking_evaluations" ADD CONSTRAINT "email_booking_evaluations_tenant_source_fk" FOREIGN KEY ("organization_id","source_document_id") REFERENCES "public"."source_documents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_delivery_settings" ADD CONSTRAINT "email_delivery_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_booking_evaluations_org_id_unique" ON "email_booking_evaluations" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_booking_evaluations_idempotency_unique" ON "email_booking_evaluations" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "email_booking_evaluations_inbox_idx" ON "email_booking_evaluations" USING btree ("organization_id","inbox_item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_settings_org_unique" ON "email_delivery_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_settings_org_id_unique" ON "email_delivery_settings" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_ingestion_aliases_idempotency_unique" ON "email_ingestion_aliases" USING btree ("organization_id","idempotency_key");
--> statement-breakpoint

ALTER TABLE email_ingestion_aliases ADD CONSTRAINT email_ingestion_aliases_valid CHECK (
  provider='RESEND' AND purpose IN ('PAYABLES','RECEIVABLES','GENERAL')
  AND status IN ('ACTIVE','DISABLED','RETIRED') AND version>0
  AND address_digest ~ '^[a-f0-9]{64}$' AND key_version>0
  AND hourly_limit BETWEEN 1 AND 500 AND max_payload_bytes BETWEEN 1024 AND 26214400
  AND command_hash ~ '^[a-f0-9]{64}$'
  AND ((status='RETIRED')=(retired_at IS NOT NULL))
);
ALTER TABLE email_ingestion_aliases ADD CONSTRAINT email_ingestion_aliases_connection_fk
  FOREIGN KEY (organization_id,connection_id) REFERENCES document_storage_connections(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE inbound_email_messages ADD CONSTRAINT inbound_email_messages_valid CHECK (
  provider='RESEND' AND key_version>0
  AND status IN ('RECEIVED','STAGED','READY','NEEDS_REVIEW','RETRY_PENDING','QUARANTINED','DEAD_LETTER')
  AND routing_result IN ('ROUTED') AND retry_count BETWEEN 0 AND 5
  AND length(provider_event_id) BETWEEN 1 AND 500 AND length(provider_message_id) BETWEEN 1 AND 500
);
ALTER TABLE inbound_email_attachments ADD CONSTRAINT inbound_email_attachments_valid CHECK (
  key_version>0 AND byte_size BETWEEN 1 AND 26214400 AND sha256 ~ '^[a-f0-9]{64}$'
  AND mime_type IN ('application/pdf','image/png','image/jpeg')
  AND evidence_purpose IN ('INVOICE','RECEIPT','SUPPORTING')
  AND status IN ('STAGED','INBOXED','RETRY_PENDING','QUARANTINED','DEAD_LETTER')
  AND (status<>'INBOXED' OR inbox_item_id IS NOT NULL)
);
ALTER TABLE email_booking_rules ADD CONSTRAINT email_booking_rules_valid CHECK (
  version>0 AND priority BETWEEN 1 AND 10000
  AND mode IN ('REVIEW_ONLY','CREATE_DRAFT','AUTO_POST')
  AND jsonb_typeof(conditions)='object' AND jsonb_typeof(action)='object'
  AND command_hash ~ '^[a-f0-9]{64}$'
);
ALTER TABLE email_delivery_settings ADD CONSTRAINT email_delivery_settings_valid CHECK (
  version>0 AND (outbound_enabled OR NOT auto_send_enabled)
  AND transient_retention_days BETWEEN 1 AND 365
  AND quarantine_retention_days BETWEEN 1 AND 365
  AND operation_retention_days BETWEEN 7 AND 2555
);
ALTER TABLE email_booking_evaluations ADD CONSTRAINT email_booking_evaluations_valid CHECK (
  key_version>0 AND outcome IN ('REVIEW','CREATE_DRAFT','AUTO_POST')
  AND command_hash ~ '^[a-f0-9]{64}$'
  AND ((rule_id IS NULL AND rule_version IS NULL) OR (rule_id IS NOT NULL AND rule_version>0))
);
ALTER TABLE payment_instruction_profiles ADD CONSTRAINT payment_instruction_profiles_valid CHECK (
  currency_code ~ '^[A-Z]{3}$' AND version>0 AND key_version>0
  AND (effective_to IS NULL OR effective_to>=effective_from)
);
ALTER TABLE customer_delivery_preferences ADD CONSTRAINT customer_delivery_preferences_valid CHECK (
  version>0 AND key_version>0 AND delivery_method IN ('EMAIL','MANUAL')
  AND suppression_status IN ('NONE','HARD_BOUNCE','COMPLAINT')
);
ALTER TABLE sales_invoice_pdf_artifacts ADD CONSTRAINT sales_invoice_pdf_artifacts_valid CHECK (
  source_version>0 AND source_content_hash ~ '^[a-f0-9]{64}$' AND sha256 ~ '^[a-f0-9]{64}$'
  AND key_version>0 AND jsonb_typeof(render_facts)='object'
  AND ((payment_profile_id IS NULL AND payment_profile_version IS NULL)
    OR (payment_profile_id IS NOT NULL AND payment_profile_version>0))
);
ALTER TABLE invoice_delivery_attempts ADD CONSTRAINT invoice_delivery_attempts_valid CHECK (
  source_version>0 AND source_content_hash ~ '^[a-f0-9]{64}$' AND provider='RESEND'
  AND key_version>0 AND command_hash ~ '^[a-f0-9]{64}$'
  AND status IN ('QUEUED','SENT','DELIVERED','BOUNCED','COMPLAINED','FAILED')
  AND retry_count BETWEEN 0 AND 5
);
ALTER TABLE invoice_delivery_events ADD CONSTRAINT invoice_delivery_events_valid CHECK (
  event_type IN ('email.sent','email.delivered','email.bounced','email.complained','email.failed')
  AND jsonb_typeof(payload_summary)='object'
);
ALTER TABLE email_operation_events ADD CONSTRAINT email_operation_events_valid CHECK (
  category IN ('INBOUND','ATTACHMENT','BOOKING','PDF','DELIVERY','QUARANTINE','RETENTION','SECURITY')
  AND outcome IN ('READY','NEEDS_REVIEW','RETRY_PENDING','QUARANTINED','AUTHORIZED','SUCCEEDED','FAILED','REJECTED')
  AND jsonb_typeof(safe_details)='object'
);
CREATE UNIQUE INDEX invoice_delivery_attempts_provider_message_unique
  ON invoice_delivery_attempts(provider,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX payment_instruction_profiles_active_default_unique
  ON payment_instruction_profiles(organization_id,legal_entity_id,currency_code)
  WHERE active AND is_default;
--> statement-breakpoint

ALTER TABLE email_ingestion_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_ingestion_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_ingestion_aliases
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('organization.settings.read') OR app.current_actor_has_permission('organization.settings.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_has_permission('organization.settings.manage'));
ALTER TABLE email_booking_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_booking_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_booking_rules
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('organization.settings.read') OR app.current_actor_has_permission('organization.settings.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_has_permission('organization.settings.manage'));
ALTER TABLE email_delivery_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_delivery_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_delivery_settings
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('organization.settings.read') OR app.current_actor_has_permission('organization.settings.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_has_permission('organization.settings.manage'));
ALTER TABLE payment_instruction_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_instruction_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_instruction_profiles
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('organization.settings.read') OR app.current_actor_has_permission('organization.settings.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_has_permission('organization.settings.manage'));
ALTER TABLE customer_delivery_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_delivery_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_delivery_preferences
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('receivables.read') OR app.current_actor_has_permission('receivables.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_has_permission('receivables.manage'));
ALTER TABLE inbound_email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_email_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inbound_email_messages
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('payables.read') OR app.current_actor_has_permission('payables.manage') OR app.current_actor_has_permission('receivables.read') OR app.current_actor_has_permission('receivables.manage') OR app.current_actor_has_permission('organization.settings.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('payables.manage') OR app.current_actor_has_permission('receivables.manage') OR app.current_actor_has_permission('organization.settings.manage')));
ALTER TABLE inbound_email_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_email_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inbound_email_attachments
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('payables.read') OR app.current_actor_has_permission('payables.manage') OR app.current_actor_has_permission('receivables.read') OR app.current_actor_has_permission('receivables.manage') OR app.current_actor_has_permission('organization.settings.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('payables.manage') OR app.current_actor_has_permission('receivables.manage') OR app.current_actor_has_permission('organization.settings.manage')));
ALTER TABLE email_booking_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_booking_evaluations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_booking_evaluations
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('payables.read') OR app.current_actor_has_permission('payables.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_has_permission('payables.manage'));
ALTER TABLE sales_invoice_pdf_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoice_pdf_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales_invoice_pdf_artifacts
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('receivables.read') OR app.current_actor_has_permission('receivables.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_has_permission('receivables.manage'));
ALTER TABLE invoice_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_delivery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_delivery_attempts
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('receivables.read') OR app.current_actor_has_permission('receivables.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_has_permission('receivables.manage'));
ALTER TABLE invoice_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_delivery_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_delivery_events
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('receivables.read') OR app.current_actor_has_permission('receivables.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_has_permission('receivables.manage'));
ALTER TABLE email_operation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_operation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_operation_events
  USING (organization_id=app.current_organization_id() AND (app.current_actor_has_permission('organization.settings.read') OR app.current_actor_has_permission('organization.settings.manage')))
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_has_permission('organization.settings.manage'));
--> statement-breakpoint

CREATE FUNCTION app.resolve_inbound_email_alias(selected_address_digest text)
RETURNS TABLE(organization_id uuid,alias_id uuid,actor_id uuid,legal_entity_id uuid,connection_id uuid,purpose text,hourly_limit integer,max_payload_bytes integer)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT alias.organization_id,alias.id,alias.created_by,alias.legal_entity_id,alias.connection_id,
    alias.purpose,alias.hourly_limit,alias.max_payload_bytes
  FROM email_ingestion_aliases alias
  JOIN organizations organization ON organization.id=alias.organization_id
  JOIN organization_memberships membership ON membership.organization_id=alias.organization_id
    AND membership.user_id=alias.created_by AND membership.active
  WHERE alias.address_digest=selected_address_digest AND alias.status='ACTIVE'
    AND organization.active AND organization.organization_mode='REAL' AND organization.writes_enabled_at IS NOT NULL
  LIMIT 1
$$;
CREATE FUNCTION app.resolve_outbound_email_attempt(selected_provider_message_id text)
RETURNS TABLE(organization_id uuid,attempt_id uuid,actor_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT attempt.organization_id,attempt.id,attempt.created_by
  FROM invoice_delivery_attempts attempt
  JOIN organizations organization ON organization.id=attempt.organization_id
  JOIN organization_memberships membership ON membership.organization_id=attempt.organization_id
    AND membership.user_id=attempt.created_by AND membership.active
  WHERE attempt.provider='RESEND' AND attempt.provider_message_id=selected_provider_message_id
    AND organization.active AND organization.organization_mode='REAL'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.resolve_inbound_email_alias(text),app.resolve_outbound_email_attempt(text) FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER email_booking_rules_append_only BEFORE UPDATE OR DELETE ON email_booking_rules
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE TRIGGER sales_invoice_pdf_artifacts_append_only BEFORE UPDATE OR DELETE ON sales_invoice_pdf_artifacts
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE TRIGGER invoice_delivery_events_append_only BEFORE UPDATE OR DELETE ON invoice_delivery_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE TRIGGER email_booking_evaluations_no_delete BEFORE DELETE ON email_booking_evaluations
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE TRIGGER email_operation_events_no_delete BEFORE DELETE ON email_operation_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE TRIGGER inbound_email_messages_no_delete BEFORE DELETE ON inbound_email_messages
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE TRIGGER inbound_email_attachments_no_delete BEFORE DELETE ON inbound_email_attachments
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE TRIGGER invoice_delivery_attempts_no_delete BEFORE DELETE ON invoice_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE TRIGGER payment_instruction_profiles_no_delete BEFORE DELETE ON payment_instruction_profiles
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE TRIGGER customer_delivery_preferences_no_delete BEFORE DELETE ON customer_delivery_preferences
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE TRIGGER email_delivery_settings_no_delete BEFORE DELETE ON email_delivery_settings
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
CREATE TRIGGER email_ingestion_aliases_no_delete BEFORE DELETE ON email_ingestion_aliases
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only_source_record();
--> statement-breakpoint

INSERT INTO audit_outbox_pair_contract(audit_action,outbox_topic,aggregate_type,contract_version)
VALUES
  ('email-alias.changed','email-alias.changed','email_ingestion_alias','business-audit-outbox-v1'),
  ('email-booking-rule.created','email-booking-rule.created','email_booking_rule','business-audit-outbox-v1'),
  ('payment-profile.changed','payment-profile.changed','payment_instruction_profile','business-audit-outbox-v1'),
  ('customer-delivery.changed','customer-delivery.changed','customer_delivery_preference','business-audit-outbox-v1'),
  ('email-delivery-settings.changed','email-delivery-settings.changed','email_delivery_settings','business-audit-outbox-v1'),
  ('invoice-pdf.generated','invoice-pdf.generated','sales_invoice_pdf_artifact','business-audit-outbox-v1'),
  ('invoice-delivery.changed','invoice-delivery.changed','invoice_delivery_attempt','business-audit-outbox-v1')
ON CONFLICT DO NOTHING;
CREATE FUNCTION app.audit_email_automation_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected_action text; selected_type text;
BEGIN
  selected_action := CASE TG_TABLE_NAME
    WHEN 'email_ingestion_aliases' THEN 'email-alias.changed'
    WHEN 'email_booking_rules' THEN 'email-booking-rule.created'
    WHEN 'payment_instruction_profiles' THEN 'payment-profile.changed'
    WHEN 'customer_delivery_preferences' THEN 'customer-delivery.changed'
    WHEN 'email_delivery_settings' THEN 'email-delivery-settings.changed'
    WHEN 'sales_invoice_pdf_artifacts' THEN 'invoice-pdf.generated'
    WHEN 'invoice_delivery_attempts' THEN 'invoice-delivery.changed' END;
  selected_type := CASE TG_TABLE_NAME
    WHEN 'email_ingestion_aliases' THEN 'email_ingestion_alias'
    WHEN 'email_booking_rules' THEN 'email_booking_rule'
    WHEN 'payment_instruction_profiles' THEN 'payment_instruction_profile'
    WHEN 'customer_delivery_preferences' THEN 'customer_delivery_preference'
    WHEN 'email_delivery_settings' THEN 'email_delivery_settings'
    WHEN 'sales_invoice_pdf_artifacts' THEN 'sales_invoice_pdf_artifact'
    WHEN 'invoice_delivery_attempts' THEN 'invoice_delivery_attempt' END;
  PERFORM app.append_tenant_business_audit(NEW.organization_id,selected_action,selected_type,NEW.id::text,
    jsonb_build_object('operation',TG_OP,'status',to_jsonb(NEW)->>'status','version',to_jsonb(NEW)->>'version'),selected_action);
  RETURN NEW;
END $$;
--> statement-breakpoint

INSERT INTO demo_sandbox_reset_tables(table_name,purge_order)
SELECT reset_table.table_name,reset_state.maximum_order+reset_table.ordinal::integer
FROM (SELECT coalesce(max(purge_order),0) AS maximum_order FROM demo_sandbox_reset_tables) reset_state
CROSS JOIN unnest(ARRAY[
  'invoice_delivery_events','invoice_delivery_attempts','sales_invoice_pdf_artifacts',
  'email_booking_evaluations','inbound_email_attachments','inbound_email_messages',
  'customer_delivery_preferences','payment_instruction_profiles','email_booking_rules',
  'email_delivery_settings','email_operation_events','email_ingestion_aliases'
]::text[]) WITH ORDINALITY AS reset_table(table_name,ordinal);
CREATE TRIGGER email_ingestion_aliases_audit AFTER INSERT OR UPDATE ON email_ingestion_aliases FOR EACH ROW EXECUTE FUNCTION app.audit_email_automation_change();
CREATE TRIGGER email_booking_rules_audit AFTER INSERT ON email_booking_rules FOR EACH ROW EXECUTE FUNCTION app.audit_email_automation_change();
CREATE TRIGGER payment_instruction_profiles_audit AFTER INSERT OR UPDATE ON payment_instruction_profiles FOR EACH ROW EXECUTE FUNCTION app.audit_email_automation_change();
CREATE TRIGGER customer_delivery_preferences_audit AFTER INSERT OR UPDATE ON customer_delivery_preferences FOR EACH ROW EXECUTE FUNCTION app.audit_email_automation_change();
CREATE TRIGGER email_delivery_settings_audit AFTER INSERT OR UPDATE ON email_delivery_settings FOR EACH ROW EXECUTE FUNCTION app.audit_email_automation_change();
CREATE TRIGGER sales_invoice_pdf_artifacts_audit AFTER INSERT ON sales_invoice_pdf_artifacts FOR EACH ROW EXECUTE FUNCTION app.audit_email_automation_change();
CREATE TRIGGER invoice_delivery_attempts_audit AFTER INSERT OR UPDATE ON invoice_delivery_attempts FOR EACH ROW EXECUTE FUNCTION app.audit_email_automation_change();
REVOKE ALL ON FUNCTION app.audit_email_automation_change() FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON email_ingestion_aliases,inbound_email_messages,inbound_email_attachments,email_booking_rules,
  email_booking_evaluations,email_delivery_settings,payment_instruction_profiles,customer_delivery_preferences,
  sales_invoice_pdf_artifacts,invoice_delivery_attempts,invoice_delivery_events,email_operation_events FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='business_finlynq_app') THEN
    GRANT SELECT ON email_ingestion_aliases,inbound_email_messages,inbound_email_attachments,email_booking_rules,
      email_booking_evaluations,email_delivery_settings,payment_instruction_profiles,customer_delivery_preferences,
      sales_invoice_pdf_artifacts,invoice_delivery_attempts,invoice_delivery_events,email_operation_events TO business_finlynq_app;
    GRANT INSERT,UPDATE ON email_ingestion_aliases,inbound_email_messages,inbound_email_attachments,
      email_booking_evaluations,email_delivery_settings,payment_instruction_profiles,customer_delivery_preferences,
      invoice_delivery_attempts,email_operation_events TO business_finlynq_app;
    GRANT INSERT ON email_booking_rules,sales_invoice_pdf_artifacts,invoice_delivery_events TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.resolve_inbound_email_alias(text),app.resolve_outbound_email_attempt(text) TO business_finlynq_app;
  END IF;
END $$;
