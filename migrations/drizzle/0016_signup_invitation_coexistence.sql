-- Forward-only repair for signup/invitation identity reservations. A public
-- signup request is not proof of email ownership and must not block an
-- administrator invitation. Both flows share one deterministic account lock;
-- the first link that proves email control makes the other terminal.

CREATE OR REPLACE FUNCTION app.auth_begin_organization_signup(
  selected_signup_id uuid,
  selected_user_id uuid,
  selected_organization_id uuid,
  selected_token_id uuid,
  selected_email_hash text,
  selected_email_ciphertext text,
  selected_display_name_ciphertext text,
  selected_organization_slug text,
  selected_organization_name text,
  selected_entity_code text,
  selected_entity_name text,
  selected_country_code text,
  selected_region_code text,
  selected_functional_currency text,
  selected_accounting_profile accounting_profile,
  selected_fiscal_year integer,
  selected_manual_posting_mode manual_posting_mode,
  selected_key_provider text,
  selected_wrapped_dek text,
  selected_token_hash text,
  selected_payload_ciphertext text,
  selected_outbox_id uuid,
  selected_ip_hash text,
  selected_request_id text,
  selected_terms_version text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing_user users%ROWTYPE;
  existing_signup auth_organization_signups%ROWTYPE;
  effective_user_id uuid := selected_user_id;
  reusing_invitation_identity boolean := false;
  foreign_membership_conflict boolean := false;
  envelope jsonb;
BEGIN
  IF selected_signup_id IS NULL OR selected_user_id IS NULL
    OR selected_organization_id IS NULL OR selected_token_id IS NULL
    OR selected_outbox_id IS NULL
    OR selected_email_hash !~ '^[0-9a-f]{64}$'
    OR length(selected_email_ciphertext) NOT BETWEEN 40 AND 4000
    OR length(selected_display_name_ciphertext) NOT BETWEEN 40 AND 4000
    OR selected_organization_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$'
    OR length(selected_organization_name) NOT BETWEEN 2 AND 200
    OR selected_entity_code !~ '^[A-Z0-9][A-Z0-9_-]{0,15}$'
    OR selected_entity_code = '0000'
    OR length(selected_entity_name) NOT BETWEEN 2 AND 200
    OR selected_region_code !~ '^[A-Z0-9-]{2,10}$'
    OR selected_fiscal_year NOT BETWEEN 2000 AND 2200
    OR length(selected_key_provider) NOT BETWEEN 1 AND 100
    OR length(selected_wrapped_dek) NOT BETWEEN 40 AND 4000
    OR length(selected_token_hash) NOT BETWEEN 32 AND 200
    OR length(selected_payload_ciphertext) NOT BETWEEN 40 AND 4000
    OR length(selected_ip_hash) NOT BETWEEN 32 AND 200
    OR length(selected_request_id) NOT BETWEEN 1 AND 200
    OR length(selected_terms_version) NOT BETWEEN 1 AND 40
    OR NOT (
      (selected_country_code = 'CA' AND selected_functional_currency = 'CAD'
        AND selected_accounting_profile = 'CAN_ASPE')
      OR
      (selected_country_code = 'US' AND selected_functional_currency = 'USD'
        AND selected_accounting_profile = 'US_GAAP_NONPUBLIC')
    ) THEN
    RAISE EXCEPTION 'Invalid organization signup request' USING ERRCODE = '22023';
  END IF;

  BEGIN
    envelope := selected_wrapped_dek::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Organization key envelope must be valid JSON' USING ERRCODE = '22023';
  END;
  IF envelope->>'format' <> 'business-finlynq-wrapped-key-v1'
    OR envelope->>'provider' <> selected_key_provider
    OR envelope->>'keyVersion' <> '1' THEN
    RAISE EXCEPTION 'Organization key envelope metadata is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_hash, 0
  ));

  SELECT selected_user.* INTO existing_user
  FROM users selected_user
  WHERE selected_user.email_lookup_hash = selected_email_hash
  FOR UPDATE;

  IF existing_user.id IS NOT NULL THEN
    SELECT signup.* INTO existing_signup
    FROM auth_organization_signups signup
    WHERE signup.user_id = existing_user.id
    FOR UPDATE;
    effective_user_id := existing_user.id;
    IF existing_signup.id IS NULL THEN
      IF existing_user.active OR existing_user.is_demo
        OR existing_user.email_verified_at IS NOT NULL
        OR existing_user.password_hash <> '!invitation-pending!'
        OR NOT EXISTS (
          SELECT 1 FROM organization_memberships membership
          WHERE membership.user_id = existing_user.id
        )
        OR EXISTS (
          SELECT 1 FROM organization_memberships membership
          WHERE membership.user_id = existing_user.id AND membership.active
        )
        OR EXISTS (
          SELECT 1 FROM organization_memberships membership
          LEFT JOIN organization_invitations invitation
            ON invitation.organization_id = membership.organization_id
           AND invitation.membership_id = membership.id
           AND invitation.user_id = membership.user_id
          WHERE membership.user_id = existing_user.id
            AND (
              invitation.id IS NULL
              OR invitation.status NOT IN ('PENDING', 'CANCELLED')
            )
        )
        OR EXISTS (
          SELECT 1 FROM auth_mfa_factors factor
          WHERE factor.user_id = existing_user.id
            AND factor.status IN ('PENDING', 'ACTIVE')
        ) THEN
        RETURN false;
      END IF;
      reusing_invitation_identity := true;
    ELSIF existing_user.active OR existing_user.is_demo
      OR existing_signup.id <> selected_signup_id
      OR existing_signup.organization_id <> selected_organization_id
      OR (
        existing_signup.accepted_at IS NULL
        AND existing_signup.status NOT IN ('PENDING', 'EXPIRED')
      )
      OR (
        existing_signup.accepted_at IS NOT NULL
        AND existing_signup.status NOT IN ('PENDING', 'ENROLLING')
      ) THEN
      RETURN false;
    ELSIF existing_signup.accepted_at IS NULL AND (
      existing_user.email_verified_at IS NOT NULL
      OR existing_user.password_hash NOT IN (
        '!organization-signup-pending!', '!invitation-pending!'
      )
      OR EXISTS (
        SELECT 1 FROM auth_mfa_factors factor
        WHERE factor.user_id = existing_user.id
          AND factor.status IN ('PENDING', 'ACTIVE')
      )
      OR EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.user_id = existing_user.id AND membership.active
      )
    ) THEN
      -- A verified invitation enrollment must never be reset by an
      -- unverified owner-signup retry.
      RETURN false;
    ELSIF existing_signup.accepted_at IS NOT NULL AND (
      existing_user.email_verified_at IS NULL
      OR existing_user.password_hash NOT LIKE 'scrypt-v1$32768$8$1$%'
      OR EXISTS (
        SELECT 1 FROM auth_mfa_factors factor
        WHERE factor.user_id = existing_user.id AND factor.status = 'ACTIVE'
      )
      OR EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.user_id = existing_user.id AND membership.active
      )
      OR EXISTS (
        SELECT 1 FROM auth_one_time_tokens setup_token
        WHERE setup_token.user_id = existing_user.id
          AND setup_token.organization_id = existing_signup.organization_id
          AND setup_token.purpose = 'MFA_SETUP'
          AND setup_token.consumed_at IS NULL
          AND setup_token.available_at <= now()
          AND setup_token.expires_at > now()
      )
    ) THEN
      RETURN false;
    END IF;

    IF NOT reusing_invitation_identity AND EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.user_id = existing_user.id
        AND membership.organization_id <> existing_signup.organization_id
    ) THEN
      SELECT coalesce(bool_or(
        membership.active
        OR invitation.id IS NULL
        OR CASE WHEN existing_signup.accepted_at IS NOT NULL
          THEN invitation.status <> 'SUPERSEDED'
          ELSE invitation.status NOT IN ('PENDING', 'CANCELLED')
        END
      ), false)
      INTO foreign_membership_conflict
      FROM organization_memberships membership
      LEFT JOIN organization_invitations invitation
        ON invitation.organization_id = membership.organization_id
       AND invitation.membership_id = membership.id
       AND invitation.user_id = membership.user_id
      WHERE membership.user_id = existing_user.id
        AND membership.organization_id <> existing_signup.organization_id;
      IF foreign_membership_conflict THEN RETURN false; END IF;
    END IF;

    IF NOT reusing_invitation_identity
      AND existing_user.id = selected_user_id THEN
      UPDATE users SET
        email_ciphertext = selected_email_ciphertext,
        display_name_ciphertext = selected_display_name_ciphertext
      WHERE id = existing_user.id;
    END IF;
  ELSE
    INSERT INTO users(
      id, email_lookup_hash, email_ciphertext, display_name_ciphertext,
      password_hash, active, is_demo, mfa_required
    ) VALUES (
      selected_user_id, selected_email_hash, selected_email_ciphertext,
      selected_display_name_ciphertext, '!organization-signup-pending!',
      false, false, true
    );
  END IF;

  UPDATE auth_one_time_tokens SET consumed_at = coalesce(consumed_at, now())
  WHERE user_id = effective_user_id
    AND purpose IN ('ORGANIZATION_SIGNUP', 'MFA_SETUP')
    AND consumed_at IS NULL;
  UPDATE auth_email_outbox SET status = 'DEAD', last_error_code = 'superseded'
  WHERE user_id = effective_user_id AND template_type = 'ORGANIZATION_SIGNUP'
    AND status = 'PENDING';

  INSERT INTO auth_one_time_tokens(
    id, token_hash, purpose, user_id, requested_ip_hash, expires_at
  ) VALUES (
    selected_token_id, selected_token_hash, 'ORGANIZATION_SIGNUP',
    effective_user_id, selected_ip_hash, now() + interval '24 hours'
  );

  IF existing_signup.id IS NULL THEN
    INSERT INTO auth_organization_signups(
      id, token_id, user_id, identity_encryption_user_id,
      requested_email_ciphertext, requested_display_name_ciphertext,
      organization_id, organization_slug,
      organization_name, entity_code, entity_name, country_code, region_code,
      functional_currency, accounting_profile, fiscal_year,
      manual_posting_mode, key_provider, wrapped_dek, terms_version,
      status, expires_at
    ) VALUES (
      selected_signup_id, selected_token_id, effective_user_id,
      selected_user_id, selected_email_ciphertext,
      selected_display_name_ciphertext,
      selected_organization_id, selected_organization_slug,
      selected_organization_name, selected_entity_code, selected_entity_name,
      selected_country_code, selected_region_code, selected_functional_currency,
      selected_accounting_profile, selected_fiscal_year,
      selected_manual_posting_mode, selected_key_provider,
      selected_wrapped_dek, selected_terms_version, 'PENDING',
      now() + interval '24 hours'
    );
  ELSE
    UPDATE auth_organization_signups signup SET
      token_id = selected_token_id,
      identity_encryption_user_id = CASE WHEN signup.accepted_at IS NULL
        THEN selected_user_id ELSE signup.identity_encryption_user_id END,
      requested_email_ciphertext = CASE WHEN signup.accepted_at IS NULL
        THEN selected_email_ciphertext ELSE signup.requested_email_ciphertext END,
      requested_display_name_ciphertext = CASE WHEN signup.accepted_at IS NULL
        THEN selected_display_name_ciphertext
        ELSE signup.requested_display_name_ciphertext END,
      organization_slug = CASE WHEN signup.accepted_at IS NULL
        THEN selected_organization_slug ELSE signup.organization_slug END,
      organization_name = CASE WHEN signup.accepted_at IS NULL
        THEN selected_organization_name ELSE signup.organization_name END,
      entity_code = CASE WHEN signup.accepted_at IS NULL
        THEN selected_entity_code ELSE signup.entity_code END,
      entity_name = CASE WHEN signup.accepted_at IS NULL
        THEN selected_entity_name ELSE signup.entity_name END,
      country_code = CASE WHEN signup.accepted_at IS NULL
        THEN selected_country_code ELSE signup.country_code END,
      region_code = CASE WHEN signup.accepted_at IS NULL
        THEN selected_region_code ELSE signup.region_code END,
      functional_currency = CASE WHEN signup.accepted_at IS NULL
        THEN selected_functional_currency ELSE signup.functional_currency END,
      accounting_profile = CASE WHEN signup.accepted_at IS NULL
        THEN selected_accounting_profile ELSE signup.accounting_profile END,
      fiscal_year = CASE WHEN signup.accepted_at IS NULL
        THEN selected_fiscal_year ELSE signup.fiscal_year END,
      manual_posting_mode = CASE WHEN signup.accepted_at IS NULL
        THEN selected_manual_posting_mode ELSE signup.manual_posting_mode END,
      key_provider = CASE WHEN signup.accepted_at IS NULL
        THEN selected_key_provider ELSE signup.key_provider END,
      wrapped_dek = CASE WHEN signup.accepted_at IS NULL
        THEN selected_wrapped_dek ELSE signup.wrapped_dek END,
      terms_version = selected_terms_version,
      status = 'PENDING', expires_at = now() + interval '24 hours'
    WHERE signup.id = existing_signup.id;
  END IF;

  INSERT INTO auth_email_outbox(
    id, user_id, template_type, payload_ciphertext, template_data, request_id
  ) VALUES (
    selected_outbox_id, effective_user_id, 'ORGANIZATION_SIGNUP',
    selected_payload_ciphertext,
    jsonb_build_object('organizationName', coalesce(existing_signup.organization_name, selected_organization_name)),
    selected_request_id
  );
  INSERT INTO auth_security_events(user_id, event_type, outcome, request_id)
  VALUES (effective_user_id, 'ORGANIZATION_SIGNUP_REQUEST', 'SUCCESS', selected_request_id);
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.auth_begin_organization_signup(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text,
  text, text, text, accounting_profile, integer, manual_posting_mode,
  text, text, text, text, uuid, text, text, text
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_cancel_invitation(
  selected_invitation_id uuid,
  expected_version integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
  selected_invitation organization_invitations%ROWTYPE;
  selected_identity users%ROWTYPE;
  selected_email_lookup_hash text;
  reset_incomplete_enrollment boolean := false;
  next_version integer;
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.members.manage', true);
  SELECT selected_user.email_lookup_hash INTO selected_email_lookup_hash
  FROM organization_invitations invitation
  JOIN users selected_user ON selected_user.id = invitation.user_id
  WHERE invitation.id = selected_invitation_id
    AND invitation.organization_id = administrator.organization_id;
  IF selected_email_lookup_hash IS NULL THEN
    RAISE EXCEPTION 'The pending invitation is unavailable' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_lookup_hash, 0
  ));
  SELECT * INTO selected_invitation
  FROM organization_invitations
  WHERE id = selected_invitation_id
    AND organization_id = administrator.organization_id
  FOR UPDATE;
  IF selected_invitation.id IS NULL OR selected_invitation.status <> 'PENDING' THEN
    RAISE EXCEPTION 'The pending invitation is unavailable' USING ERRCODE = '22023';
  END IF;
  IF selected_invitation.version <> expected_version THEN
    RAISE EXCEPTION 'Invitation version changed by another administrator'
      USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
      SELECT 1 FROM roles target_role
      WHERE target_role.organization_id = selected_invitation.organization_id
        AND target_role.id = selected_invitation.role_id
        AND (
          target_role.key = 'OWNER'
          OR EXISTS (
            SELECT 1 FROM role_permissions target_permission
            WHERE target_permission.organization_id = target_role.organization_id
              AND target_permission.role_id = target_role.id
              AND target_permission.permission_key = 'organization.recovery.manage'
          )
        )
    ) AND NOT administrator.is_demo
    AND NOT app.organization_admin_actor_has_permission(
      administrator.organization_id, administrator.actor_id,
      'organization.recovery.manage'
    ) THEN
    RAISE EXCEPTION 'Recovery-administration permission is required for this invitation'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO selected_identity FROM users
  WHERE id = selected_invitation.user_id FOR UPDATE;
  IF selected_identity.active
    OR EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.user_id = selected_identity.id AND membership.active
    )
    OR EXISTS (
      SELECT 1 FROM organization_memberships membership
      LEFT JOIN organization_invitations invitation
        ON invitation.organization_id = membership.organization_id
       AND invitation.membership_id = membership.id
       AND invitation.user_id = membership.user_id
      WHERE membership.user_id = selected_identity.id
        AND membership.id <> selected_invitation.membership_id
        AND (
          invitation.id IS NULL
          OR CASE WHEN EXISTS (
            SELECT 1 FROM auth_organization_signups signup
            WHERE signup.user_id = selected_identity.id
              AND signup.status IN ('PENDING', 'EXPIRED')
              AND signup.accepted_at IS NULL
              AND signup.completed_at IS NULL
          ) THEN invitation.status NOT IN ('PENDING', 'CANCELLED')
          ELSE invitation.status <> 'SUPERSEDED' END
        )
    )
    OR EXISTS (
      SELECT 1 FROM auth_mfa_factors factor
      WHERE factor.user_id = selected_identity.id AND factor.status = 'ACTIVE'
    ) THEN
    RAISE EXCEPTION 'The invitation identity is no longer available for cancellation'
      USING ERRCODE = '23505';
  END IF;
  IF NOT selected_identity.is_demo THEN
    IF selected_identity.email_verified_at IS NULL
      AND selected_identity.password_hash = '!invitation-pending!' THEN
      reset_incomplete_enrollment := false;
    ELSIF selected_identity.email_verified_at IS NULL
      AND selected_identity.password_hash = '!organization-signup-pending!'
      AND EXISTS (
        SELECT 1 FROM auth_organization_signups signup
        WHERE signup.user_id = selected_identity.id
          AND signup.status IN ('PENDING', 'EXPIRED')
          AND signup.accepted_at IS NULL
          AND signup.completed_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth_mfa_factors factor
        WHERE factor.user_id = selected_identity.id
          AND factor.status IN ('PENDING', 'ACTIVE')
      ) THEN
      reset_incomplete_enrollment := false;
    ELSIF selected_identity.email_verified_at IS NOT NULL
      AND selected_identity.password_hash LIKE 'scrypt-v1$32768$8$1$%'
      AND (
        EXISTS (
          SELECT 1 FROM auth_mfa_factors factor
          WHERE factor.user_id = selected_identity.id
            AND factor.status = 'PENDING'
        ) OR EXISTS (
          SELECT 1 FROM auth_one_time_tokens setup_token
          WHERE setup_token.user_id = selected_identity.id
            AND setup_token.organization_id = administrator.organization_id
            AND setup_token.purpose = 'MFA_SETUP'
            AND setup_token.consumed_at IS NULL
        )
      ) THEN
      reset_incomplete_enrollment := true;
    ELSE
      RAISE EXCEPTION 'The invitation identity is no longer available for cancellation'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  UPDATE auth_one_time_tokens
  SET consumed_at = coalesce(consumed_at, now())
  WHERE user_id = selected_invitation.user_id
    AND organization_id = administrator.organization_id
    AND purpose IN ('INVITATION', 'MFA_SETUP')
    AND consumed_at IS NULL;
  UPDATE auth_email_outbox SET
    status = 'DEAD', lease_owner = NULL, lease_expires_at = NULL,
    last_error_code = 'CANCELLED'
  WHERE user_id = selected_invitation.user_id
    AND organization_id = administrator.organization_id
    AND template_type = 'INVITATION'
    AND status IN ('PENDING', 'SENDING');
  UPDATE auth_mfa_factors SET
    status = 'REVOKED', revoked_at = coalesce(revoked_at, now())
  WHERE user_id = selected_invitation.user_id AND status = 'PENDING';
  IF reset_incomplete_enrollment THEN
    UPDATE users SET
      password_hash = '!invitation-pending!',
      password_changed_at = NULL,
      email_verified_at = NULL,
      active = false,
      mfa_required = true
    WHERE id = selected_identity.id
      AND NOT active AND NOT is_demo;
  END IF;
  UPDATE organization_invitations SET
    status = 'CANCELLED', cancelled_at = now(), updated_at = now(),
    version = version + 1
  WHERE id = selected_invitation.id
  RETURNING organization_invitations.version INTO next_version;

  IF NOT selected_identity.is_demo THEN
    INSERT INTO auth_security_events(
      user_id, organization_id, session_id, event_type, outcome,
      request_id, metadata
    ) VALUES (
      administrator.actor_id, administrator.organization_id,
      administrator.session_id, 'ORGANIZATION_INVITATION_CANCELLED',
      'SUCCESS', current_setting('app.request_id', true),
      jsonb_build_object(
        'targetUserId', selected_identity.id,
        'enrollmentReset', reset_incomplete_enrollment
      )
    );
  END IF;
  PERFORM app.append_tenant_business_audit(
    administrator.organization_id,
    'organization.invitation-cancelled',
    'organization_membership',
    selected_invitation.membership_id::text,
    jsonb_build_object(
      'invitationId', selected_invitation.id,
      'version', next_version
    ),
    'organization.invitation-cancelled'
  );
  RETURN next_version;
END
$$;
REVOKE ALL ON FUNCTION app.organization_cancel_invitation(uuid, integer) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_resend_invitation(
  selected_invitation_id uuid,
  expected_version integer,
  selected_token_id uuid,
  selected_token_hash text,
  selected_outbox_id uuid,
  selected_payload_ciphertext text
)
RETURNS TABLE(
  invitation_id uuid,
  membership_id uuid,
  version integer,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
  selected_invitation organization_invitations%ROWTYPE;
  selected_organization organizations%ROWTYPE;
  selected_identity users%ROWTYPE;
  selected_email_lookup_hash text;
  reset_incomplete_enrollment boolean := false;
  next_version integer;
  next_expiry timestamp with time zone := now() + interval '72 hours';
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.members.manage', true);
  SELECT * INTO selected_organization FROM organizations
  WHERE id = administrator.organization_id FOR SHARE;
  SELECT selected_user.email_lookup_hash INTO selected_email_lookup_hash
  FROM organization_invitations invitation
  JOIN users selected_user ON selected_user.id = invitation.user_id
  WHERE invitation.id = selected_invitation_id
    AND invitation.organization_id = administrator.organization_id;
  IF selected_email_lookup_hash IS NULL THEN
    RAISE EXCEPTION 'The invitation is unavailable for reissue' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_lookup_hash, 0
  ));
  SELECT * INTO selected_invitation
  FROM organization_invitations
  WHERE id = selected_invitation_id
    AND organization_id = administrator.organization_id
  FOR UPDATE;
  IF selected_invitation.id IS NULL
    OR selected_invitation.status NOT IN ('PENDING', 'CANCELLED') THEN
    RAISE EXCEPTION 'The invitation is unavailable for reissue' USING ERRCODE = '22023';
  END IF;
  IF selected_invitation.version <> expected_version THEN
    RAISE EXCEPTION 'Invitation version changed by another administrator'
      USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
      SELECT 1 FROM roles target_role
      WHERE target_role.organization_id = selected_invitation.organization_id
        AND target_role.id = selected_invitation.role_id
        AND (
          target_role.key = 'OWNER'
          OR EXISTS (
            SELECT 1 FROM role_permissions target_permission
            WHERE target_permission.organization_id = target_role.organization_id
              AND target_permission.role_id = target_role.id
              AND target_permission.permission_key = 'organization.recovery.manage'
          )
        )
    ) AND NOT administrator.is_demo
    AND NOT app.organization_admin_actor_has_permission(
      administrator.organization_id, administrator.actor_id,
      'organization.recovery.manage'
    ) THEN
    RAISE EXCEPTION 'Recovery-administration permission is required for this invitation'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_identity FROM users
  WHERE id = selected_invitation.user_id FOR UPDATE;
  IF selected_identity.active
    OR EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.user_id = selected_identity.id AND membership.active
    )
    OR EXISTS (
      SELECT 1 FROM organization_memberships membership
      LEFT JOIN organization_invitations invitation
        ON invitation.organization_id = membership.organization_id
       AND invitation.membership_id = membership.id
       AND invitation.user_id = membership.user_id
      WHERE membership.user_id = selected_identity.id
        AND membership.id <> selected_invitation.membership_id
        AND (
          invitation.id IS NULL
          OR CASE WHEN EXISTS (
            SELECT 1 FROM auth_organization_signups signup
            WHERE signup.user_id = selected_identity.id
              AND signup.status IN ('PENDING', 'EXPIRED')
              AND signup.accepted_at IS NULL
              AND signup.completed_at IS NULL
          ) THEN invitation.status NOT IN ('PENDING', 'CANCELLED')
          ELSE invitation.status <> 'SUPERSEDED' END
        )
    )
    OR EXISTS (
      SELECT 1 FROM auth_organization_signups signup
      WHERE signup.user_id = selected_identity.id
        AND signup.status IN ('ENROLLING', 'ACTIVE')
    ) THEN
    RAISE EXCEPTION 'The invitation identity is no longer available for reissue'
      USING ERRCODE = '23505';
  END IF;

  IF selected_organization.is_demo THEN
    IF selected_organization.organization_mode <> 'SANDBOX'
      OR selected_token_id IS NOT NULL OR selected_token_hash IS NOT NULL
      OR selected_outbox_id IS NOT NULL OR selected_payload_ciphertext IS NOT NULL THEN
      RAISE EXCEPTION 'Demo invitation resend cannot deliver email'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF selected_organization.organization_mode <> 'REAL'
      OR selected_token_id IS NULL OR selected_outbox_id IS NULL
      OR length(selected_token_hash) NOT BETWEEN 32 AND 200
      OR length(selected_payload_ciphertext) NOT BETWEEN 40 AND 4000 THEN
      RAISE EXCEPTION 'Real invitation resend requires encrypted delivery material'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM auth_mfa_factors factor
      WHERE factor.user_id = selected_identity.id
        AND factor.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'An enrolled identity cannot be reset by invitation administration'
        USING ERRCODE = '23505';
    END IF;
    IF selected_identity.email_verified_at IS NULL
      AND selected_identity.password_hash = '!invitation-pending!' THEN
      reset_incomplete_enrollment := false;
    ELSIF selected_identity.email_verified_at IS NULL
      AND selected_identity.password_hash = '!organization-signup-pending!'
      AND EXISTS (
        SELECT 1 FROM auth_organization_signups signup
        WHERE signup.user_id = selected_identity.id
          AND signup.status IN ('PENDING', 'EXPIRED')
          AND signup.accepted_at IS NULL
          AND signup.completed_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth_mfa_factors factor
        WHERE factor.user_id = selected_identity.id
          AND factor.status IN ('PENDING', 'ACTIVE')
      ) THEN
      reset_incomplete_enrollment := false;
    ELSIF selected_identity.email_verified_at IS NOT NULL
      AND selected_identity.password_hash LIKE 'scrypt-v1$32768$8$1$%'
      AND (
        EXISTS (
          SELECT 1 FROM auth_mfa_factors factor
          WHERE factor.user_id = selected_identity.id
            AND factor.status = 'PENDING'
        ) OR EXISTS (
          SELECT 1 FROM auth_one_time_tokens setup_token
          WHERE setup_token.user_id = selected_identity.id
            AND setup_token.organization_id = administrator.organization_id
            AND setup_token.purpose = 'MFA_SETUP'
            AND setup_token.consumed_at IS NULL
        )
      ) THEN
      reset_incomplete_enrollment := true;
    ELSE
      RAISE EXCEPTION 'The invitation identity is no longer available for reissue'
        USING ERRCODE = '23505';
    END IF;
    UPDATE auth_one_time_tokens
    SET consumed_at = coalesce(consumed_at, now())
    WHERE user_id = selected_invitation.user_id
      AND organization_id = administrator.organization_id
      AND purpose IN ('INVITATION', 'MFA_SETUP')
      AND consumed_at IS NULL;
    UPDATE auth_email_outbox SET
      status = 'DEAD', lease_owner = NULL, lease_expires_at = NULL,
      last_error_code = 'SUPERSEDED'
    WHERE user_id = selected_invitation.user_id
      AND organization_id = administrator.organization_id
      AND template_type = 'INVITATION'
      AND status IN ('PENDING', 'SENDING');
    UPDATE auth_mfa_factors SET
      status = 'REVOKED', revoked_at = coalesce(revoked_at, now())
    WHERE user_id = selected_invitation.user_id
      AND status = 'PENDING';
    IF reset_incomplete_enrollment THEN
      UPDATE users SET
        password_hash = '!invitation-pending!',
        password_changed_at = NULL,
        email_verified_at = NULL,
        active = false,
        mfa_required = true
      WHERE id = selected_identity.id
        AND NOT active AND NOT is_demo;
    END IF;
    INSERT INTO auth_one_time_tokens(
      id, token_hash, purpose, user_id, organization_id, expires_at
    ) VALUES (
      selected_token_id, selected_token_hash, 'INVITATION',
      selected_invitation.user_id, administrator.organization_id,
      next_expiry
    );
    INSERT INTO auth_email_outbox(
      id, user_id, organization_id, template_type,
      payload_ciphertext, request_id
    ) VALUES (
      selected_outbox_id, selected_invitation.user_id,
      administrator.organization_id, 'INVITATION',
      selected_payload_ciphertext, current_setting('app.request_id', true)
    );
    INSERT INTO auth_security_events(
      user_id, organization_id, session_id, event_type, outcome,
      request_id, metadata
    ) VALUES (
      administrator.actor_id, administrator.organization_id,
      administrator.session_id, 'ORGANIZATION_INVITATION_REISSUED',
      'SUCCESS', current_setting('app.request_id', true),
      jsonb_build_object(
        'targetUserId', selected_identity.id,
        'enrollmentReset', reset_incomplete_enrollment
      )
    );
  END IF;

  UPDATE organization_invitations invitation SET
    token_id = selected_token_id,
    status = 'PENDING',
    accepted_at = NULL,
    cancelled_at = NULL,
    expires_at = next_expiry,
    updated_at = now(),
    version = invitation.version + 1
  WHERE invitation.id = selected_invitation.id
  RETURNING invitation.version INTO next_version;
  PERFORM app.append_tenant_business_audit(
    administrator.organization_id,
    'organization.invitation-reissued',
    'organization_membership',
    selected_invitation.membership_id::text,
    jsonb_build_object(
      'invitationId', selected_invitation.id,
      'version', next_version,
      'synthetic', selected_organization.is_demo
    ),
    'organization.invitation-reissued'
  );
  RETURN QUERY SELECT selected_invitation.id,
    selected_invitation.membership_id, next_version, next_expiry;
END
$$;
REVOKE ALL ON FUNCTION app.organization_resend_invitation(
  uuid, integer, uuid, text, uuid, text
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_accept_invitation(
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
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_token auth_one_time_tokens%ROWTYPE;
  selected_invitation organization_invitations%ROWTYPE;
  selected_identity users%ROWTYPE;
  selected_membership organization_memberships%ROWTYPE;
  selected_reserved_signup auth_organization_signups%ROWTYPE;
  selected_organization_name text;
  selected_email_lookup_hash text;
BEGIN
  IF selected_password_hash NOT LIKE 'scrypt-v1$32768$8$1$%'
    OR length(selected_factor_secret_ciphertext) NOT BETWEEN 40 AND 1000
    OR length(selected_setup_token_hash) NOT BETWEEN 32 AND 200
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid invitation acceptance request' USING ERRCODE = '22023';
  END IF;

  SELECT selected_user.email_lookup_hash INTO selected_email_lookup_hash
  FROM auth_one_time_tokens token
  JOIN users selected_user ON selected_user.id = token.user_id
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'INVITATION';
  IF selected_email_lookup_hash IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_lookup_hash, 0
  ));

  SELECT token.* INTO selected_token FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'INVITATION'
    AND token.consumed_at IS NULL AND token.available_at <= now()
    AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL OR selected_token.organization_id IS NULL THEN RETURN; END IF;
  SELECT invitation.* INTO selected_invitation
  FROM organization_invitations invitation
  WHERE invitation.token_id = selected_token.id
    AND invitation.user_id = selected_token.user_id
    AND invitation.organization_id = selected_token.organization_id
    AND invitation.status = 'PENDING'
  FOR UPDATE;
  IF selected_invitation.id IS NULL THEN RETURN; END IF;
  SELECT selected_user.* INTO selected_identity FROM users selected_user
  WHERE selected_user.id = selected_token.user_id
    AND NOT selected_user.active AND NOT selected_user.is_demo
    AND selected_user.email_verified_at IS NULL
    AND selected_user.password_hash IN (
      '!invitation-pending!', '!organization-signup-pending!'
    )
  FOR UPDATE;
  IF selected_identity.id IS NULL THEN RETURN; END IF;
  IF selected_identity.password_hash = '!organization-signup-pending!' THEN
    SELECT signup.* INTO selected_reserved_signup
    FROM auth_organization_signups signup
    WHERE signup.user_id = selected_identity.id
      AND signup.status IN ('PENDING', 'EXPIRED')
      AND signup.accepted_at IS NULL
      AND signup.completed_at IS NULL
    FOR UPDATE;
    IF selected_reserved_signup.id IS NULL THEN RETURN; END IF;
  END IF;
  SELECT membership.* INTO selected_membership
  FROM organization_memberships membership
  WHERE membership.id = selected_invitation.membership_id
    AND membership.organization_id = selected_token.organization_id
    AND membership.user_id = selected_token.user_id
    AND NOT membership.active
  FOR UPDATE;
  IF selected_membership.id IS NULL OR EXISTS (
    SELECT 1 FROM organization_memberships other_membership
    WHERE other_membership.user_id = selected_token.user_id
      AND other_membership.active
  ) OR EXISTS (
    SELECT 1 FROM auth_mfa_factors factor
    WHERE factor.user_id = selected_token.user_id
      AND factor.status IN ('PENDING', 'ACTIVE')
  ) THEN RETURN; END IF;
  SELECT organization.display_name INTO selected_organization_name
  FROM organizations organization
  WHERE organization.id = selected_token.organization_id
    AND organization.active AND NOT organization.is_demo
    AND organization.organization_mode = 'REAL'
  FOR SHARE;
  IF selected_organization_name IS NULL THEN RETURN; END IF;

  UPDATE auth_organization_signups superseded_signup SET status = 'SUPERSEDED'
  WHERE superseded_signup.user_id = selected_token.user_id
    AND superseded_signup.status IN ('PENDING', 'EXPIRED')
    AND superseded_signup.accepted_at IS NULL
    AND superseded_signup.completed_at IS NULL;
  UPDATE organization_invitations superseded_invitation SET
    status = 'SUPERSEDED',
    cancelled_at = coalesce(superseded_invitation.cancelled_at, now()),
    updated_at = now(), version = superseded_invitation.version + 1
  WHERE superseded_invitation.user_id = selected_token.user_id
    AND superseded_invitation.id <> selected_invitation.id
    AND superseded_invitation.status IN ('PENDING', 'CANCELLED');
  UPDATE auth_one_time_tokens superseded_token SET
    consumed_at = coalesce(superseded_token.consumed_at, now())
  WHERE superseded_token.user_id = selected_token.user_id
    AND superseded_token.purpose IN (
      'ORGANIZATION_SIGNUP', 'MFA_SETUP', 'INVITATION'
    )
    AND superseded_token.consumed_at IS NULL;
  UPDATE auth_email_outbox superseded_message SET
    status = 'DEAD', lease_owner = NULL, lease_expires_at = NULL,
    last_error_code = 'SUPERSEDED_BY_INVITATION'
  WHERE superseded_message.user_id = selected_token.user_id
    AND superseded_message.template_type IN (
      'ORGANIZATION_SIGNUP', 'INVITATION'
    )
    AND superseded_message.status IN ('PENDING', 'SENDING');
  UPDATE users invited_user SET
    password_hash = selected_password_hash,
    password_changed_at = now(),
    email_verified_at = now(),
    mfa_required = true,
    active = false
  WHERE invited_user.id = selected_token.user_id;
  INSERT INTO auth_mfa_factors(
    id, user_id, factor_type, label, secret_ciphertext, status
  ) VALUES (
    selected_factor_id, selected_token.user_id, 'TOTP',
    'Primary authenticator', selected_factor_secret_ciphertext, 'PENDING'
  );
  INSERT INTO auth_one_time_tokens(
    token_hash, purpose, user_id, organization_id, expires_at
  ) VALUES (
    selected_setup_token_hash, 'MFA_SETUP', selected_token.user_id,
    selected_token.organization_id, now() + interval '30 minutes'
  );
  INSERT INTO auth_security_events(
    user_id, organization_id, event_type, outcome, request_id
  ) VALUES (
    selected_token.user_id, selected_token.organization_id,
    'INVITATION_ACCEPTED', 'SUCCESS', selected_request_id
  );
  RETURN QUERY SELECT selected_token.user_id,
    selected_identity.email_ciphertext, selected_organization_name,
    selected_factor_id;
END
$$;
REVOKE ALL ON FUNCTION app.auth_accept_invitation(
  text, text, uuid, text, text, text
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.organization_invite_member(
  selected_role_id uuid,
  selected_user_id uuid,
  selected_membership_id uuid,
  selected_invitation_id uuid,
  selected_email_lookup_hash text,
  selected_email_ciphertext text,
  selected_display_name_ciphertext text,
  selected_token_id uuid,
  selected_token_hash text,
  selected_outbox_id uuid,
  selected_payload_ciphertext text
)
RETURNS TABLE(
  invitation_id uuid,
  membership_id uuid,
  version integer,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  administrator record;
  selected_role roles%ROWTYPE;
  selected_organization organizations%ROWTYPE;
  existing_identity users%ROWTYPE;
  reserved_signup auth_organization_signups%ROWTYPE;
  effective_user_id uuid := selected_user_id;
  invitation_expiry timestamp with time zone := now() + interval '72 hours';
BEGIN
  SELECT * INTO administrator
  FROM app.organization_admin_authorize('organization.members.manage', true);
  IF NOT app.organization_admin_actor_has_permission(
    administrator.organization_id, administrator.actor_id,
    'organization.roles.manage'
  ) THEN
    RAISE EXCEPTION 'Role-administration permission is required'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_organization FROM organizations
  WHERE id = administrator.organization_id FOR SHARE;
  IF selected_organization.is_demo AND (
    SELECT count(*) FROM organization_memberships membership
    WHERE membership.organization_id = administrator.organization_id
  ) >= 32 THEN
    RAISE EXCEPTION 'Demo sandbox member limit of 32 reached'
      USING ERRCODE = '54000';
  END IF;
  SELECT * INTO selected_role FROM roles
  WHERE organization_id = administrator.organization_id
    AND id = selected_role_id AND active AND system_template
    AND key IN (
      'OWNER', 'ORGANIZATION_ADMIN', 'ACCOUNTANT_APPROVER',
      'BOOKKEEPER_MAKER', 'VIEWER_AUDITOR'
    )
  FOR SHARE;
  IF selected_role.id IS NULL THEN
    RAISE EXCEPTION 'The selected fixed role is invalid' USING ERRCODE = '22023';
  END IF;
  IF (
      selected_role.key = 'OWNER'
      OR EXISTS (
        SELECT 1 FROM role_permissions
        WHERE organization_id = selected_role.organization_id
          AND role_id = selected_role.id
          AND permission_key = 'organization.recovery.manage'
      )
    ) AND NOT administrator.is_demo
    AND NOT app.organization_admin_actor_has_permission(
      administrator.organization_id, administrator.actor_id,
      'organization.recovery.manage'
    ) THEN
    RAISE EXCEPTION 'Recovery-administration permission is required for this role'
      USING ERRCODE = '42501';
  END IF;

  IF selected_user_id IS NULL OR selected_membership_id IS NULL
    OR selected_invitation_id IS NULL
    OR selected_email_lookup_hash !~ '^[0-9a-f]{64}$'
    OR length(selected_email_ciphertext) NOT BETWEEN 40 AND 4000
    OR length(selected_display_name_ciphertext) NOT BETWEEN 40 AND 4000 THEN
    RAISE EXCEPTION 'Member invitation identity payload is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF selected_organization.is_demo THEN
    IF selected_organization.organization_mode <> 'SANDBOX'
      OR selected_token_id IS NOT NULL OR selected_token_hash IS NOT NULL
      OR selected_outbox_id IS NOT NULL OR selected_payload_ciphertext IS NOT NULL THEN
      RAISE EXCEPTION 'Demo invitations must remain synthetic and local'
        USING ERRCODE = '22023';
    END IF;
  ELSIF selected_organization.organization_mode <> 'REAL'
    OR selected_token_id IS NULL OR selected_outbox_id IS NULL
    OR length(selected_token_hash) NOT BETWEEN 32 AND 200
    OR length(selected_payload_ciphertext) NOT BETWEEN 40 AND 4000 THEN
    RAISE EXCEPTION 'Real invitations require encrypted delivery material'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_lookup_hash, 0
  ));
  SELECT * INTO existing_identity
  FROM users WHERE email_lookup_hash = selected_email_lookup_hash
  FOR UPDATE;
  IF existing_identity.id IS NOT NULL THEN
    IF selected_organization.is_demo
      OR existing_identity.id <> selected_user_id
      OR existing_identity.active OR existing_identity.is_demo
      OR existing_identity.email_verified_at IS NOT NULL
      OR existing_identity.password_hash <> '!organization-signup-pending!'
      OR EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.user_id = existing_identity.id AND membership.active
      )
      OR EXISTS (
        SELECT 1 FROM organization_memberships membership
        LEFT JOIN organization_invitations invitation
          ON invitation.organization_id = membership.organization_id
         AND invitation.membership_id = membership.id
         AND invitation.user_id = membership.user_id
        WHERE membership.user_id = existing_identity.id
          AND (
            invitation.id IS NULL
            OR invitation.status NOT IN ('PENDING', 'CANCELLED')
          )
      )
      OR EXISTS (
        SELECT 1 FROM auth_mfa_factors factor
        WHERE factor.user_id = existing_identity.id
          AND factor.status IN ('PENDING', 'ACTIVE')
      ) THEN
      RAISE EXCEPTION 'This email cannot be invited to this organization'
        USING ERRCODE = '23505';
    END IF;
    SELECT signup.* INTO reserved_signup
    FROM auth_organization_signups signup
    WHERE signup.user_id = existing_identity.id
      AND signup.status IN ('PENDING', 'EXPIRED')
      AND signup.accepted_at IS NULL
      AND signup.completed_at IS NULL
    FOR UPDATE;
    IF reserved_signup.id IS NULL THEN
      RAISE EXCEPTION 'This email cannot be invited to this organization'
        USING ERRCODE = '23505';
    END IF;
    effective_user_id := existing_identity.id;
  ELSE
    INSERT INTO users(
      id, email_lookup_hash, email_ciphertext, display_name_ciphertext,
      password_hash, active, is_demo, mfa_required, email_verified_at
    ) VALUES (
      selected_user_id, selected_email_lookup_hash, selected_email_ciphertext,
      selected_display_name_ciphertext,
      CASE WHEN selected_organization.is_demo
        THEN '!demo-invitation-disabled!' ELSE '!invitation-pending!' END,
      selected_organization.is_demo,
      selected_organization.is_demo,
      NOT selected_organization.is_demo,
      CASE WHEN selected_organization.is_demo THEN now() ELSE NULL END
    );
  END IF;

  INSERT INTO organization_memberships(
    id, organization_id, user_id, active, administration_version
  ) VALUES (
    selected_membership_id, administrator.organization_id,
    effective_user_id, selected_organization.is_demo, 1
  );
  INSERT INTO membership_roles(
    organization_id, membership_id, role_id, assigned_by
  ) VALUES (
    administrator.organization_id, selected_membership_id,
    selected_role.id, administrator.actor_id
  );

  IF NOT selected_organization.is_demo THEN
    INSERT INTO auth_one_time_tokens(
      id, token_hash, purpose, user_id, organization_id, expires_at
    ) VALUES (
      selected_token_id, selected_token_hash, 'INVITATION',
      effective_user_id, administrator.organization_id, invitation_expiry
    );
    INSERT INTO auth_email_outbox(
      id, user_id, organization_id, template_type,
      payload_ciphertext, request_id
    ) VALUES (
      selected_outbox_id, effective_user_id, administrator.organization_id,
      'INVITATION', selected_payload_ciphertext,
      current_setting('app.request_id', true)
    );
  END IF;

  INSERT INTO organization_invitations(
    id, organization_id, user_id, membership_id, role_id, token_id,
    status, invited_by_user_id, expires_at, accepted_at
  ) VALUES (
    selected_invitation_id, administrator.organization_id, effective_user_id,
    selected_membership_id, selected_role.id, selected_token_id,
    CASE WHEN selected_organization.is_demo THEN 'ACCEPTED' ELSE 'PENDING' END,
    administrator.actor_id, invitation_expiry,
    CASE WHEN selected_organization.is_demo THEN now() ELSE NULL END
  );

  IF NOT selected_organization.is_demo THEN
    INSERT INTO auth_security_events(
      user_id, organization_id, session_id, event_type, outcome,
      request_id, metadata
    ) VALUES (
      administrator.actor_id, administrator.organization_id,
      administrator.session_id, 'ORGANIZATION_INVITATION_ISSUED',
      'SUCCESS', current_setting('app.request_id', true),
      jsonb_build_object(
        'invitedBy', administrator.actor_id,
        'targetUserId', effective_user_id,
        'roleId', selected_role.id,
        'synthetic', false
      )
    );
  END IF;
  PERFORM app.append_tenant_business_audit(
    administrator.organization_id,
    'organization.member-invited',
    'organization_membership',
    selected_membership_id::text,
    jsonb_build_object(
      'invitationId', selected_invitation_id,
      'roleId', selected_role.id,
      'synthetic', selected_organization.is_demo
    ),
    'organization.member-invited'
  );
  RETURN QUERY SELECT selected_invitation_id, selected_membership_id,
    1, invitation_expiry;
END
$$;
REVOKE ALL ON FUNCTION app.organization_invite_member(
  uuid, uuid, uuid, uuid, text, text, text, uuid, text, uuid, text
) FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT EXECUTE ON FUNCTION
      app.auth_begin_organization_signup(
        uuid, uuid, uuid, uuid, text, text, text, text, text, text, text,
        text, text, text, accounting_profile, integer, manual_posting_mode,
        text, text, text, text, uuid, text, text, text
      ),
      app.auth_accept_invitation(text, text, uuid, text, text, text),
      app.organization_invite_member(
        uuid, uuid, uuid, uuid, text, text, text, uuid, text, uuid, text
      ),
      app.organization_resend_invitation(uuid, integer, uuid, text, uuid, text),
      app.organization_cancel_invitation(uuid, integer)
    TO business_finlynq_app;
  END IF;
END
$$;
