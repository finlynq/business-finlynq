ALTER TABLE "document_inbox_items" ADD COLUMN "filing_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD COLUMN "filing_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD COLUMN "filing_token" uuid;--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD COLUMN "filing_queued_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD COLUMN "filing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD COLUMN "filing_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD COLUMN "filing_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD COLUMN "filing_next_retry_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD COLUMN "filing_error_code" text;--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD COLUMN "filing_stage" text;--> statement-breakpoint
CREATE INDEX "document_inbox_filing_due_idx" ON "document_inbox_items" USING btree ("status","filing_next_retry_at","filing_lease_until");--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD CONSTRAINT "document_inbox_filing_attempts_check" CHECK ("document_inbox_items"."filing_attempt_count" BETWEEN 0 AND 6);--> statement-breakpoint
CREATE POLICY filing_queue_owner_read ON document_inbox_items FOR SELECT
  USING (current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.document_inbox_items'::regclass)));
--> statement-breakpoint
CREATE FUNCTION app.due_document_filings(batch_size integer)
RETURNS TABLE(organization_id uuid,item_id uuid,actor_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET app.organization_id=''
SET app.actor_id=''
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE candidate record; emitted integer:=0; blocked_emitted boolean:=false; resolved_actor uuid;
BEGIN
  FOR candidate IN
    SELECT item.organization_id,item.id,item.connection_id,item.owner_module,coalesce(item.filing_actor_id,item.claimed_by) AS requested_actor
    FROM document_inbox_items item
    WHERE item.status='READY_TO_FILE' AND item.completion_hash IS NOT NULL
      AND (item.filing_next_retry_at IS NULL OR item.filing_next_retry_at<=now())
      AND (item.filing_lease_until IS NULL OR item.filing_lease_until<=now())
      AND (SELECT count(*) FROM document_inbox_items active WHERE active.organization_id=item.organization_id AND active.connection_id=item.connection_id AND active.filing_token IS NOT NULL AND active.filing_lease_until>now())<3
    ORDER BY item.filing_next_retry_at NULLS FIRST,item.filing_queued_at NULLS FIRST,item.id
  LOOP
    PERFORM set_config('app.organization_id',candidate.organization_id::text,true);
    PERFORM set_config('app.actor_id',coalesce(candidate.requested_actor::text,''),true);
    SELECT member.user_id INTO resolved_actor FROM organization_memberships member
      JOIN users actor ON actor.id=member.user_id AND actor.active
      JOIN organizations organization ON organization.id=member.organization_id
      JOIN document_storage_connections connection ON connection.organization_id=member.organization_id AND connection.id=candidate.connection_id AND connection.active
      WHERE member.organization_id=candidate.organization_id AND member.user_id=candidate.requested_actor AND member.active
        AND organization.active AND NOT organization.is_demo AND organization.organization_mode='REAL' AND organization.writes_enabled_at IS NOT NULL
        AND app.current_actor_has_permission(candidate.owner_module||'.manage');
    IF resolved_actor IS NOT NULL THEN
      organization_id:=candidate.organization_id; item_id:=candidate.id; actor_id:=resolved_actor;
      RETURN NEXT; emitted:=emitted+1;
      EXIT WHEN emitted>=greatest(1,least(coalesce(batch_size,3),10));
    ELSIF NOT blocked_emitted THEN
      -- One minimized blocker per scan; blocked work cannot starve eligible jobs.
      organization_id:=candidate.organization_id; item_id:=candidate.id; actor_id:=NULL;
      RETURN NEXT; blocked_emitted:=true;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.due_document_filings(integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='business_finlynq_app') THEN
    GRANT EXECUTE ON FUNCTION app.due_document_filings(integer) TO business_finlynq_app;
  END IF;
END $$;
