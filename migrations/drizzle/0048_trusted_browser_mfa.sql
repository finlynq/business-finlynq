CREATE TABLE "auth_trusted_browsers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"user_agent_hash" text NOT NULL,
	"browser_label" text NOT NULL,
	"security_epoch" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "auth_trusted_browsers_token_hash_check" CHECK ("auth_trusted_browsers"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_trusted_browsers_user_agent_hash_check" CHECK ("auth_trusted_browsers"."user_agent_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_trusted_browsers_label_check" CHECK (length("auth_trusted_browsers"."browser_label") BETWEEN 1 AND 160 AND "auth_trusted_browsers"."browser_label" !~ '[[:cntrl:]]'),
	CONSTRAINT "auth_trusted_browsers_security_epoch_check" CHECK ("auth_trusted_browsers"."security_epoch" > 0),
	CONSTRAINT "auth_trusted_browsers_expiry_check" CHECK ("auth_trusted_browsers"."expires_at" > "auth_trusted_browsers"."created_at"),
	CONSTRAINT "auth_trusted_browsers_version_check" CHECK ("auth_trusted_browsers"."version" > 0),
	CONSTRAINT "auth_trusted_browsers_revocation_check" CHECK (("auth_trusted_browsers"."revoked_at" IS NULL AND "auth_trusted_browsers"."revoked_reason" IS NULL) OR ("auth_trusted_browsers"."revoked_at" IS NOT NULL AND "auth_trusted_browsers"."revoked_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "trusted_browser_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "trusted_browser_duration_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_security_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_trusted_browsers" ADD CONSTRAINT "auth_trusted_browsers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_trusted_browsers" ADD CONSTRAINT "auth_trusted_browsers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_trusted_browsers" ADD CONSTRAINT "auth_trusted_browsers_membership_id_organization_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."organization_memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_trusted_browsers" ADD CONSTRAINT "auth_trusted_browsers_membership_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_trusted_browsers_token_hash_unique" ON "auth_trusted_browsers" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_trusted_browsers_user_active_idx" ON "auth_trusted_browsers" USING btree ("user_id","organization_id","revoked_at","expires_at");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_trusted_browser_duration_check" CHECK ("organizations"."trusted_browser_duration_days" IN (7, 30, 90));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_auth_security_epoch_check" CHECK ("users"."auth_security_epoch" > 0);--> statement-breakpoint

-- Trusted-browser records are authentication control-plane state. The web
-- role reaches them only through the reviewed SECURITY DEFINER functions
-- below; direct owner-only FORCE RLS matches the other authentication tables.
CREATE POLICY auth_trusted_browsers_owner_only_policy
ON auth_trusted_browsers
FOR ALL TO PUBLIC
USING (
  current_user = pg_catalog.pg_get_userbyid((
    SELECT owner_relation.relowner
    FROM pg_catalog.pg_class owner_relation
    WHERE owner_relation.oid = 'public.auth_trusted_browsers'::pg_catalog.regclass
  ))
)
WITH CHECK (
  current_user = pg_catalog.pg_get_userbyid((
    SELECT owner_relation.relowner
    FROM pg_catalog.pg_class owner_relation
    WHERE owner_relation.oid = 'public.auth_trusted_browsers'::pg_catalog.regclass
  ))
);
ALTER TABLE auth_trusted_browsers ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_trusted_browsers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON auth_trusted_browsers FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_lookup_login_v3(selected_email_hash text)
RETURNS TABLE(
  user_id uuid,
  password_hash text,
  email_ciphertext text,
  display_name_ciphertext text,
  email_verified_at timestamp with time zone,
  mfa_required boolean,
  mfa_factor_id uuid,
  mfa_secret_ciphertext text,
  mfa_last_accepted_counter bigint,
  organization_id uuid,
  organization_name text,
  membership_id uuid,
  role_label text,
  trusted_browser_enabled boolean,
  trusted_browser_duration_days integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    selected_user.id,
    selected_user.password_hash,
    selected_user.email_ciphertext,
    selected_user.display_name_ciphertext,
    selected_user.email_verified_at,
    selected_user.mfa_required,
    factor.id,
    factor.secret_ciphertext,
    factor.last_accepted_counter,
    organization.id,
    organization.display_name,
    membership.id,
    coalesce(role_names.label, 'Member'),
    organization.trusted_browser_enabled,
    organization.trusted_browser_duration_days
  FROM users selected_user
  JOIN organization_memberships membership
    ON membership.user_id = selected_user.id AND membership.active
  JOIN organizations organization
    ON organization.id = membership.organization_id
   AND organization.active
   AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
  LEFT JOIN LATERAL (
    SELECT string_agg(DISTINCT role.display_name, ', ' ORDER BY role.display_name) AS label
    FROM membership_roles membership_role
    JOIN roles role
      ON role.organization_id = membership_role.organization_id
     AND role.id = membership_role.role_id
     AND role.active
    WHERE membership_role.organization_id = membership.organization_id
      AND membership_role.membership_id = membership.id
  ) role_names ON true
  LEFT JOIN LATERAL (
    SELECT candidate.id, candidate.secret_ciphertext,
      candidate.last_accepted_counter
    FROM auth_mfa_factors candidate
    WHERE candidate.user_id = selected_user.id
      AND candidate.factor_type = 'TOTP'
      AND candidate.status = 'ACTIVE'
      AND candidate.revoked_at IS NULL
    ORDER BY candidate.verified_at DESC NULLS LAST, candidate.created_at DESC
    LIMIT 1
  ) factor ON true
  WHERE selected_user.email_lookup_hash = selected_email_hash
    AND selected_user.active
    AND NOT selected_user.is_demo
  ORDER BY organization.created_at, organization.id
  LIMIT 10
$$;
REVOKE ALL ON FUNCTION app.auth_lookup_login_v3(text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_issue_mfa_user_session_trusted(
  selected_user_id uuid,
  selected_organization_id uuid,
  selected_membership_id uuid,
  selected_factor_id uuid,
  selected_totp_counter bigint,
  selected_session_token_hash text,
  selected_trusted_browser_token_hash text,
  selected_ip_hash text,
  selected_user_agent_hash text,
  selected_browser_label text,
  selected_request_id text
)
RETURNS TABLE(
  session_id uuid,
  trusted_browser_id uuid,
  trusted_browser_expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_security_epoch integer;
  selected_duration_days integer;
  created_session_id uuid;
  created_trusted_browser_id uuid;
  created_trusted_browser_expires_at timestamp with time zone;
BEGIN
  IF selected_session_token_hash !~ '^[0-9a-f]{64}$'
    OR selected_trusted_browser_token_hash !~ '^[0-9a-f]{64}$'
    OR selected_user_agent_hash !~ '^[0-9a-f]{64}$'
    OR selected_totp_counter < 0
    OR length(selected_ip_hash) NOT BETWEEN 32 AND 200
    OR length(selected_browser_label) NOT BETWEEN 1 AND 160
    OR selected_browser_label ~ '[[:cntrl:]]'
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid trusted-browser MFA session request'
      USING ERRCODE = '22023';
  END IF;

  SELECT selected_user.auth_security_epoch,
    organization.trusted_browser_duration_days
  INTO selected_security_epoch, selected_duration_days
  FROM users selected_user
  JOIN organization_memberships membership
    ON membership.id = selected_membership_id
   AND membership.user_id = selected_user.id
   AND membership.organization_id = selected_organization_id
   AND membership.active
  JOIN organizations organization
    ON organization.id = membership.organization_id
   AND organization.active
   AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
   AND organization.trusted_browser_enabled
   AND organization.trusted_browser_duration_days IN (7, 30, 90)
  WHERE selected_user.id = selected_user_id
    AND selected_user.active
    AND NOT selected_user.is_demo
    AND selected_user.mfa_required
  FOR UPDATE OF selected_user;
  IF selected_security_epoch IS NULL THEN RETURN; END IF;

  UPDATE auth_mfa_factors factor
  SET last_accepted_counter = selected_totp_counter
  WHERE factor.id = selected_factor_id
    AND factor.user_id = selected_user_id
    AND factor.factor_type = 'TOTP'
    AND factor.status = 'ACTIVE'
    AND factor.revoked_at IS NULL
    AND selected_totp_counter > coalesce(factor.last_accepted_counter, -1);
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO auth_sessions(
    token_hash, user_id, organization_id, membership_id,
    auth_method, session_mode, ip_hash, user_agent_hash,
    idle_timeout_seconds, idle_expires_at, expires_at,
    mfa_verified_at, step_up_expires_at
  ) VALUES (
    selected_session_token_hash, selected_user_id, selected_organization_id,
    selected_membership_id, 'PASSWORD', 'REAL', selected_ip_hash,
    selected_user_agent_hash, 7200, now() + interval '2 hours',
    now() + interval '24 hours', now(), now() + interval '10 minutes'
  ) RETURNING id INTO created_session_id;

  created_trusted_browser_expires_at :=
    now() + make_interval(days => selected_duration_days);
  INSERT INTO auth_trusted_browsers(
    token_hash, user_id, organization_id, membership_id,
    user_agent_hash, browser_label, security_epoch, expires_at
  ) VALUES (
    selected_trusted_browser_token_hash, selected_user_id,
    selected_organization_id, selected_membership_id,
    selected_user_agent_hash, btrim(selected_browser_label),
    selected_security_epoch, created_trusted_browser_expires_at
  ) RETURNING id INTO created_trusted_browser_id;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome,
    request_id, metadata
  ) VALUES
    (
      selected_user_id, selected_organization_id, created_session_id,
      'LOGIN_MFA', 'SUCCESS', selected_request_id,
      jsonb_build_object('trustedBrowserEnrolled', true)
    ),
    (
      selected_user_id, selected_organization_id, created_session_id,
      'TRUSTED_BROWSER_CREATED', 'SUCCESS', selected_request_id,
      jsonb_build_object(
        'trustedBrowserId', created_trusted_browser_id,
        'durationDays', selected_duration_days,
        'expiresAt', created_trusted_browser_expires_at
      )
    );
  INSERT INTO auth_email_outbox(
    id, user_id, organization_id, template_type, request_id
  ) VALUES (
    gen_random_uuid(), selected_user_id, selected_organization_id,
    'SECURITY_NEW_LOGIN', selected_request_id
  );

  RETURN QUERY SELECT created_session_id, created_trusted_browser_id,
    created_trusted_browser_expires_at;
END
$$;
REVOKE ALL ON FUNCTION app.auth_issue_mfa_user_session_trusted(
  uuid, uuid, uuid, uuid, bigint, text, text, text, text, text, text
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_issue_trusted_browser_user_session(
  selected_user_id uuid,
  selected_organization_id uuid,
  selected_membership_id uuid,
  selected_trusted_browser_token_hash text,
  selected_replacement_trusted_browser_token_hash text,
  selected_session_token_hash text,
  selected_ip_hash text,
  selected_user_agent_hash text,
  selected_request_id text
)
RETURNS TABLE(
  session_id uuid,
  trusted_browser_id uuid,
  trusted_browser_expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_browser auth_trusted_browsers%ROWTYPE;
  selected_security_epoch integer;
  policy_enabled boolean;
  created_session_id uuid;
BEGIN
  IF selected_trusted_browser_token_hash !~ '^[0-9a-f]{64}$'
    OR selected_replacement_trusted_browser_token_hash !~ '^[0-9a-f]{64}$'
    OR selected_session_token_hash !~ '^[0-9a-f]{64}$'
    OR selected_user_agent_hash !~ '^[0-9a-f]{64}$'
    OR length(selected_ip_hash) NOT BETWEEN 32 AND 200
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid trusted-browser login request'
      USING ERRCODE = '22023';
  END IF;

  SELECT selected_user.auth_security_epoch,
    organization.trusted_browser_enabled
  INTO selected_security_epoch, policy_enabled
  FROM users selected_user
  JOIN organization_memberships membership
    ON membership.id = selected_membership_id
   AND membership.user_id = selected_user.id
   AND membership.organization_id = selected_organization_id
   AND membership.active
  JOIN organizations organization
    ON organization.id = membership.organization_id
   AND organization.active
   AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
  WHERE selected_user.id = selected_user_id
    AND selected_user.active
    AND NOT selected_user.is_demo
    AND selected_user.mfa_required
    AND EXISTS (
      SELECT 1 FROM auth_mfa_factors factor
      WHERE factor.user_id = selected_user.id
        AND factor.factor_type = 'TOTP'
        AND factor.status = 'ACTIVE'
        AND factor.revoked_at IS NULL
    )
  FOR UPDATE OF selected_user;
  IF selected_security_epoch IS NULL THEN RETURN; END IF;

  SELECT candidate.* INTO selected_browser
  FROM auth_trusted_browsers candidate
  WHERE candidate.token_hash = selected_trusted_browser_token_hash
  FOR UPDATE;
  IF selected_browser.id IS NULL THEN
    INSERT INTO auth_security_events(
      user_id, organization_id, event_type, outcome, request_id, metadata
    ) VALUES (
      selected_user_id, selected_organization_id,
      'TRUSTED_BROWSER_LOGIN', 'DENIED', selected_request_id,
      jsonb_build_object('reason', 'UNRECOGNIZED')
    );
    RETURN;
  END IF;

  -- A token copied into another user, tenant, membership, or User-Agent cannot
  -- authorize a session. Only a record that already belongs to this
  -- password-verified identity may be revoked by the failed attempt.
  IF selected_browser.user_id IS DISTINCT FROM selected_user_id
    OR selected_browser.organization_id IS DISTINCT FROM selected_organization_id
    OR selected_browser.membership_id IS DISTINCT FROM selected_membership_id THEN
    INSERT INTO auth_security_events(
      user_id, organization_id, event_type, outcome, request_id, metadata
    ) VALUES (
      selected_user_id, selected_organization_id,
      'TRUSTED_BROWSER_LOGIN', 'DENIED', selected_request_id,
      jsonb_build_object('reason', 'IDENTITY_BOUNDARY')
    );
    RETURN;
  END IF;

  IF selected_browser.revoked_at IS NOT NULL THEN
    RETURN;
  END IF;
  IF selected_browser.expires_at <= now() THEN
    UPDATE auth_trusted_browsers SET
      revoked_at = now(), revoked_reason = 'EXPIRED',
      version = version + 1
    WHERE id = selected_browser.id AND revoked_at IS NULL;
    INSERT INTO auth_security_events(
      user_id, organization_id, event_type, outcome, request_id, metadata
    ) VALUES (
      selected_user_id, selected_organization_id,
      'TRUSTED_BROWSER_EXPIRED', 'SUCCESS', selected_request_id,
      jsonb_build_object('trustedBrowserId', selected_browser.id)
    );
    RETURN;
  END IF;
  IF NOT policy_enabled
    OR selected_browser.security_epoch <> selected_security_epoch
    OR selected_browser.user_agent_hash <> selected_user_agent_hash THEN
    UPDATE auth_trusted_browsers SET
      revoked_at = now(),
      revoked_reason = CASE
        WHEN NOT policy_enabled THEN 'POLICY_DISABLED'
        WHEN security_epoch <> selected_security_epoch THEN 'SECURITY_CHANGE'
        ELSE 'BROWSER_BINDING_CHANGED'
      END,
      version = version + 1
    WHERE id = selected_browser.id AND revoked_at IS NULL;
    INSERT INTO auth_security_events(
      user_id, organization_id, event_type, outcome, request_id, metadata
    ) VALUES (
      selected_user_id, selected_organization_id,
      'TRUSTED_BROWSER_REVOKED', 'SUCCESS', selected_request_id,
      jsonb_build_object(
        'trustedBrowserId', selected_browser.id,
        'reason', CASE
          WHEN NOT policy_enabled THEN 'POLICY_DISABLED'
          WHEN selected_browser.security_epoch <> selected_security_epoch
            THEN 'SECURITY_CHANGE'
          ELSE 'BROWSER_BINDING_CHANGED'
        END
      )
    );
    RETURN;
  END IF;

  UPDATE auth_trusted_browsers SET
    token_hash = selected_replacement_trusted_browser_token_hash,
    last_used_at = now(),
    version = version + 1
  WHERE id = selected_browser.id
    AND token_hash = selected_trusted_browser_token_hash
    AND revoked_at IS NULL
    AND expires_at > now()
    AND security_epoch = selected_security_epoch
    AND user_agent_hash = selected_user_agent_hash;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO auth_sessions(
    token_hash, user_id, organization_id, membership_id,
    auth_method, session_mode, ip_hash, user_agent_hash,
    idle_timeout_seconds, idle_expires_at, expires_at,
    mfa_verified_at, step_up_expires_at
  ) VALUES (
    selected_session_token_hash, selected_user_id, selected_organization_id,
    selected_membership_id, 'PASSWORD', 'REAL', selected_ip_hash,
    selected_user_agent_hash, 7200, now() + interval '2 hours',
    now() + interval '24 hours', NULL, NULL
  ) RETURNING id INTO created_session_id;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome,
    request_id, metadata
  ) VALUES
    (
      selected_user_id, selected_organization_id, created_session_id,
      'TRUSTED_BROWSER_USED', 'SUCCESS', selected_request_id,
      jsonb_build_object(
        'trustedBrowserId', selected_browser.id,
        'tokenRotated', true,
        'loginMfaSkipped', true
      )
    ),
    (
      selected_user_id, selected_organization_id, created_session_id,
      'LOGIN_PASSWORD', 'SUCCESS', selected_request_id,
      jsonb_build_object(
        'mfaEnabled', true,
        'trustedBrowserUsed', true,
        'mfaVerifiedAt', NULL,
        'stepUpExpiresAt', NULL
      )
    );
  INSERT INTO auth_email_outbox(
    id, user_id, organization_id, template_type, request_id
  ) VALUES (
    gen_random_uuid(), selected_user_id, selected_organization_id,
    'SECURITY_NEW_LOGIN', selected_request_id
  );

  RETURN QUERY SELECT created_session_id, selected_browser.id,
    selected_browser.expires_at;
END
$$;
REVOKE ALL ON FUNCTION app.auth_issue_trusted_browser_user_session(
  uuid, uuid, uuid, text, text, text, text, text, text
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_revoke_user_trusted_browsers(
  selected_user_id uuid,
  selected_reason text,
  selected_event_type text,
  selected_request_id text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  revoked_count bigint;
  safe_request_id text;
BEGIN
  IF selected_reason NOT IN (
      'PASSWORD_CHANGED', 'MFA_CHANGED', 'ACCOUNT_RECOVERY',
      'SECURITY_CHANGE'
    )
    OR selected_event_type <> 'TRUSTED_BROWSER_REVOKED' THEN
    RAISE EXCEPTION 'Invalid trusted-browser security invalidation'
      USING ERRCODE = '22023';
  END IF;
  safe_request_id := CASE
    WHEN length(selected_request_id) BETWEEN 1 AND 200
      THEN selected_request_id
    ELSE 'automatic-security-invalidation'
  END;

  WITH revoked AS (
    UPDATE auth_trusted_browsers SET
      revoked_at = now(),
      revoked_reason = selected_reason,
      version = version + 1
    WHERE user_id = selected_user_id
      AND revoked_at IS NULL
    RETURNING id, user_id, organization_id
  ), events AS (
    INSERT INTO auth_security_events(
      user_id, organization_id, event_type, outcome, request_id, metadata
    )
    SELECT revoked.user_id, revoked.organization_id,
      selected_event_type, 'SUCCESS', safe_request_id,
      jsonb_build_object(
        'trustedBrowserId', revoked.id,
        'reason', selected_reason
      )
    FROM revoked
    RETURNING 1
  )
  SELECT count(*)::bigint INTO revoked_count FROM events;
  RETURN coalesce(revoked_count, 0);
END
$$;
REVOKE ALL ON FUNCTION app.auth_revoke_user_trusted_browsers(
  uuid, text, text, text
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_revoke_membership_trusted_browsers(
  selected_organization_id uuid,
  selected_membership_id uuid,
  selected_reason text,
  selected_request_id text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  revoked_count bigint;
  safe_request_id text;
BEGIN
  IF selected_reason NOT IN (
      'MEMBERSHIP_CHANGED', 'ROLE_CHANGED', 'ADMIN_SESSION_REVOCATION'
    ) THEN
    RAISE EXCEPTION 'Invalid trusted-browser membership invalidation'
      USING ERRCODE = '22023';
  END IF;
  safe_request_id := CASE
    WHEN length(selected_request_id) BETWEEN 1 AND 200
      THEN selected_request_id
    ELSE 'automatic-membership-invalidation'
  END;

  WITH revoked AS (
    UPDATE auth_trusted_browsers SET
      revoked_at = now(),
      revoked_reason = selected_reason,
      version = version + 1
    WHERE organization_id = selected_organization_id
      AND membership_id = selected_membership_id
      AND revoked_at IS NULL
    RETURNING id, user_id, organization_id
  ), events AS (
    INSERT INTO auth_security_events(
      user_id, organization_id, event_type, outcome, request_id, metadata
    )
    SELECT revoked.user_id, revoked.organization_id,
      'TRUSTED_BROWSER_REVOKED', 'SUCCESS', safe_request_id,
      jsonb_build_object(
        'trustedBrowserId', revoked.id,
        'reason', selected_reason
      )
    FROM revoked
    RETURNING 1
  )
  SELECT count(*)::bigint INTO revoked_count FROM events;
  RETURN coalesce(revoked_count, 0);
END
$$;
REVOKE ALL ON FUNCTION app.auth_revoke_membership_trusted_browsers(
  uuid, uuid, text, text
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_user_auth_security_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
    OR NEW.mfa_required IS DISTINCT FROM OLD.mfa_required THEN
    NEW.auth_security_epoch := OLD.auth_security_epoch + 1;
  ELSIF NEW.auth_security_epoch < OLD.auth_security_epoch THEN
    RAISE EXCEPTION 'Authentication security epoch cannot decrease'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_user_auth_security_epoch() FROM PUBLIC;
CREATE TRIGGER users_auth_security_epoch_guard
BEFORE UPDATE OF password_hash, mfa_required, auth_security_epoch ON users
FOR EACH ROW EXECUTE FUNCTION app.guard_user_auth_security_epoch();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.invalidate_trust_after_user_security_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  reason text;
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
    OR NEW.mfa_required IS DISTINCT FROM OLD.mfa_required THEN
    reason := CASE
      WHEN NEW.password_hash IS DISTINCT FROM OLD.password_hash
        THEN 'PASSWORD_CHANGED'
      ELSE 'MFA_CHANGED'
    END;
    PERFORM app.auth_revoke_user_trusted_browsers(
      NEW.id,
      reason,
      'TRUSTED_BROWSER_REVOKED',
      nullif(current_setting('app.request_id', true), '')
    );
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.invalidate_trust_after_user_security_change() FROM PUBLIC;
CREATE TRIGGER users_trusted_browser_security_invalidation
AFTER UPDATE OF password_hash, mfa_required ON users
FOR EACH ROW EXECUTE FUNCTION app.invalidate_trust_after_user_security_change();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.invalidate_trust_after_mfa_factor_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  security_relevant boolean := false;
BEGIN
  selected_user_id := coalesce(NEW.user_id, OLD.user_id);
  IF TG_OP = 'INSERT' THEN
    security_relevant := NEW.status = 'ACTIVE';
  ELSIF TG_OP = 'DELETE' THEN
    security_relevant := OLD.status = 'ACTIVE';
  ELSE
    security_relevant :=
      (OLD.status = 'ACTIVE' OR NEW.status = 'ACTIVE')
      AND (
        NEW.status IS DISTINCT FROM OLD.status
        OR NEW.secret_ciphertext IS DISTINCT FROM OLD.secret_ciphertext
        OR NEW.recovery_token_id IS DISTINCT FROM OLD.recovery_token_id
      );
  END IF;

  IF security_relevant THEN
    UPDATE users SET auth_security_epoch = auth_security_epoch + 1
    WHERE id = selected_user_id;
    PERFORM app.auth_revoke_user_trusted_browsers(
      selected_user_id,
      'MFA_CHANGED',
      'TRUSTED_BROWSER_REVOKED',
      nullif(current_setting('app.request_id', true), '')
    );
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
REVOKE ALL ON FUNCTION app.invalidate_trust_after_mfa_factor_change() FROM PUBLIC;
CREATE TRIGGER auth_mfa_factors_trusted_browser_invalidation
AFTER INSERT OR UPDATE OF status, secret_ciphertext, recovery_token_id OR DELETE
ON auth_mfa_factors
FOR EACH ROW EXECUTE FUNCTION app.invalidate_trust_after_mfa_factor_change();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.invalidate_trust_after_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.active IS DISTINCT FROM OLD.active THEN
    PERFORM app.auth_revoke_membership_trusted_browsers(
      NEW.organization_id,
      NEW.id,
      'MEMBERSHIP_CHANGED',
      nullif(current_setting('app.request_id', true), '')
    );
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.invalidate_trust_after_membership_change() FROM PUBLIC;
CREATE TRIGGER organization_memberships_trusted_browser_invalidation
AFTER UPDATE OF active ON organization_memberships
FOR EACH ROW EXECUTE FUNCTION app.invalidate_trust_after_membership_change();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.invalidate_trust_after_role_assignment_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_organization_id uuid;
  selected_membership_id uuid;
BEGIN
  selected_organization_id := coalesce(NEW.organization_id, OLD.organization_id);
  selected_membership_id := coalesce(NEW.membership_id, OLD.membership_id);
  PERFORM app.auth_revoke_membership_trusted_browsers(
    selected_organization_id,
    selected_membership_id,
    'ROLE_CHANGED',
    nullif(current_setting('app.request_id', true), '')
  );
  RETURN coalesce(NEW, OLD);
END
$$;
REVOKE ALL ON FUNCTION app.invalidate_trust_after_role_assignment_change() FROM PUBLIC;
CREATE TRIGGER membership_roles_trusted_browser_invalidation
AFTER INSERT OR UPDATE OR DELETE ON membership_roles
FOR EACH ROW EXECUTE FUNCTION app.invalidate_trust_after_role_assignment_change();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_trusted_browsers_for_session(
  selected_session_id uuid,
  selected_request_id text
)
RETURNS TABLE(
  id uuid,
  browser_label text,
  created_at timestamp with time zone,
  last_used_at timestamp with time zone,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  selected_organization_id uuid;
  selected_security_epoch integer;
  policy_enabled boolean;
BEGIN
  IF length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid trusted-browser list request'
      USING ERRCODE = '22023';
  END IF;
  SELECT selected_user.id, organization.id,
    selected_user.auth_security_epoch,
    organization.trusted_browser_enabled
  INTO selected_user_id, selected_organization_id,
    selected_security_epoch, policy_enabled
  FROM auth_sessions selected_session
  JOIN users selected_user
    ON selected_user.id = selected_session.user_id
   AND selected_user.active
   AND NOT selected_user.is_demo
  JOIN organizations organization
    ON organization.id = selected_session.organization_id
   AND organization.active
   AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
  JOIN organization_memberships membership
    ON membership.id = selected_session.membership_id
   AND membership.user_id = selected_session.user_id
   AND membership.organization_id = selected_session.organization_id
   AND membership.active
  WHERE selected_session.id = selected_session_id
    AND selected_session.session_mode = 'REAL'
    AND selected_session.auth_method = 'PASSWORD'
    AND selected_session.revoked_at IS NULL
    AND selected_session.expires_at > now()
    AND selected_session.idle_expires_at > now();
  IF selected_user_id IS NULL THEN RETURN; END IF;

  WITH expired AS (
    UPDATE auth_trusted_browsers AS browser SET
      revoked_at = now(), revoked_reason = 'EXPIRED',
      version = browser.version + 1
    WHERE browser.user_id = selected_user_id
      AND browser.organization_id = selected_organization_id
      AND browser.revoked_at IS NULL
      AND browser.expires_at <= now()
    RETURNING browser.id, browser.user_id, browser.organization_id
  )
  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type,
    outcome, request_id, metadata
  )
  SELECT expired.user_id, expired.organization_id, selected_session_id,
    'TRUSTED_BROWSER_EXPIRED', 'SUCCESS', selected_request_id,
    jsonb_build_object('trustedBrowserId', expired.id)
  FROM expired;

  WITH invalidated AS (
    UPDATE auth_trusted_browsers AS browser SET
      revoked_at = now(),
      revoked_reason = CASE
        WHEN NOT policy_enabled THEN 'POLICY_DISABLED'
        ELSE 'SECURITY_CHANGE'
      END,
      version = browser.version + 1
    WHERE browser.user_id = selected_user_id
      AND browser.organization_id = selected_organization_id
      AND browser.revoked_at IS NULL
      AND browser.expires_at > now()
      AND (
        NOT policy_enabled
        OR browser.security_epoch <> selected_security_epoch
      )
    RETURNING browser.id, browser.user_id, browser.organization_id,
      browser.revoked_reason
  )
  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type,
    outcome, request_id, metadata
  )
  SELECT invalidated.user_id, invalidated.organization_id,
    selected_session_id, 'TRUSTED_BROWSER_REVOKED', 'SUCCESS',
    selected_request_id,
    jsonb_build_object(
      'trustedBrowserId', invalidated.id,
      'reason', invalidated.revoked_reason
    )
  FROM invalidated;

  RETURN QUERY
  SELECT browser.id, browser.browser_label, browser.created_at,
    browser.last_used_at, browser.expires_at
  FROM auth_trusted_browsers browser
  WHERE browser.user_id = selected_user_id
    AND browser.organization_id = selected_organization_id
    AND browser.revoked_at IS NULL
    AND browser.expires_at > now()
    AND browser.security_epoch = selected_security_epoch
    AND policy_enabled
  ORDER BY browser.last_used_at DESC NULLS LAST,
    browser.created_at DESC, browser.id;
END
$$;
REVOKE ALL ON FUNCTION app.auth_trusted_browsers_for_session(uuid, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_revoke_trusted_browser(
  selected_session_id uuid,
  selected_trusted_browser_id uuid,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  selected_organization_id uuid;
  revoked_browser_id uuid;
BEGIN
  IF length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid trusted-browser revocation request'
      USING ERRCODE = '22023';
  END IF;
  SELECT selected_user.id, organization.id
  INTO selected_user_id, selected_organization_id
  FROM auth_sessions selected_session
  JOIN users selected_user
    ON selected_user.id = selected_session.user_id
   AND selected_user.active AND NOT selected_user.is_demo
  JOIN organizations organization
    ON organization.id = selected_session.organization_id
   AND organization.active AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
  JOIN organization_memberships membership
    ON membership.id = selected_session.membership_id
   AND membership.user_id = selected_session.user_id
   AND membership.organization_id = selected_session.organization_id
   AND membership.active
  WHERE selected_session.id = selected_session_id
    AND selected_session.session_mode = 'REAL'
    AND selected_session.revoked_at IS NULL
    AND selected_session.expires_at > now()
    AND selected_session.idle_expires_at > now();
  IF selected_user_id IS NULL THEN RETURN false; END IF;

  UPDATE auth_trusted_browsers SET
    revoked_at = now(), revoked_reason = 'USER_REVOKED',
    version = version + 1
  WHERE id = selected_trusted_browser_id
    AND user_id = selected_user_id
    AND organization_id = selected_organization_id
    AND revoked_at IS NULL
  RETURNING id INTO revoked_browser_id;
  IF revoked_browser_id IS NULL THEN RETURN false; END IF;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type,
    outcome, request_id, metadata
  ) VALUES (
    selected_user_id, selected_organization_id, selected_session_id,
    'TRUSTED_BROWSER_REVOKED', 'SUCCESS', selected_request_id,
    jsonb_build_object(
      'trustedBrowserId', revoked_browser_id,
      'reason', 'USER_REVOKED'
    )
  );
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.auth_revoke_trusted_browser(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_revoke_all_trusted_browsers(
  selected_session_id uuid,
  selected_request_id text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  selected_organization_id uuid;
  revoked_count bigint;
BEGIN
  IF length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid trusted-browser revocation request'
      USING ERRCODE = '22023';
  END IF;
  SELECT selected_user.id, organization.id
  INTO selected_user_id, selected_organization_id
  FROM auth_sessions selected_session
  JOIN users selected_user
    ON selected_user.id = selected_session.user_id
   AND selected_user.active AND NOT selected_user.is_demo
  JOIN organizations organization
    ON organization.id = selected_session.organization_id
   AND organization.active AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
  JOIN organization_memberships membership
    ON membership.id = selected_session.membership_id
   AND membership.user_id = selected_session.user_id
   AND membership.organization_id = selected_session.organization_id
   AND membership.active
  WHERE selected_session.id = selected_session_id
    AND selected_session.session_mode = 'REAL'
    AND selected_session.revoked_at IS NULL
    AND selected_session.expires_at > now()
    AND selected_session.idle_expires_at > now();
  IF selected_user_id IS NULL THEN RETURN 0; END IF;

  WITH revoked AS (
    UPDATE auth_trusted_browsers SET
      revoked_at = now(), revoked_reason = 'USER_REVOKED_ALL',
      version = version + 1
    WHERE user_id = selected_user_id
      AND organization_id = selected_organization_id
      AND revoked_at IS NULL
    RETURNING id
  ), events AS (
    INSERT INTO auth_security_events(
      user_id, organization_id, session_id, event_type,
      outcome, request_id, metadata
    )
    SELECT selected_user_id, selected_organization_id,
      selected_session_id, 'TRUSTED_BROWSER_REVOKED',
      'SUCCESS', selected_request_id,
      jsonb_build_object(
        'trustedBrowserId', revoked.id,
        'reason', 'USER_REVOKED_ALL'
      )
    FROM revoked
    RETURNING 1
  )
  SELECT count(*)::bigint INTO revoked_count FROM events;
  RETURN coalesce(revoked_count, 0);
END
$$;
REVOKE ALL ON FUNCTION app.auth_revoke_all_trusted_browsers(uuid, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_logout_all_sessions(
  selected_session_id uuid,
  selected_request_id text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_session auth_sessions%ROWTYPE;
  revoked_count bigint;
BEGIN
  IF length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid logout-all request' USING ERRCODE = '22023';
  END IF;
  SELECT session.* INTO selected_session
  FROM auth_sessions session
  JOIN users selected_user
    ON selected_user.id = session.user_id
   AND selected_user.active AND NOT selected_user.is_demo
  JOIN organizations organization
    ON organization.id = session.organization_id
   AND organization.active AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
  JOIN organization_memberships membership
    ON membership.id = session.membership_id
   AND membership.user_id = session.user_id
   AND membership.organization_id = session.organization_id
   AND membership.active
  WHERE session.id = selected_session_id
    AND session.session_mode = 'REAL'
    AND session.revoked_at IS NULL
    AND session.expires_at > now()
    AND session.idle_expires_at > now()
  FOR UPDATE OF session;
  IF selected_session.id IS NULL THEN RETURN 0; END IF;

  WITH revoked AS (
    UPDATE auth_trusted_browsers SET
      revoked_at = now(), revoked_reason = 'LOGOUT_ALL',
      version = version + 1
    WHERE user_id = selected_session.user_id
      AND revoked_at IS NULL
    RETURNING id, organization_id
  )
  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type,
    outcome, request_id, metadata
  )
  SELECT selected_session.user_id, revoked.organization_id,
    selected_session.id, 'TRUSTED_BROWSER_REVOKED', 'SUCCESS',
    selected_request_id,
    jsonb_build_object(
      'trustedBrowserId', revoked.id,
      'reason', 'LOGOUT_ALL'
    )
  FROM revoked;

  WITH revoked_sessions AS (
    UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
    WHERE user_id = selected_session.user_id
      AND revoked_at IS NULL
    RETURNING id
  )
  SELECT count(*)::bigint INTO revoked_count FROM revoked_sessions;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type,
    outcome, request_id, metadata
  ) VALUES (
    selected_session.user_id, selected_session.organization_id,
    selected_session.id, 'LOGOUT_ALL', 'SUCCESS', selected_request_id,
    jsonb_build_object('sessionsRevoked', coalesce(revoked_count, 0))
  );
  RETURN coalesce(revoked_count, 0);
END
$$;
REVOKE ALL ON FUNCTION app.auth_logout_all_sessions(uuid, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_settings_read_v2()
RETURNS TABLE(
  organization_id uuid,
  display_name text,
  settings_version integer,
  is_demo boolean,
  trusted_browser_enabled boolean,
  trusted_browser_duration_days integer,
  can_manage_settings boolean,
  can_read_members boolean,
  can_manage_members boolean,
  can_manage_roles boolean,
  can_manage_recovery boolean,
  assignable_roles jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT settings.organization_id, settings.display_name,
    settings.settings_version, settings.is_demo,
    organization.trusted_browser_enabled,
    organization.trusted_browser_duration_days,
    settings.can_manage_settings, settings.can_read_members,
    settings.can_manage_members, settings.can_manage_roles,
    settings.can_manage_recovery, settings.assignable_roles
  FROM app.organization_settings_read() settings
  JOIN organizations organization
    ON organization.id = settings.organization_id
$$;
REVOKE ALL ON FUNCTION app.organization_settings_read_v2() FROM PUBLIC;
--> statement-breakpoint

INSERT INTO public.audit_outbox_pair_contract(
  audit_action, outbox_topic, aggregate_type, contract_version
) VALUES (
  'organization.trusted-browser-policy-updated',
  'organization.trusted-browser-policy-updated',
  'organization',
  'business-audit-outbox-v1'
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_update_trusted_browser_policy(
  selected_enabled boolean,
  selected_duration_days integer,
  expected_version integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
  selected_organization organizations%ROWTYPE;
  next_version integer;
  revoked_count bigint;
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize(
    'organization.settings.manage',
    true
  );
  IF administrator.is_demo
    OR selected_duration_days NOT IN (7, 30, 90) THEN
    RAISE EXCEPTION 'Trusted-browser policy is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO selected_organization
  FROM organizations
  WHERE id = administrator.organization_id
  FOR UPDATE;
  IF selected_organization.settings_version <> expected_version THEN
    RAISE EXCEPTION 'Organization settings version changed by another administrator'
      USING ERRCODE = '40001';
  END IF;

  UPDATE organizations SET
    trusted_browser_enabled = selected_enabled,
    trusted_browser_duration_days = selected_duration_days,
    settings_version = settings_version + 1,
    updated_at = now()
  WHERE id = administrator.organization_id
    AND settings_version = expected_version
  RETURNING settings_version INTO next_version;
  IF next_version IS NULL THEN
    RAISE EXCEPTION 'Organization settings version changed by another administrator'
      USING ERRCODE = '40001';
  END IF;

  -- A policy edit never silently extends old trust. Users may opt in again
  -- under the newly reviewed duration after a normal MFA login.
  WITH revoked AS (
    UPDATE auth_trusted_browsers SET
      revoked_at = now(),
      revoked_reason = CASE
        WHEN selected_enabled THEN 'POLICY_CHANGED'
        ELSE 'POLICY_DISABLED'
      END,
      version = version + 1
    WHERE organization_id = administrator.organization_id
      AND revoked_at IS NULL
    RETURNING id, user_id
  ), events AS (
    INSERT INTO auth_security_events(
      user_id, organization_id, session_id, event_type,
      outcome, request_id, metadata
    )
    SELECT revoked.user_id, administrator.organization_id,
      administrator.session_id, 'TRUSTED_BROWSER_REVOKED',
      'SUCCESS', current_setting('app.request_id', true),
      jsonb_build_object(
        'trustedBrowserId', revoked.id,
        'reason', CASE
          WHEN selected_enabled THEN 'POLICY_CHANGED'
          ELSE 'POLICY_DISABLED'
        END
      )
    FROM revoked
    RETURNING 1
  )
  SELECT count(*)::bigint INTO revoked_count FROM events;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type,
    outcome, request_id, metadata
  ) VALUES (
    administrator.actor_id, administrator.organization_id,
    administrator.session_id, 'TRUSTED_BROWSER_POLICY_UPDATED',
    'SUCCESS', current_setting('app.request_id', true),
    jsonb_build_object(
      'enabled', selected_enabled,
      'durationDays', selected_duration_days,
      'previousEnabled', selected_organization.trusted_browser_enabled,
      'previousDurationDays',
        selected_organization.trusted_browser_duration_days,
      'trustedBrowsersRevoked', coalesce(revoked_count, 0),
      'version', next_version
    )
  );
  PERFORM app.append_tenant_business_audit(
    administrator.organization_id,
    'organization.trusted-browser-policy-updated',
    'organization',
    administrator.organization_id::text,
    jsonb_build_object(
      'enabled', selected_enabled,
      'durationDays', selected_duration_days,
      'trustedBrowsersRevoked', coalesce(revoked_count, 0),
      'version', next_version
    ),
    'organization.trusted-browser-policy-updated'
  );
  RETURN next_version;
END
$$;
REVOKE ALL ON FUNCTION app.organization_update_trusted_browser_policy(
  boolean, integer, integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_revoke_member_sessions_and_trust(
  selected_membership_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  revoked_session_count bigint;
  selected_organization_id uuid;
BEGIN
  -- The existing function performs the full organization, permission,
  -- recovery-admin, target-member, step-up, and audit checks.
  revoked_session_count :=
    app.organization_revoke_member_sessions(selected_membership_id);
  selected_organization_id := app.current_organization_id();
  PERFORM app.auth_revoke_membership_trusted_browsers(
    selected_organization_id,
    selected_membership_id,
    'ADMIN_SESSION_REVOCATION',
    nullif(current_setting('app.request_id', true), '')
  );
  RETURN revoked_session_count;
END
$$;
REVOKE ALL ON FUNCTION app.organization_revoke_member_sessions_and_trust(uuid)
FROM PUBLIC;
--> statement-breakpoint

COMMENT ON TABLE auth_trusted_browsers IS
  'Rotating, hashed, tenant- and browser-bound proof used only to skip login MFA after password verification. It never carries step-up authority.';
COMMENT ON COLUMN auth_trusted_browsers.token_hash IS
  'SHA-256 digest of a 32-byte opaque browser cookie. Raw tokens are never stored.';
COMMENT ON COLUMN users.auth_security_epoch IS
  'Monotonic credential/MFA epoch. Trusted-browser records issued under another epoch fail closed.';
COMMENT ON COLUMN organizations.trusted_browser_enabled IS
  'Tenant administrator opt-in for trusted-browser login MFA skipping; disabled by default.';
--> statement-breakpoint

DO $trusted_browser_grants$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app'
  ) THEN
    REVOKE ALL ON auth_trusted_browsers FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION
      app.auth_lookup_login_v3(text),
      app.auth_issue_mfa_user_session_trusted(
        uuid, uuid, uuid, uuid, bigint, text, text, text, text, text, text
      ),
      app.auth_issue_trusted_browser_user_session(
        uuid, uuid, uuid, text, text, text, text, text, text
      ),
      app.auth_trusted_browsers_for_session(uuid, text),
      app.auth_revoke_trusted_browser(uuid, uuid, text),
      app.auth_revoke_all_trusted_browsers(uuid, text),
      app.auth_logout_all_sessions(uuid, text),
      app.organization_settings_read_v2(),
      app.organization_update_trusted_browser_policy(boolean, integer, integer),
      app.organization_revoke_member_sessions_and_trust(uuid)
    TO business_finlynq_app;
  END IF;
END
$trusted_browser_grants$;
