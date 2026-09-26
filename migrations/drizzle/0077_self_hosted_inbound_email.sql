ALTER TABLE "email_ingestion_aliases" ALTER COLUMN "provider" SET DEFAULT 'SELF_SMTP';
--> statement-breakpoint
-- Preserve historical Resend provenance; all newly received mail is SELF_SMTP.
-- Existing opaque aliases remain routable after their domain's MX cutover.
ALTER TABLE email_ingestion_aliases DROP CONSTRAINT email_ingestion_aliases_valid;
ALTER TABLE email_ingestion_aliases ADD CONSTRAINT email_ingestion_aliases_valid CHECK (
  provider IN ('RESEND','SELF_SMTP') AND purpose IN ('PAYABLES','RECEIVABLES','GENERAL')
  AND status IN ('ACTIVE','DISABLED','RETIRED') AND version>0
  AND address_digest ~ '^[a-f0-9]{64}$' AND key_version>0
  AND hourly_limit BETWEEN 1 AND 500 AND max_payload_bytes BETWEEN 1024 AND 26214400
  AND command_hash ~ '^[a-f0-9]{64}$'
  AND ((status='RETIRED')=(retired_at IS NOT NULL))
);
ALTER TABLE inbound_email_messages DROP CONSTRAINT inbound_email_messages_valid;
ALTER TABLE inbound_email_messages ADD CONSTRAINT inbound_email_messages_valid CHECK (
  provider IN ('RESEND','SELF_SMTP') AND key_version>0
  AND status IN ('RECEIVED','STAGED','READY','NEEDS_REVIEW','RETRY_PENDING','QUARANTINED','DEAD_LETTER')
  AND routing_result='ROUTED' AND retry_count BETWEEN 0 AND 5
  AND length(provider_event_id) BETWEEN 1 AND 500 AND length(provider_message_id) BETWEEN 1 AND 500
);
--> statement-breakpoint
-- The relay can deliver unsupported file types. Retain them in quarantine,
-- never acknowledge and discard their bytes or allow them into processing.
ALTER TABLE inbound_email_attachments DROP CONSTRAINT inbound_email_attachments_valid;
ALTER TABLE inbound_email_attachments ADD CONSTRAINT inbound_email_attachments_valid CHECK (
  key_version>0 AND byte_size BETWEEN 1 AND 26214400 AND sha256 ~ '^[a-f0-9]{64}$'
  AND length(mime_type) BETWEEN 1 AND 200
  AND (mime_type IN ('application/pdf','image/png','image/jpeg') OR status IN ('QUARANTINED','DEAD_LETTER'))
  AND evidence_purpose IN ('INVOICE','RECEIPT','SUPPORTING')
  AND status IN ('STAGED','INBOXED','RETRY_PENDING','QUARANTINED','DEAD_LETTER')
  AND (status<>'INBOXED' OR inbox_item_id IS NOT NULL)
);
