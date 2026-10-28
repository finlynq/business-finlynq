ALTER TABLE "inbound_email_attachments" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_email_attachments" ADD COLUMN "error_stage" text;--> statement-breakpoint
ALTER TABLE "inbound_email_messages" ADD COLUMN "processing_token" uuid;--> statement-breakpoint
ALTER TABLE "inbound_email_messages" ADD COLUMN "processing_expires_at" timestamp with time zone;
--> statement-breakpoint

-- Only the table owner can perform the queue's cross-tenant routing lookup.
-- Runtime reads and all document operations retain their tenant RLS policies.
CREATE POLICY email_queue_owner_read ON inbound_email_messages FOR SELECT
  USING (current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.inbound_email_messages'::regclass)));
CREATE POLICY email_queue_owner_read ON email_ingestion_aliases FOR SELECT
  USING (current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.email_ingestion_aliases'::regclass)));
--> statement-breakpoint

CREATE FUNCTION app.due_inbound_email_retries(batch_size integer)
RETURNS TABLE(organization_id uuid,message_id uuid,actor_id uuid,provider text)
LANGUAGE plpgsql SECURITY DEFINER
SET app.organization_id=''
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  candidate record;
  resolved_actor uuid;
  emitted integer := 0;
BEGIN
  FOR candidate IN
    SELECT message.organization_id,message.id,message.provider,alias.owner_membership_id,alias.created_by
    FROM inbound_email_messages message
    JOIN email_ingestion_aliases alias ON alias.organization_id=message.organization_id AND alias.id=message.alias_id
    WHERE message.status='RETRY_PENDING' AND alias.status='ACTIVE'
      AND (message.next_retry_at IS NULL OR message.next_retry_at<=now())
      AND (message.processing_expires_at IS NULL OR message.processing_expires_at<=now())
    ORDER BY message.next_retry_at NULLS FIRST,message.created_at,message.id
  LOOP
    -- Check membership under this job's existing tenant policy. The SET clause
    -- restores the caller's original organization setting on return or error.
    PERFORM set_config('app.organization_id',candidate.organization_id::text,true);
    SELECT member.user_id INTO resolved_actor
    FROM organization_memberships member
    JOIN organizations organization ON organization.id=member.organization_id
    JOIN users actor ON actor.id=member.user_id AND actor.active
    WHERE member.organization_id=candidate.organization_id AND member.active
      AND ((candidate.owner_membership_id IS NOT NULL AND member.id=candidate.owner_membership_id)
        OR (candidate.owner_membership_id IS NULL AND member.user_id=candidate.created_by))
      AND organization.active AND NOT organization.is_demo AND organization.organization_mode='REAL'
      AND organization.writes_enabled_at IS NOT NULL;
    IF resolved_actor IS NOT NULL THEN
      organization_id := candidate.organization_id;
      message_id := candidate.id;
      actor_id := resolved_actor;
      provider := candidate.provider;
      RETURN NEXT;
      emitted := emitted+1;
      EXIT WHEN emitted>=greatest(1,least(coalesce(batch_size,10),10));
    END IF;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION app.due_inbound_email_retries(integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='business_finlynq_app') THEN
    GRANT EXECUTE ON FUNCTION app.due_inbound_email_retries(integer) TO business_finlynq_app;
  END IF;
END $$;
