ALTER TABLE "email_ingestion_aliases" ADD COLUMN "owner_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "email_ingestion_aliases" ADD CONSTRAINT "email_ingestion_aliases_tenant_owner_membership_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_ingestion_aliases_active_personal_owner_unique" ON "email_ingestion_aliases" USING btree ("organization_id","owner_membership_id") WHERE "email_ingestion_aliases"."owner_membership_id" IS NOT NULL AND "email_ingestion_aliases"."status" = 'ACTIVE';--> statement-breakpoint

ALTER TABLE email_ingestion_aliases ADD CONSTRAINT email_ingestion_aliases_personal_owner_check
  CHECK (owner_membership_id IS NULL OR purpose='GENERAL');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.resolve_inbound_email_alias(selected_address_digest text)
RETURNS TABLE(organization_id uuid,alias_id uuid,actor_id uuid,legal_entity_id uuid,connection_id uuid,purpose text,hourly_limit integer,max_payload_bytes integer)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT alias.organization_id,alias.id,actor_membership.user_id,alias.legal_entity_id,alias.connection_id,
    alias.purpose,alias.hourly_limit,alias.max_payload_bytes
  FROM email_ingestion_aliases alias
  JOIN organizations organization ON organization.id=alias.organization_id
  JOIN organization_memberships actor_membership ON actor_membership.organization_id=alias.organization_id
    AND actor_membership.active
    AND ((alias.owner_membership_id IS NOT NULL AND actor_membership.id=alias.owner_membership_id)
      OR (alias.owner_membership_id IS NULL AND actor_membership.user_id=alias.created_by))
  JOIN users actor ON actor.id=actor_membership.user_id AND actor.active
  WHERE alias.address_digest=selected_address_digest AND alias.status='ACTIVE'
    AND organization.active AND organization.organization_mode='REAL' AND organization.writes_enabled_at IS NOT NULL
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.resolve_inbound_email_alias(text) FROM PUBLIC;
--> statement-breakpoint

-- Runtime cannot read users or lock identity rows directly. Keep the
-- active-user check and revocation fence inside this tenant/actor-bound helper.
CREATE FUNCTION app.lock_active_email_membership(selected_membership_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM 1
  FROM organization_memberships membership
  JOIN users actor ON actor.id=membership.user_id AND actor.active
  JOIN organizations organization ON organization.id=membership.organization_id
  WHERE membership.organization_id=app.current_organization_id()
    AND membership.user_id=app.current_actor_id()
    AND (selected_membership_id IS NULL OR membership.id=selected_membership_id)
    AND membership.active AND organization.active
    AND NOT organization.is_demo AND organization.organization_mode='REAL'
  FOR SHARE OF membership,actor;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION app.lock_active_email_membership(uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='business_finlynq_app') THEN
    GRANT EXECUTE ON FUNCTION app.lock_active_email_membership(uuid) TO business_finlynq_app;
  END IF;
END $$;
