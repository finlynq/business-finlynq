CREATE TABLE "auth_login_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"realm" text NOT NULL,
	"security_epoch" integer NOT NULL,
	"kind" text NOT NULL,
	"context_key" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_login_contexts_kind_check" CHECK ("auth_login_contexts"."kind" IN ('DEVICE','COUNTRY','LOCATION')),
	CONSTRAINT "auth_login_contexts_epoch_check" CHECK ("auth_login_contexts"."security_epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "auth_login_notification_decisions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"email_queued" boolean NOT NULL,
	"reasons" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_login_contexts" ADD CONSTRAINT "auth_login_contexts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_login_contexts" ADD CONSTRAINT "auth_login_contexts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_login_notification_decisions" ADD CONSTRAINT "auth_login_notification_decisions_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_login_notification_decisions" ADD CONSTRAINT "auth_login_notification_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_login_notification_decisions" ADD CONSTRAINT "auth_login_notification_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_login_contexts_scope_key_unique" ON "auth_login_contexts" USING btree ("user_id","organization_id","realm","security_epoch","kind","context_key");
--> statement-breakpoint
-- Recognition is authentication control-plane state, with no runtime grants.
DO $policy$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['auth_login_contexts','auth_login_notification_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (current_user = pg_catalog.pg_get_userbyid((SELECT owner_relation.relowner FROM pg_catalog.pg_class owner_relation WHERE owner_relation.oid = %L::regclass))) WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT owner_relation.relowner FROM pg_catalog.pg_class owner_relation WHERE owner_relation.oid = %L::regclass)))',
      relation_name || '_owner_only_policy', relation_name, 'public.' || relation_name, 'public.' || relation_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', relation_name);
  END LOOP;
END
$policy$;
--> statement-breakpoint

CREATE FUNCTION app.filter_signin_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
  context jsonb;
  selected_session auth_sessions%ROWTYPE;
  epoch integer;
  reasons jsonb := '[]'::jsonb;
  selected_realm text;
  selected_country text;
  selected_region text;
  signal record;
  decision_created uuid;
BEGIN
  IF NEW.template_type <> 'SECURITY_NEW_LOGIN' THEN RETURN NEW; END IF;
  context := coalesce(nullif(current_setting('app.signin_notification_context',true),''),'{}')::jsonb;
  -- Rolling upgrades and legacy callers retain the previous conservative alert.
  IF context = '{}'::jsonb THEN RETURN NEW; END IF;
  selected_realm := context->>'realm';
  IF coalesce(context->>'deviceHash','') !~ '^[0-9a-f]{64}$'
    OR coalesce(context->>'sessionTokenHash','') !~ '^[0-9a-f]{64}$'
    OR coalesce(selected_realm,'') !~ '^(password|oidc:[0-9a-f]{64})$'
    OR length(coalesce(context->>'browserLabel','')) NOT BETWEEN 1 AND 160
    OR context->>'browserLabel' ~ '[[:cntrl:]]'
    OR coalesce(context->>'geoStatus','') NOT IN ('UNAVAILABLE','LOW_CONFIDENCE','COUNTRY_ONLY','COARSE_REGION')
    OR NOT (context ?& ARRAY['deviceHash','sessionTokenHash','realm','browserLabel','geoStatus'])
  THEN RAISE EXCEPTION 'Invalid sign-in notification context' USING ERRCODE='22023'; END IF;

  SELECT session.* INTO selected_session FROM auth_sessions session
  JOIN auth_security_events event ON event.session_id=session.id
    AND event.user_id=session.user_id AND event.organization_id=session.organization_id
    AND event.outcome='SUCCESS' AND event.request_id=NEW.request_id
    AND event.event_type IN ('LOGIN_PASSWORD','LOGIN_MFA','LOGIN_TRUSTED_BROWSER','LOGIN_OIDC')
  WHERE session.token_hash=context->>'sessionTokenHash'
    AND session.user_id=NEW.user_id AND session.organization_id=NEW.organization_id
    AND session.session_mode='REAL' AND session.revoked_at IS NULL
  ORDER BY event.created_at DESC LIMIT 1;
  IF NOT FOUND OR (selected_session.auth_method='OIDC') <> (selected_realm LIKE 'oidc:%') THEN
    RAISE EXCEPTION 'Notification context requires a successful real sign-in' USING ERRCODE='42501';
  END IF;
  SELECT auth_security_epoch INTO epoch FROM users WHERE id=NEW.user_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM auth_login_notification_decisions WHERE session_id=selected_session.id) THEN RETURN NULL; END IF;

  selected_country := context->>'country';
  selected_region := context->>'region';
  IF selected_country IS NOT NULL AND selected_country !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'Invalid notification country' USING ERRCODE='22023';
  END IF;
  IF selected_region IS NOT NULL AND (selected_country IS NULL OR selected_region !~ ('^' || selected_country || '-[A-Z0-9]{1,3}$')) THEN
    RAISE EXCEPTION 'Invalid notification region' USING ERRCODE='22023';
  END IF;
  FOR signal IN SELECT * FROM (VALUES
    ('DEVICE',context->>'deviceHash','NEW_DEVICE'),
    ('COUNTRY',selected_country,'NEW_COUNTRY'),
    ('LOCATION',selected_region,'NEW_LOCATION')
  ) AS signals(kind,key,reason) WHERE key IS NOT NULL LOOP
    IF NOT EXISTS (SELECT 1 FROM auth_login_contexts recognized
      WHERE recognized.user_id=NEW.user_id AND recognized.organization_id=NEW.organization_id
        AND recognized.realm=selected_realm AND recognized.security_epoch=epoch
        AND recognized.kind=signal.kind AND recognized.context_key=signal.key
        AND recognized.expires_at>now()) THEN
      reasons := reasons || jsonb_build_array(signal.reason);
    END IF;
    INSERT INTO auth_login_contexts(user_id,organization_id,realm,security_epoch,kind,context_key,expires_at)
      VALUES(NEW.user_id,NEW.organization_id,selected_realm,epoch,signal.kind,signal.key,now()+interval '90 days')
      ON CONFLICT(user_id,organization_id,realm,security_epoch,kind,context_key)
      DO UPDATE SET last_seen_at=now(),expires_at=now()+interval '90 days';
  END LOOP;
  NEW.template_data := jsonb_build_object('reasons',reasons,'occurredAt',now(),
    'browserLabel',context->>'browserLabel','country',selected_country,'region',selected_region,'geoStatus',context->>'geoStatus');
  INSERT INTO auth_login_notification_decisions(session_id,user_id,organization_id,request_id,email_queued,reasons,context)
    VALUES(selected_session.id,NEW.user_id,NEW.organization_id,NEW.request_id,jsonb_array_length(reasons)>0,reasons,NEW.template_data)
    ON CONFLICT(session_id) DO NOTHING RETURNING session_id INTO decision_created;
  IF decision_created IS NULL OR jsonb_array_length(reasons)=0 THEN RETURN NULL; END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.filter_signin_notification() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER auth_email_outbox_signin_eligibility
BEFORE INSERT ON auth_email_outbox
FOR EACH ROW EXECUTE FUNCTION app.filter_signin_notification();

--> statement-breakpoint
CREATE TRIGGER auth_login_notification_decisions_append_only
BEFORE UPDATE OR DELETE ON auth_login_notification_decisions
FOR EACH ROW EXECUTE FUNCTION app.guard_auth_security_event_immutable();
