-- Persist exact Entra identities for self-service Microsoft signup while
-- retaining the reviewed static identity map as a migration-compatible login
-- source. Contact email remains a separately verified recovery/delivery field.
ALTER TABLE "auth_organization_signups" ADD COLUMN "oidc_issuer" text;
--> statement-breakpoint
ALTER TABLE "auth_organization_signups" ADD COLUMN "oidc_external_tenant_id" text;
--> statement-breakpoint
ALTER TABLE "auth_organization_signups" ADD COLUMN "oidc_external_principal_id" text;
--> statement-breakpoint
ALTER TABLE "auth_organization_signups" ADD COLUMN "oidc_credential_hash" text;
--> statement-breakpoint
ALTER TABLE "auth_organization_signups" ADD CONSTRAINT "auth_organization_signups_oidc_binding_check" CHECK (("auth_organization_signups"."oidc_issuer" IS NULL AND "auth_organization_signups"."oidc_external_tenant_id" IS NULL AND "auth_organization_signups"."oidc_external_principal_id" IS NULL AND "auth_organization_signups"."oidc_credential_hash" IS NULL) OR ("auth_organization_signups"."oidc_issuer" IS NOT NULL AND "auth_organization_signups"."oidc_external_tenant_id" IS NOT NULL AND "auth_organization_signups"."oidc_external_principal_id" IS NOT NULL AND "auth_organization_signups"."oidc_credential_hash" ~ '^[0-9a-f]{64}$'));
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_organization_signups_oidc_source_unique" ON "auth_organization_signups" USING btree ("oidc_issuer","oidc_external_tenant_id","oidc_external_principal_id") WHERE "auth_organization_signups"."oidc_external_principal_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "auth_oidc_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"external_tenant_id" text NOT NULL,
	"external_principal_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "auth_oidc_identities_issuer_check" CHECK (length("auth_oidc_identities"."issuer") BETWEEN 8 AND 2048 AND "auth_oidc_identities"."issuer" !~ '[[:cntrl:]]'),
	CONSTRAINT "auth_oidc_identities_tenant_check" CHECK ("auth_oidc_identities"."external_tenant_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$'),
	CONSTRAINT "auth_oidc_identities_principal_check" CHECK ("auth_oidc_identities"."external_principal_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$')
);
--> statement-breakpoint
ALTER TABLE "auth_oidc_identities" ADD CONSTRAINT "auth_oidc_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_oidc_identities_source_unique" ON "auth_oidc_identities" USING btree ("issuer","external_tenant_id","external_principal_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_oidc_identities_user_unique" ON "auth_oidc_identities" USING btree ("user_id");
--> statement-breakpoint

CREATE POLICY auth_oidc_identities_owner_only_policy
ON auth_oidc_identities
FOR ALL TO PUBLIC
USING (
  current_user = pg_catalog.pg_get_userbyid((
    SELECT owner_relation.relowner
    FROM pg_catalog.pg_class owner_relation
    WHERE owner_relation.oid = 'public.auth_oidc_identities'::pg_catalog.regclass
  ))
)
WITH CHECK (
  current_user = pg_catalog.pg_get_userbyid((
    SELECT owner_relation.relowner
    FROM pg_catalog.pg_class owner_relation
    WHERE owner_relation.oid = 'public.auth_oidc_identities'::pg_catalog.regclass
  ))
);
ALTER TABLE auth_oidc_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_oidc_identities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON auth_oidc_identities FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_configure_organization_signup_oidc(
  selected_signup_id uuid,
  selected_outbox_id uuid,
  selected_issuer text,
  selected_external_tenant_id text,
  selected_external_principal_id text,
  selected_credential_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  clearing_binding boolean;
  selected_user_id uuid;
BEGIN
  clearing_binding := selected_issuer IS NULL
    AND selected_external_tenant_id IS NULL
    AND selected_external_principal_id IS NULL
    AND selected_credential_hash IS NULL;
  IF NOT clearing_binding AND (
    selected_issuer IS NULL
    OR selected_external_tenant_id IS NULL
    OR selected_external_principal_id IS NULL
    OR selected_credential_hash IS NULL
    OR selected_issuer !~ '^https://'
    OR length(selected_issuer) NOT BETWEEN 8 AND 2048
    OR selected_issuer ~ '[[:cntrl:]]'
    OR selected_external_tenant_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$'
    OR selected_external_principal_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$'
    OR selected_credential_hash !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'Invalid OIDC organization signup binding'
      USING ERRCODE = '22023';
  END IF;

  IF NOT clearing_binding THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'business-finlynq|oidc-identity|' || selected_issuer || '|' ||
      selected_external_tenant_id || '|' || selected_external_principal_id, 0
    ));
    IF EXISTS (
      SELECT 1 FROM auth_oidc_identities identity
      WHERE identity.issuer = selected_issuer
        AND identity.external_tenant_id = selected_external_tenant_id
        AND identity.external_principal_id = selected_external_principal_id
    ) THEN
      RAISE EXCEPTION 'OIDC identity is already assigned'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  SELECT signup.user_id INTO selected_user_id
  FROM auth_organization_signups signup
  JOIN auth_email_outbox outbox
    ON outbox.id = selected_outbox_id
   AND outbox.user_id = signup.user_id
   AND outbox.template_type = 'ORGANIZATION_SIGNUP'
   AND outbox.status = 'PENDING'
  WHERE signup.id = selected_signup_id
    AND signup.token_id IS NOT NULL
    AND signup.status = 'PENDING'
  FOR UPDATE OF signup, outbox;
  IF selected_user_id IS NULL THEN
    RAISE EXCEPTION 'Organization signup state changed during OIDC binding'
      USING ERRCODE = '40001';
  END IF;

  UPDATE auth_organization_signups signup SET
    oidc_issuer = selected_issuer,
    oidc_external_tenant_id = selected_external_tenant_id,
    oidc_external_principal_id = selected_external_principal_id,
    oidc_credential_hash = selected_credential_hash
  WHERE signup.id = selected_signup_id;
  UPDATE auth_email_outbox outbox SET
    template_data = CASE
      WHEN clearing_binding THEN outbox.template_data - 'authentication'
      ELSE outbox.template_data || jsonb_build_object('authentication', 'OIDC')
    END
  WHERE outbox.id = selected_outbox_id;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.auth_configure_organization_signup_oidc(
  uuid, uuid, text, text, text, text
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_accept_local_organization_signup(
  selected_token_hash text,
  selected_password_hash text,
  selected_factor_id uuid,
  selected_factor_secret_ciphertext text,
  selected_setup_token_hash text,
  selected_request_id text
)
RETURNS TABLE(user_id uuid, email_ciphertext text, organization_name text, factor_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  selected_signup_id uuid;
BEGIN
  SELECT signup.id INTO selected_signup_id
  FROM auth_organization_signups signup
  JOIN auth_one_time_tokens token ON token.id = signup.token_id
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'ORGANIZATION_SIGNUP'
    AND token.consumed_at IS NULL
    AND token.available_at <= now()
    AND token.expires_at > now()
    AND signup.status = 'PENDING'
    AND signup.expires_at > now()
    AND signup.oidc_issuer IS NULL
    AND signup.oidc_external_tenant_id IS NULL
    AND signup.oidc_external_principal_id IS NULL
    AND signup.oidc_credential_hash IS NULL
  FOR UPDATE OF signup;
  IF selected_signup_id IS NULL THEN RETURN; END IF;

  RETURN QUERY SELECT accepted.user_id, accepted.email_ciphertext,
    accepted.organization_name, accepted.factor_id
  FROM app.auth_accept_organization_signup(
    selected_token_hash,
    selected_password_hash,
    selected_factor_id,
    selected_factor_secret_ciphertext,
    selected_setup_token_hash,
    selected_request_id
  ) accepted;
END
$$;
REVOKE ALL ON FUNCTION app.auth_accept_local_organization_signup(
  text, text, uuid, text, text, text
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_resolve_oidc_identity(
  selected_issuer text,
  selected_external_tenant_id text,
  selected_external_principal_id text
)
RETURNS TABLE(user_id uuid, organization_id uuid, membership_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT identity.user_id, membership.organization_id, membership.id
  FROM auth_oidc_identities identity
  JOIN users selected_user
    ON selected_user.id = identity.user_id
   AND selected_user.active
   AND NOT selected_user.is_demo
   AND selected_user.email_verified_at IS NOT NULL
  JOIN organization_memberships membership
    ON membership.user_id = identity.user_id
   AND membership.active
  JOIN organizations organization
    ON organization.id = membership.organization_id
   AND organization.active
   AND NOT organization.is_demo
   AND organization.organization_mode = 'REAL'
  WHERE identity.issuer = selected_issuer
    AND identity.external_tenant_id = selected_external_tenant_id
    AND identity.external_principal_id = selected_external_principal_id
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.auth_resolve_oidc_identity(text, text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_accept_oidc_organization_signup(
  selected_token_hash text,
  selected_password_hash text,
  selected_password_enabled boolean,
  selected_factor_id uuid,
  selected_factor_secret_ciphertext text,
  selected_setup_token_hash text,
  selected_request_id text,
  selected_issuer text,
  selected_external_tenant_id text,
  selected_external_principal_id text
)
RETURNS TABLE(user_id uuid, email_ciphertext text, organization_name text, factor_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  selected_signup auth_organization_signups%ROWTYPE;
  accepted_user_id uuid;
  accepted_email_ciphertext text;
  accepted_organization_name text;
  accepted_factor_id uuid;
BEGIN
  IF selected_password_hash NOT LIKE 'scrypt-v1$32768$8$1$%'
    OR length(selected_request_id) NOT BETWEEN 1 AND 200
    OR selected_request_id ~ E'[\\r\\n]' THEN
    RAISE EXCEPTION 'Invalid OIDC signup acceptance request'
      USING ERRCODE = '22023';
  END IF;

  SELECT signup.* INTO selected_signup
  FROM auth_organization_signups signup
  JOIN auth_one_time_tokens token ON token.id = signup.token_id
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'ORGANIZATION_SIGNUP'
    AND token.consumed_at IS NULL
    AND token.available_at <= now()
    AND token.expires_at > now()
    AND signup.status = 'PENDING'
    AND signup.expires_at > now()
    AND signup.oidc_issuer IS NOT NULL
    AND signup.oidc_external_tenant_id IS NOT NULL
    AND signup.oidc_external_principal_id IS NOT NULL
    AND signup.oidc_credential_hash ~ '^[0-9a-f]{64}$'
    AND signup.oidc_issuer = selected_issuer
    AND signup.oidc_external_tenant_id = selected_external_tenant_id
    AND signup.oidc_external_principal_id = selected_external_principal_id
  FOR UPDATE OF signup;
  IF selected_signup.id IS NULL THEN RETURN; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|oidc-identity|' || selected_signup.oidc_issuer || '|' ||
    selected_signup.oidc_external_tenant_id || '|' ||
    selected_signup.oidc_external_principal_id, 0
  ));
  IF EXISTS (
    SELECT 1 FROM auth_oidc_identities identity
    WHERE identity.issuer = selected_signup.oidc_issuer
      AND identity.external_tenant_id = selected_signup.oidc_external_tenant_id
      AND identity.external_principal_id = selected_signup.oidc_external_principal_id
  ) OR EXISTS (
    SELECT 1 FROM auth_oidc_identities identity
    WHERE identity.user_id = selected_signup.user_id
  ) THEN
    RETURN;
  END IF;

  SELECT accepted.user_id, accepted.email_ciphertext,
    accepted.organization_name, accepted.factor_id
  INTO accepted_user_id, accepted_email_ciphertext,
    accepted_organization_name, accepted_factor_id
  FROM app.auth_accept_organization_signup(
    selected_token_hash,
    selected_password_hash,
    selected_factor_id,
    selected_factor_secret_ciphertext,
    selected_setup_token_hash,
    selected_request_id
  ) accepted;
  IF accepted_user_id IS NULL THEN RETURN; END IF;

  IF NOT selected_password_enabled THEN
    UPDATE users SET password_hash = '!oidc-only!', password_changed_at = NULL
    WHERE id = accepted_user_id AND NOT active AND NOT is_demo;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OIDC-only password state changed during signup'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  INSERT INTO auth_oidc_identities(
    issuer, external_tenant_id, external_principal_id, user_id
  ) VALUES (
    selected_signup.oidc_issuer,
    selected_signup.oidc_external_tenant_id,
    selected_signup.oidc_external_principal_id,
    accepted_user_id
  );
  INSERT INTO auth_security_events(
    user_id, organization_id, event_type, outcome, request_id, metadata
  ) VALUES (
    accepted_user_id, selected_signup.organization_id,
    'OIDC_IDENTITY_LINKED', 'SUCCESS', selected_request_id,
    jsonb_build_object(
      'credentialHash', selected_signup.oidc_credential_hash,
      'passwordEnabled', selected_password_enabled,
      'source', 'ORGANIZATION_SIGNUP'
    )
  );

  RETURN QUERY SELECT accepted_user_id, accepted_email_ciphertext,
    accepted_organization_name, accepted_factor_id;
EXCEPTION WHEN unique_violation THEN
  RETURN;
END
$$;
REVOKE ALL ON FUNCTION app.auth_accept_oidc_organization_signup(
  text, text, boolean, uuid, text, text, text, text, text, text
) FROM PUBLIC;
--> statement-breakpoint

COMMENT ON TABLE auth_oidc_identities IS
  'Exact immutable Entra issuer/tenant/object bindings; mutable email claims never authorize or link Business accounts.';
COMMENT ON FUNCTION app.auth_configure_organization_signup_oidc(
  uuid, uuid, text, text, text, text
) IS 'Atomically selects local or exact-Entra identity proof for a pending owner signup and its verification email.';
COMMENT ON FUNCTION app.auth_accept_local_organization_signup(
  text, text, uuid, text, text, text
) IS 'Accepts only password-originated owner signups so URL changes cannot downgrade an Entra-bound signup.';
COMMENT ON FUNCTION app.auth_resolve_oidc_identity(text, text, text) IS
  'Resolves an exact persisted Entra identity only to one active real Business membership.';
COMMENT ON FUNCTION app.auth_accept_oidc_organization_signup(
  text, text, boolean, uuid, text, text, text, text, text, text
) IS 'Verifies contact-email possession plus a fresh matching Entra principal, provisions the owner workspace, and binds the exact identity without email matching.';
--> statement-breakpoint

DO $entra_signup_grants$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app'
  ) THEN
    GRANT EXECUTE ON FUNCTION app.auth_configure_organization_signup_oidc(
      uuid, uuid, text, text, text, text
    ) TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.auth_accept_local_organization_signup(
      text, text, uuid, text, text, text
    ) TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.auth_resolve_oidc_identity(
      text, text, text
    ) TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.auth_accept_oidc_organization_signup(
      text, text, boolean, uuid, text, text, text, text, text, text
    ) TO business_finlynq_app;
  END IF;
END
$entra_signup_grants$;
