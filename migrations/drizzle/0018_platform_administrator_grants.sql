-- Platform administrators are a control-plane concern, never a tenant role.
-- A blind-indexed grant may exist before signup, but it is linked only after
-- the matching real identity is email verified, active, and protected by MFA.
CREATE TABLE platform_administrator_grants (
  id uuid PRIMARY KEY,
  email_lookup_hash text NOT NULL,
  email_ciphertext text NOT NULL,
  role_key text NOT NULL DEFAULT 'PLATFORM_ADMINISTRATOR',
  status text NOT NULL DEFAULT 'GRANTED',
  linked_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  linked_at timestamp with time zone,
  granted_by text NOT NULL,
  grant_reason text NOT NULL,
  grant_request_id text NOT NULL,
  granted_at timestamp with time zone NOT NULL DEFAULT now(),
  revoked_by text,
  revocation_reason text,
  revoked_at timestamp with time zone,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT platform_administrator_grants_email_hash_check
    CHECK (email_lookup_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_administrator_grants_ciphertext_check
    CHECK (length(email_ciphertext) BETWEEN 40 AND 4000),
  CONSTRAINT platform_administrator_grants_role_check
    CHECK (role_key = 'PLATFORM_ADMINISTRATOR'),
  CONSTRAINT platform_administrator_grants_status_check
    CHECK (status IN ('GRANTED', 'REVOKED')),
  CONSTRAINT platform_administrator_grants_actor_check
    CHECK (length(btrim(granted_by)) BETWEEN 3 AND 200),
  CONSTRAINT platform_administrator_grants_reason_check
    CHECK (length(btrim(grant_reason)) BETWEEN 10 AND 500),
  CONSTRAINT platform_administrator_grants_request_check
    CHECK (length(btrim(grant_request_id)) BETWEEN 1 AND 200),
  CONSTRAINT platform_administrator_grants_version_check CHECK (version > 0),
  CONSTRAINT platform_administrator_grants_link_check CHECK (
    (linked_user_id IS NULL AND linked_at IS NULL)
    OR (linked_user_id IS NOT NULL AND linked_at IS NOT NULL)
  ),
  CONSTRAINT platform_administrator_grants_revocation_check CHECK (
    (status = 'GRANTED'
      AND revoked_by IS NULL AND revocation_reason IS NULL AND revoked_at IS NULL)
    OR
    (status = 'REVOKED'
      AND linked_user_id IS NULL AND linked_at IS NULL
      AND length(btrim(revoked_by)) BETWEEN 3 AND 200
      AND length(btrim(revocation_reason)) BETWEEN 10 AND 500
      AND revoked_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX platform_administrator_grants_email_unique
  ON platform_administrator_grants(email_lookup_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX platform_administrator_grants_linked_user_unique
  ON platform_administrator_grants(linked_user_id)
  WHERE linked_user_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE platform_administrator_grant_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES platform_administrator_grants(id) ON DELETE RESTRICT,
  subject_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  actor text NOT NULL,
  request_id text NOT NULL,
  reason text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT platform_administrator_grant_events_type_check CHECK (
    event_type IN (
      'GRANT_CREATED', 'IDENTITY_LINKED', 'IDENTITY_ASSURANCE_CONFIRMED',
      'IDENTITY_UNLINKED', 'GRANT_REVOKED'
    )
  ),
  CONSTRAINT platform_administrator_grant_events_actor_check
    CHECK (length(btrim(actor)) BETWEEN 3 AND 200),
  CONSTRAINT platform_administrator_grant_events_request_check
    CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  CONSTRAINT platform_administrator_grant_events_reason_check
    CHECK (length(btrim(reason)) BETWEEN 10 AND 500)
);
--> statement-breakpoint
CREATE INDEX platform_administrator_grant_events_grant_created_idx
  ON platform_administrator_grant_events(grant_id, created_at);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_platform_administrator_grant_event_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Platform administrator grant events are append-only'
    USING ERRCODE = '55000';
END
$$;
--> statement-breakpoint
CREATE TRIGGER platform_administrator_grant_events_append_only
  BEFORE UPDATE OR DELETE ON platform_administrator_grant_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_platform_administrator_grant_event_immutable();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_platform_administrator_grant_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Platform administrator grants cannot be deleted; revoke them explicitly'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.email_lookup_hash IS DISTINCT FROM NEW.email_lookup_hash
    OR OLD.email_ciphertext IS DISTINCT FROM NEW.email_ciphertext
    OR OLD.role_key IS DISTINCT FROM NEW.role_key
    OR OLD.granted_by IS DISTINCT FROM NEW.granted_by
    OR OLD.grant_reason IS DISTINCT FROM NEW.grant_reason
    OR OLD.grant_request_id IS DISTINCT FROM NEW.grant_request_id
    OR OLD.granted_at IS DISTINCT FROM NEW.granted_at THEN
    RAISE EXCEPTION 'Platform administrator grant identity and provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'REVOKED' THEN
    RAISE EXCEPTION 'A revoked platform administrator grant cannot be changed'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.linked_user_id IS NOT NULL AND NEW.linked_user_id IS NOT NULL
    AND OLD.linked_user_id IS DISTINCT FROM NEW.linked_user_id THEN
    RAISE EXCEPTION 'A platform administrator grant cannot be relinked to another identity'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.linked_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users selected_user
    WHERE selected_user.id = NEW.linked_user_id
      AND selected_user.email_lookup_hash = NEW.email_lookup_hash
      AND selected_user.active
      AND NOT selected_user.is_demo
      AND selected_user.email_verified_at IS NOT NULL
      AND selected_user.mfa_required
      AND EXISTS (
        SELECT 1 FROM auth_mfa_factors factor
        WHERE factor.user_id = selected_user.id
          AND factor.status = 'ACTIVE'
          AND factor.verified_at IS NOT NULL
          AND factor.revoked_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'Platform administrator linkage requires a matching verified real identity with active MFA'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'Platform administrator grant changes require a monotonic version and timestamp'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER platform_administrator_grants_controlled_mutation
  BEFORE UPDATE OR DELETE ON platform_administrator_grants
  FOR EACH ROW EXECUTE FUNCTION app.guard_platform_administrator_grant_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_platform_administrator_grant_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  audit_request_id text := coalesce(
    nullif(current_setting('app.request_id', true), ''),
    'identity-sync:' || gen_random_uuid()::text
  );
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO platform_administrator_grant_events(
      grant_id,event_type,actor,request_id,reason
    ) VALUES (
      NEW.id,'GRANT_CREATED',NEW.granted_by,NEW.grant_request_id,NEW.grant_reason
    );
  ELSIF OLD.status = 'GRANTED' AND NEW.status = 'REVOKED' THEN
    INSERT INTO platform_administrator_grant_events(
      grant_id,subject_user_id,event_type,actor,request_id,reason
    ) VALUES (
      NEW.id,OLD.linked_user_id,'GRANT_REVOKED',NEW.revoked_by,
      audit_request_id,NEW.revocation_reason
    );
  ELSIF OLD.linked_user_id IS NULL AND NEW.linked_user_id IS NOT NULL THEN
    INSERT INTO platform_administrator_grant_events(
      grant_id,subject_user_id,event_type,actor,request_id,reason
    ) VALUES (
      NEW.id,NEW.linked_user_id,'IDENTITY_LINKED','system:identity-assurance',
      audit_request_id,'Verified active real identity with active MFA matched the reserved grant'
    );
  ELSIF OLD.linked_user_id IS NOT NULL AND NEW.linked_user_id IS NULL THEN
    INSERT INTO platform_administrator_grant_events(
      grant_id,subject_user_id,event_type,actor,request_id,reason
    ) VALUES (
      NEW.id,OLD.linked_user_id,'IDENTITY_UNLINKED','system:identity-assurance',
      audit_request_id,'Identity assurance no longer satisfies the platform administrator grant'
    );
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER platform_administrator_grants_audit
  AFTER INSERT OR UPDATE ON platform_administrator_grants
  FOR EACH ROW EXECUTE FUNCTION app.audit_platform_administrator_grant_change();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.sync_platform_administrator_grant_for_identity(
  selected_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_identity users%ROWTYPE;
  identity_is_eligible boolean := false;
BEGIN
  SELECT * INTO selected_identity FROM users WHERE id = selected_user_id;
  IF selected_identity.id IS NULL THEN RETURN; END IF;

  -- A future verified email-change workflow must never leave authorization
  -- attached to the prior blind index.
  UPDATE platform_administrator_grants grant_record SET
    linked_user_id = NULL,
    linked_at = NULL,
    version = grant_record.version + 1,
    updated_at = greatest(clock_timestamp(), grant_record.updated_at + interval '1 microsecond')
  WHERE grant_record.linked_user_id = selected_identity.id
    AND grant_record.email_lookup_hash <> selected_identity.email_lookup_hash
    AND grant_record.status = 'GRANTED';

  identity_is_eligible := selected_identity.active
    AND NOT selected_identity.is_demo
    AND selected_identity.email_verified_at IS NOT NULL
    AND selected_identity.mfa_required
    AND EXISTS (
      SELECT 1 FROM auth_mfa_factors factor
      WHERE factor.user_id = selected_identity.id
        AND factor.status = 'ACTIVE'
        AND factor.verified_at IS NOT NULL
        AND factor.revoked_at IS NULL
    );

  UPDATE platform_administrator_grants grant_record SET
    linked_user_id = CASE WHEN identity_is_eligible THEN selected_identity.id ELSE NULL END,
    linked_at = CASE WHEN identity_is_eligible THEN coalesce(grant_record.linked_at, now()) ELSE NULL END,
    version = grant_record.version + 1,
    updated_at = greatest(clock_timestamp(), grant_record.updated_at + interval '1 microsecond')
  WHERE grant_record.email_lookup_hash = selected_identity.email_lookup_hash
    AND grant_record.status = 'GRANTED'
    AND grant_record.linked_user_id IS DISTINCT FROM
      CASE WHEN identity_is_eligible THEN selected_identity.id ELSE NULL END;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.sync_platform_administrator_grant_from_user_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM app.sync_platform_administrator_grant_for_identity(NEW.id);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER users_sync_platform_administrator_grant
  AFTER INSERT OR UPDATE OF email_lookup_hash,active,is_demo,mfa_required,email_verified_at ON users
  FOR EACH ROW EXECUTE FUNCTION app.sync_platform_administrator_grant_from_user_trigger();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.sync_platform_administrator_grant_from_mfa_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app.sync_platform_administrator_grant_for_identity(OLD.user_id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    PERFORM app.sync_platform_administrator_grant_for_identity(OLD.user_id);
  END IF;
  PERFORM app.sync_platform_administrator_grant_for_identity(NEW.user_id);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER auth_mfa_factors_sync_platform_administrator_grant
  AFTER INSERT OR UPDATE OF user_id,status,verified_at,revoked_at OR DELETE ON auth_mfa_factors
  FOR EACH ROW EXECUTE FUNCTION app.sync_platform_administrator_grant_from_mfa_trigger();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.sync_platform_administrator_grant_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
BEGIN
  SELECT id INTO selected_user_id FROM users
  WHERE email_lookup_hash = NEW.email_lookup_hash;
  IF selected_user_id IS NOT NULL THEN
    PERFORM app.sync_platform_administrator_grant_for_identity(selected_user_id);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER platform_administrator_grants_sync_after_insert
  AFTER INSERT ON platform_administrator_grants
  FOR EACH ROW EXECUTE FUNCTION app.sync_platform_administrator_grant_after_insert();
--> statement-breakpoint

-- Linkage is performed before the authentication procedure writes its
-- security event. Append a second immutable event carrying that procedure's
-- request id so incident review can correlate the assurance transition.
CREATE OR REPLACE FUNCTION app.audit_platform_administrator_identity_assurance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL
    AND NEW.outcome = 'SUCCESS'
    AND NEW.event_type IN ('MFA_ENROLLED', 'PASSWORD_RESET_MFA_REPLACED') THEN
    INSERT INTO platform_administrator_grant_events(
      grant_id,subject_user_id,event_type,actor,request_id,reason,metadata
    )
    SELECT grant_record.id,NEW.user_id,'IDENTITY_ASSURANCE_CONFIRMED',
      'system:authentication',NEW.request_id,
      'Authentication security event confirmed active platform administrator identity assurance',
      jsonb_build_object(
        'authenticationEventId',NEW.id,
        'authenticationEventType',NEW.event_type
      )
    FROM platform_administrator_grants grant_record
    JOIN users selected_user ON selected_user.id = grant_record.linked_user_id
    WHERE grant_record.linked_user_id = NEW.user_id
      AND grant_record.status = 'GRANTED'
      AND selected_user.active AND NOT selected_user.is_demo
      AND selected_user.email_verified_at IS NOT NULL
      AND selected_user.mfa_required
      AND EXISTS (
        SELECT 1 FROM auth_mfa_factors factor
        WHERE factor.user_id = selected_user.id
          AND factor.status = 'ACTIVE'
          AND factor.verified_at IS NOT NULL
          AND factor.revoked_at IS NULL
      );
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER auth_security_events_correlate_platform_administrator
  AFTER INSERT ON auth_security_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_platform_administrator_identity_assurance();
--> statement-breakpoint

-- This is recognition only. Future control-plane mutations must independently
-- require this role and fresh step-up inside their own SECURITY DEFINER unit.
CREATE OR REPLACE FUNCTION app.auth_platform_administrator_authorization(
  selected_session_id uuid,
  selected_user_id uuid
)
RETURNS TABLE(
  grant_id uuid,
  role_key text,
  mfa_verified_at timestamp with time zone,
  step_up_expires_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT grant_record.id, grant_record.role_key,
    selected_session.mfa_verified_at, selected_session.step_up_expires_at
  FROM auth_sessions selected_session
  JOIN users selected_user ON selected_user.id = selected_session.user_id
  JOIN organization_memberships membership
    ON membership.id = selected_session.membership_id
   AND membership.organization_id = selected_session.organization_id
   AND membership.user_id = selected_session.user_id
  JOIN organizations organization
    ON organization.id = selected_session.organization_id
  JOIN platform_administrator_grants grant_record
    ON grant_record.linked_user_id = selected_user.id
  WHERE selected_session.id = selected_session_id
    AND selected_session.user_id = selected_user_id
    AND selected_session.session_mode = 'REAL'
    AND selected_session.revoked_at IS NULL
    AND selected_session.expires_at > now()
    AND selected_session.idle_expires_at > now()
    AND selected_session.mfa_verified_at IS NOT NULL
    AND selected_user.active
    AND NOT selected_user.is_demo
    AND selected_user.email_verified_at IS NOT NULL
    AND selected_user.mfa_required
    AND membership.active
    AND organization.active
    AND NOT organization.is_demo
    AND organization.organization_mode = 'REAL'
    AND grant_record.status = 'GRANTED'
    AND grant_record.role_key = 'PLATFORM_ADMINISTRATOR'
    AND EXISTS (
      SELECT 1 FROM auth_mfa_factors factor
      WHERE factor.user_id = selected_user.id
        AND factor.status = 'ACTIVE'
        AND factor.verified_at IS NOT NULL
        AND factor.revoked_at IS NULL
    )
  LIMIT 1
$$;
--> statement-breakpoint

-- This read surface intentionally exposes aggregate control-plane health only:
-- no organization names, identity fields, ledger data, or tenant records. The
-- authorization check is performed within the same statement that reads the
-- aggregates so callers cannot substitute a stale UI authorization decision.
CREATE OR REPLACE FUNCTION app.platform_administration_overview(
  selected_session_id uuid,
  selected_user_id uuid
)
RETURNS TABLE(
  active_real_organization_count bigint,
  active_real_user_count bigint,
  active_real_session_count bigint,
  pending_platform_administrator_count bigint,
  linked_platform_administrator_count bigint,
  generated_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH authorization AS (
    SELECT * FROM app.auth_platform_administrator_authorization(
      selected_session_id,
      selected_user_id
    )
  )
  SELECT
    (
      SELECT count(*) FROM organizations organization
      WHERE organization.active
        AND NOT organization.is_demo
        AND organization.organization_mode = 'REAL'
    ),
    (
      SELECT count(DISTINCT selected_member.id)
      FROM organization_memberships membership
      JOIN organizations organization
        ON organization.id = membership.organization_id
      JOIN users selected_member ON selected_member.id = membership.user_id
      WHERE membership.active
        AND organization.active
        AND NOT organization.is_demo
        AND organization.organization_mode = 'REAL'
        AND selected_member.active
        AND NOT selected_member.is_demo
    ),
    (
      SELECT count(*)
      FROM auth_sessions selected_session
      JOIN organization_memberships membership
        ON membership.id = selected_session.membership_id
       AND membership.organization_id = selected_session.organization_id
       AND membership.user_id = selected_session.user_id
      JOIN organizations organization
        ON organization.id = selected_session.organization_id
      JOIN users session_user ON session_user.id = selected_session.user_id
      WHERE selected_session.session_mode = 'REAL'
        AND selected_session.revoked_at IS NULL
        AND selected_session.expires_at > now()
        AND selected_session.idle_expires_at > now()
        AND membership.active
        AND organization.active
        AND NOT organization.is_demo
        AND organization.organization_mode = 'REAL'
        AND session_user.active
        AND NOT session_user.is_demo
    ),
    (
      SELECT count(*) FROM platform_administrator_grants grant_record
      WHERE grant_record.status = 'GRANTED'
        AND grant_record.linked_user_id IS NULL
    ),
    (
      SELECT count(*) FROM platform_administrator_grants grant_record
      WHERE grant_record.status = 'GRANTED'
        AND grant_record.linked_user_id IS NOT NULL
    ),
    statement_timestamp()
  FROM authorization
$$;
--> statement-breakpoint

REVOKE ALL ON platform_administrator_grants,
  platform_administrator_grant_events FROM PUBLIC;
REVOKE ALL ON FUNCTION
  app.guard_platform_administrator_grant_event_immutable(),
  app.guard_platform_administrator_grant_mutation(),
  app.audit_platform_administrator_grant_change(),
  app.sync_platform_administrator_grant_for_identity(uuid),
  app.sync_platform_administrator_grant_from_user_trigger(),
  app.sync_platform_administrator_grant_from_mfa_trigger(),
  app.sync_platform_administrator_grant_after_insert(),
  app.audit_platform_administrator_identity_assurance(),
  app.auth_platform_administrator_authorization(uuid,uuid),
  app.platform_administration_overview(uuid,uuid)
FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON platform_administrator_grants,
      platform_administrator_grant_events FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION
      app.auth_platform_administrator_authorization(uuid,uuid)
    TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION
      app.platform_administration_overview(uuid,uuid)
    TO business_finlynq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_auth_worker') THEN
    REVOKE ALL ON platform_administrator_grants,
      platform_administrator_grant_events FROM business_finlynq_auth_worker;
    REVOKE EXECUTE ON FUNCTION
      app.auth_platform_administrator_authorization(uuid,uuid)
    FROM business_finlynq_auth_worker;
    REVOKE EXECUTE ON FUNCTION
      app.platform_administration_overview(uuid,uuid)
    FROM business_finlynq_auth_worker;
  END IF;
END
$$;
