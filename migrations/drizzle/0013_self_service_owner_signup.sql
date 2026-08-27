-- Public owner signup first creates only an encrypted, inactive pending user.
-- Possession of the one-use email token is required before one atomic function
-- provisions the REAL tenant, owner membership, encryption envelope, and ledger
-- foundation. The owner remains inactive until TOTP enrollment succeeds.

ALTER TABLE auth_one_time_tokens
  DROP CONSTRAINT auth_one_time_tokens_purpose_check,
  ADD CONSTRAINT auth_one_time_tokens_purpose_check
    CHECK (purpose IN (
      'PASSWORD_RESET', 'EMAIL_VERIFICATION', 'INVITATION', 'MAGIC_LOGIN',
      'MFA_SETUP', 'ORGANIZATION_SIGNUP'
    ));
--> statement-breakpoint

ALTER TABLE auth_email_outbox
  DROP CONSTRAINT auth_email_outbox_template_check,
  ADD CONSTRAINT auth_email_outbox_template_check CHECK (template_type IN (
    'PASSWORD_RESET', 'INVITATION', 'ORGANIZATION_SIGNUP', 'RECOVERY_APPROVAL',
    'SECURITY_PASSWORD_CHANGED', 'SECURITY_MFA_ENABLED',
    'SECURITY_MFA_REPLACED', 'SECURITY_NEW_LOGIN',
    'SECURITY_RECOVERY_ESCALATED'
  ));
--> statement-breakpoint

CREATE TABLE auth_organization_signups (
  id uuid PRIMARY KEY,
  token_id uuid NOT NULL UNIQUE REFERENCES auth_one_time_tokens(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  -- Ciphertext AAD includes the caller-selected user id. This normally equals
  -- user_id; retaining it separately keeps legacy random-id invitations safe.
  identity_encryption_user_id uuid NOT NULL,
  requested_email_ciphertext text NOT NULL,
  requested_display_name_ciphertext text NOT NULL,
  -- This deterministic identifier exists before the organization. It is
  -- intentionally not a foreign key until provisioning has completed.
  organization_id uuid NOT NULL UNIQUE,
  organization_slug text NOT NULL UNIQUE,
  organization_name text NOT NULL,
  entity_code text NOT NULL,
  entity_name text NOT NULL,
  country_code text NOT NULL,
  region_code text NOT NULL,
  functional_currency text NOT NULL,
  accounting_profile accounting_profile NOT NULL,
  fiscal_year integer NOT NULL,
  manual_posting_mode manual_posting_mode NOT NULL,
  key_provider text NOT NULL,
  wrapped_dek text NOT NULL,
  terms_version text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  accepted_at timestamp with time zone,
  completed_at timestamp with time zone,
  CONSTRAINT auth_organization_signups_status_check
    CHECK (status IN ('PENDING', 'ENROLLING', 'ACTIVE', 'SUPERSEDED', 'EXPIRED')),
  CONSTRAINT auth_organization_signups_slug_check
    CHECK (organization_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  CONSTRAINT auth_organization_signups_entity_code_check
    CHECK (entity_code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$' AND entity_code <> '0000'),
  CONSTRAINT auth_organization_signups_country_check CHECK (country_code IN ('CA', 'US')),
  CONSTRAINT auth_organization_signups_region_check CHECK (region_code ~ '^[A-Z0-9-]{2,10}$'),
  CONSTRAINT auth_organization_signups_fiscal_year_check CHECK (fiscal_year BETWEEN 2000 AND 2200),
  CONSTRAINT auth_organization_signups_country_profile_check CHECK (
    (country_code = 'CA' AND functional_currency = 'CAD' AND accounting_profile = 'CAN_ASPE')
    OR
    (country_code = 'US' AND functional_currency = 'USD' AND accounting_profile = 'US_GAAP_NONPUBLIC')
  ),
  CONSTRAINT auth_organization_signups_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX auth_organization_signups_status_expiry_idx
  ON auth_organization_signups(status, expires_at);
REVOKE ALL ON auth_organization_signups FROM PUBLIC;
--> statement-breakpoint

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
      -- An invitation is only a reservation, not proof of email ownership.
      -- Reuse a retained pending/cancelled/expired placeholder, but leave its
      -- invitation usable until the owner proves possession of the signup
      -- email. Accepted, verified, active, or MFA-started identities never
      -- enter this branch.
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
      OR existing_signup.status = 'ACTIVE' THEN
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
      -- The invitation won the race and already proved the email. An
      -- unverified signup retry must not invalidate its MFA setup.
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
    ) THEN
      RETURN false;
    END IF;
    IF NOT reusing_invitation_identity AND EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.user_id = existing_user.id
        AND membership.organization_id <> existing_signup.organization_id
    ) THEN
      RETURN false;
    END IF;
    -- Legacy invitations may predate the shared deterministic UUID. Their
    -- ciphertext remains bound to that retained id; a new deterministic
    -- placeholder can safely accept the refreshed encrypted fields.
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_consume_signup_accept_limits(selected_token_hash text)
RETURNS TABLE(eligible boolean, allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_user_id uuid;
  token_allowed boolean := false;
  token_retry integer := 3600;
  user_allowed boolean := true;
  user_retry integer := 0;
BEGIN
  IF selected_token_hash IS NULL OR length(selected_token_hash) NOT BETWEEN 32 AND 200 THEN
    RETURN QUERY SELECT false, false, 3600;
    RETURN;
  END IF;

  SELECT token.user_id INTO selected_user_id
  FROM auth_one_time_tokens token
  JOIN auth_organization_signups signup
    ON signup.token_id = token.id AND signup.user_id = token.user_id
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'ORGANIZATION_SIGNUP'
    AND token.consumed_at IS NULL AND token.available_at <= now()
    AND token.expires_at > now() AND signup.status = 'PENDING'
    AND signup.expires_at > now();

  SELECT decision.allowed, decision.retry_after_seconds
    INTO token_allowed, token_retry
  FROM app.auth_consume_rate_limit(
    'organization-signup-token-hour', selected_token_hash, 8, 3600
  ) decision;

  IF selected_user_id IS NOT NULL THEN
    SELECT decision.allowed, decision.retry_after_seconds
      INTO user_allowed, user_retry
    FROM app.auth_consume_rate_limit(
      'organization-signup-user-day',
      md5('business-finlynq|organization-signup|user|' || selected_user_id::text),
      20,
      86400
    ) decision;
  END IF;

  RETURN QUERY SELECT
    selected_user_id IS NOT NULL,
    selected_user_id IS NOT NULL AND coalesce(token_allowed, false) AND user_allowed,
    greatest(coalesce(token_retry, 3600), user_retry);
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_accept_organization_signup(
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
  selected_signup auth_organization_signups%ROWTYPE;
  selected_user users%ROWTYPE;
  selected_token auth_one_time_tokens%ROWTYPE;
  selected_membership_id uuid;
  owner_role_id uuid;
  selected_entity_id uuid;
  selected_ledger_id uuid;
  organization_exists boolean;
  superseding_invitation boolean := false;
  restarting_enrollment boolean := false;
  selected_email_hash text;
BEGIN
  IF selected_password_hash NOT LIKE 'scrypt-v1$32768$8$1$%'
    OR length(selected_factor_secret_ciphertext) NOT BETWEEN 40 AND 1000
    OR length(selected_setup_token_hash) NOT BETWEEN 32 AND 200
    OR length(selected_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid organization signup acceptance request' USING ERRCODE = '22023';
  END IF;

  SELECT selected_identity.email_lookup_hash INTO selected_email_hash
  FROM auth_organization_signups signup
  JOIN auth_one_time_tokens token ON token.id = signup.token_id
  JOIN users selected_identity ON selected_identity.id = signup.user_id
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'ORGANIZATION_SIGNUP'
    AND token.consumed_at IS NULL AND token.available_at <= now()
    AND token.expires_at > now() AND signup.status = 'PENDING'
    AND signup.expires_at > now();
  IF selected_email_hash IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_hash, 0
  ));

  SELECT signup.* INTO selected_signup
  FROM auth_organization_signups signup
  JOIN auth_one_time_tokens token ON token.id = signup.token_id
  WHERE token.token_hash = selected_token_hash
    AND token.purpose = 'ORGANIZATION_SIGNUP'
    AND token.consumed_at IS NULL AND token.available_at <= now()
    AND token.expires_at > now() AND signup.status = 'PENDING'
    AND signup.expires_at > now()
  FOR UPDATE OF signup;
  IF selected_signup.id IS NULL THEN RETURN; END IF;

  SELECT token.* INTO selected_token
  FROM auth_one_time_tokens token
  WHERE token.id = selected_signup.token_id
  FOR UPDATE;
  SELECT selected_identity.* INTO selected_user
  FROM users selected_identity
  WHERE selected_identity.id = selected_signup.user_id
    AND NOT selected_identity.active AND NOT selected_identity.is_demo
  FOR UPDATE;
  IF selected_user.id IS NULL THEN RETURN; END IF;
  restarting_enrollment := selected_signup.accepted_at IS NOT NULL;
  IF EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.user_id = selected_signup.user_id AND membership.active
  ) OR (restarting_enrollment AND EXISTS (
    SELECT 1 FROM auth_mfa_factors factor
    WHERE factor.user_id = selected_signup.user_id
      AND factor.status = 'ACTIVE'
  )) OR (NOT restarting_enrollment AND EXISTS (
    SELECT 1 FROM auth_mfa_factors factor
    WHERE factor.user_id = selected_signup.user_id
      AND factor.status IN ('PENDING', 'ACTIVE')
  )) THEN
    RETURN;
  END IF;
  IF restarting_enrollment THEN
    IF selected_user.email_verified_at IS NULL
      OR selected_user.password_hash NOT LIKE 'scrypt-v1$32768$8$1$%' THEN
      RETURN;
    END IF;
  ELSIF selected_user.email_verified_at IS NOT NULL
    OR selected_user.password_hash NOT IN (
      '!organization-signup-pending!', '!invitation-pending!'
    ) THEN
    RETURN;
  END IF;
  superseding_invitation := selected_user.password_hash = '!invitation-pending!';

  SELECT EXISTS(
    SELECT 1 FROM organizations organization
    WHERE organization.id = selected_signup.organization_id
  ) INTO organization_exists;
  IF restarting_enrollment AND NOT organization_exists THEN RETURN; END IF;

  IF NOT organization_exists THEN
    INSERT INTO organizations(
      id, slug, display_name, active, is_demo, organization_mode
    ) VALUES (
      selected_signup.organization_id, selected_signup.organization_slug,
      selected_signup.organization_name, true, false, 'REAL'
    );
    INSERT INTO organization_key_versions(
      organization_id, version, key_provider, wrapped_dek, active
    ) VALUES (
      selected_signup.organization_id, 1, selected_signup.key_provider,
      selected_signup.wrapped_dek, true
    );

    INSERT INTO roles(organization_id, key, display_name, system_template, active)
    VALUES
      (selected_signup.organization_id, 'OWNER', 'Owner', true, true),
      (selected_signup.organization_id, 'ACCOUNTANT_APPROVER', 'Accountant Approver', true, true),
      (selected_signup.organization_id, 'BOOKKEEPER_MAKER', 'Bookkeeper Maker', true, true),
      (selected_signup.organization_id, 'VIEWER_AUDITOR', 'Viewer Auditor', true, true),
      (selected_signup.organization_id, 'INTEGRATION_MCP', 'Integration MCP', true, true);

    INSERT INTO role_permissions(organization_id, role_id, permission_key)
    SELECT selected_signup.organization_id, role.id, permission.key
    FROM roles role
    CROSS JOIN permissions permission
    WHERE role.organization_id = selected_signup.organization_id
      AND (
        role.key = 'OWNER'
        OR (role.key = 'ACCOUNTANT_APPROVER' AND permission.key = ANY(ARRAY[
          'mcp.ledger.read', 'ledger.journal.draft', 'ledger.journal.submit',
          'ledger.journal.approve', 'ledger.journal.post',
          'ledger.journal.post_adjustment', 'ledger.journal.reverse',
          'ledger.posting_policy.manage', 'ledger.period.close',
          'ledger.period.reopen', 'parties.read', 'parties.manage',
          'receivables.read', 'receivables.manage', 'receivables.post',
          'receivables.settle', 'receivables.void', 'payables.read',
          'payables.manage', 'payables.post', 'payables.settle',
          'payables.void', 'tax.read'
        ]::text[]))
        OR (role.key = 'BOOKKEEPER_MAKER' AND permission.key = ANY(ARRAY[
          'mcp.ledger.read', 'ledger.journal.draft', 'ledger.journal.submit',
          'parties.read', 'parties.manage', 'receivables.read',
          'receivables.manage', 'payables.read', 'payables.manage', 'tax.read'
        ]::text[]))
        OR (role.key = 'VIEWER_AUDITOR' AND permission.key = ANY(ARRAY[
          'mcp.ledger.read', 'parties.read', 'receivables.read',
          'payables.read', 'tax.read'
        ]::text[]))
        OR (role.key = 'INTEGRATION_MCP' AND permission.key = ANY(ARRAY[
          'mcp.ledger.read', 'mcp.journal-draft.create'
        ]::text[]))
      );

    INSERT INTO organization_memberships(organization_id, user_id, active)
    VALUES (selected_signup.organization_id, selected_signup.user_id, false)
    RETURNING id INTO selected_membership_id;
    SELECT role.id INTO owner_role_id FROM roles role
    WHERE role.organization_id = selected_signup.organization_id AND role.key = 'OWNER';
    INSERT INTO membership_roles(organization_id, membership_id, role_id, assigned_by)
    VALUES (
      selected_signup.organization_id, selected_membership_id,
      owner_role_id, selected_signup.user_id
    );

    INSERT INTO legal_entities(
      organization_id, code, display_name, country_code, region_code, active
    ) VALUES (
      selected_signup.organization_id, selected_signup.entity_code,
      selected_signup.entity_name, selected_signup.country_code,
      selected_signup.region_code, true
    ) RETURNING id INTO selected_entity_id;
    INSERT INTO ledgers(
      organization_id, legal_entity_id, code, display_name, kind,
      accounting_profile, functional_currency, active
    ) VALUES (
      selected_signup.organization_id, selected_entity_id,
      selected_signup.entity_code || '-PRIMARY',
      selected_signup.entity_name || ' primary ledger', 'PRIMARY',
      selected_signup.accounting_profile,
      selected_signup.functional_currency, true
    ) RETURNING id INTO selected_ledger_id;

    INSERT INTO fiscal_periods(
      organization_id, ledger_id, fiscal_year, period_number,
      label, starts_on, ends_on, state
    )
    SELECT selected_signup.organization_id, selected_ledger_id,
      selected_signup.fiscal_year, month_number,
      to_char(make_date(selected_signup.fiscal_year, month_number, 1), 'FMMonth YYYY'),
      make_date(selected_signup.fiscal_year, month_number, 1),
      (make_date(selected_signup.fiscal_year, month_number, 1)
        + interval '1 month - 1 day')::date,
      'OPEN'
    FROM generate_series(1, 12) AS month_number;

    INSERT INTO gl_accounts(
      organization_id, ledger_id, code, display_name, class,
      control_kind, postable, active, valid_from
    )
    SELECT selected_signup.organization_id, selected_ledger_id,
      seed.code, seed.display_name, seed.account_class::account_class,
      seed.control_kind::control_account_kind, true, true,
      make_date(selected_signup.fiscal_year, 1, 1)
    FROM (VALUES
      ('1000', 'Cash', 'ASSET', 'NONE'),
      ('1100', 'Accounts receivable', 'ASSET', 'AR'),
      ('1400', 'Prepaid expenses', 'ASSET', 'NONE'),
      ('1500', 'Recoverable input tax', 'ASSET', 'NONE'),
      ('2000', 'Accounts payable', 'LIABILITY', 'AP'),
      ('2200', 'Sales and use tax payable', 'LIABILITY', 'NONE'),
      ('2300', 'Accrued liabilities', 'LIABILITY', 'NONE'),
      ('3000', 'Owner equity', 'EQUITY', 'NONE'),
      ('4100', 'Service revenue', 'REVENUE', 'NONE'),
      ('4900', 'Realized FX gain', 'REVENUE', 'NONE'),
      ('6100', 'Operating expenses', 'EXPENSE', 'NONE'),
      ('7100', 'Realized FX loss', 'EXPENSE', 'NONE'),
      ('7190', 'FX rounding', 'EXPENSE', 'NONE')
    ) AS seed(code, display_name, account_class, control_kind);

    INSERT INTO account_combinations(
      organization_id, ledger_id, entity_id, account_id
    )
    SELECT selected_signup.organization_id, selected_ledger_id,
      selected_entity_id, account.id
    FROM gl_accounts account
    WHERE account.organization_id = selected_signup.organization_id
      AND account.ledger_id = selected_ledger_id;

    INSERT INTO segment_definitions(
      organization_id, key, ordinal, display_name, state, required, visible
    ) VALUES
      (selected_signup.organization_id, 'subaccount', 3, 'Subaccount', 'CONFIGURED_UNBOUND', false, true),
      (selected_signup.organization_id, 'department', 4, 'Department', 'CONFIGURED_UNBOUND', false, true),
      (selected_signup.organization_id, 'custom1', 6, 'Custom 1', 'EMPTY', false, false),
      (selected_signup.organization_id, 'custom2', 7, 'Custom 2', 'EMPTY', false, false),
      (selected_signup.organization_id, 'custom3', 8, 'Custom 3', 'EMPTY', false, false),
      (selected_signup.organization_id, 'custom4', 9, 'Custom 4', 'EMPTY', false, false),
      (selected_signup.organization_id, 'custom5', 10, 'Custom 5', 'EMPTY', false, false),
      (selected_signup.organization_id, 'custom6', 11, 'Custom 6', 'EMPTY', false, false),
      (selected_signup.organization_id, 'custom7', 12, 'Custom 7', 'EMPTY', false, false),
      (selected_signup.organization_id, 'custom8', 13, 'Custom 8', 'EMPTY', false, false);

    INSERT INTO ledger_posting_policies(
      organization_id, ledger_id, manual_mode, version, updated_by
    ) VALUES (
      selected_signup.organization_id, selected_ledger_id,
      selected_signup.manual_posting_mode, 1, selected_signup.user_id
    );
  ELSE
    PERFORM 1
    FROM organizations organization
    JOIN organization_memberships membership
      ON membership.organization_id = organization.id
     AND membership.user_id = selected_signup.user_id
     AND NOT membership.active
    WHERE organization.id = selected_signup.organization_id
      AND organization.organization_mode = 'REAL'
      AND organization.active AND NOT organization.is_demo;
    IF NOT FOUND OR selected_signup.accepted_at IS NULL THEN RETURN; END IF;
  END IF;

  -- Only the verified signup acceptance supersedes retained invitation state.
  -- Dynamic SQL keeps this migration independently runnable before the
  -- organization-invitations extension is installed by the next migration.
  IF superseding_invitation
    AND to_regclass('public.organization_invitations') IS NOT NULL THEN
    EXECUTE $cancel_invitation$
      UPDATE organization_invitations SET
        status = 'SUPERSEDED', cancelled_at = coalesce(cancelled_at, now()),
        updated_at = now(),
        version = version + 1
      WHERE user_id = $1 AND status IN ('PENDING', 'CANCELLED')
    $cancel_invitation$ USING selected_signup.user_id;
  END IF;
  UPDATE auth_one_time_tokens accepted_token SET consumed_at = now()
  WHERE accepted_token.id = selected_token.id;
  UPDATE auth_one_time_tokens superseded_token SET
    consumed_at = coalesce(superseded_token.consumed_at, now())
  WHERE superseded_token.user_id = selected_signup.user_id
    AND superseded_token.purpose IN ('INVITATION', 'MFA_SETUP')
    AND superseded_token.consumed_at IS NULL;
  UPDATE auth_email_outbox superseded_message SET
    status = 'DEAD', lease_owner = NULL, lease_expires_at = NULL,
    last_error_code = 'SUPERSEDED_BY_SIGNUP'
  WHERE superseded_message.user_id = selected_signup.user_id
    AND superseded_message.template_type = 'INVITATION'
    AND superseded_message.status IN ('PENDING', 'SENDING');
  UPDATE auth_mfa_factors superseded_factor SET
    status = 'REVOKED', revoked_at = now()
  WHERE superseded_factor.user_id = selected_signup.user_id
    AND superseded_factor.status = 'PENDING';
  UPDATE users accepted_user SET
    password_hash = selected_password_hash,
    password_changed_at = now(),
    email_verified_at = coalesce(accepted_user.email_verified_at, now()),
    email_ciphertext = CASE
      WHEN selected_signup.identity_encryption_user_id = selected_signup.user_id
      THEN selected_signup.requested_email_ciphertext
      ELSE accepted_user.email_ciphertext END,
    display_name_ciphertext = CASE
      WHEN selected_signup.identity_encryption_user_id = selected_signup.user_id
      THEN selected_signup.requested_display_name_ciphertext
      ELSE accepted_user.display_name_ciphertext END,
    mfa_required = true,
    active = false
  WHERE accepted_user.id = selected_signup.user_id;
  INSERT INTO auth_mfa_factors(
    id, user_id, factor_type, label, secret_ciphertext, status
  ) VALUES (
    selected_factor_id, selected_signup.user_id, 'TOTP',
    'Primary authenticator', selected_factor_secret_ciphertext, 'PENDING'
  );
  INSERT INTO auth_one_time_tokens(
    token_hash, purpose, user_id, organization_id, expires_at
  ) VALUES (
    selected_setup_token_hash, 'MFA_SETUP', selected_signup.user_id,
    selected_signup.organization_id, now() + interval '30 minutes'
  );
  UPDATE auth_organization_signups accepted_signup SET
    status = 'ENROLLING', accepted_at = coalesce(accepted_at, now())
  WHERE accepted_signup.id = selected_signup.id;
  INSERT INTO auth_security_events(
    user_id, organization_id, event_type, outcome, request_id,
    metadata
  ) VALUES (
    selected_signup.user_id, selected_signup.organization_id,
    'ORGANIZATION_SIGNUP_ACCEPTED', 'SUCCESS', selected_request_id,
    jsonb_build_object('signupId', selected_signup.id)
  );
  RETURN QUERY SELECT selected_signup.user_id,
    CASE WHEN selected_signup.identity_encryption_user_id = selected_signup.user_id
      THEN selected_signup.requested_email_ciphertext
      ELSE selected_user.email_ciphertext END,
    selected_signup.organization_name, selected_factor_id;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.auth_finish_mfa_enrollment(
  selected_setup_token_hash text,
  selected_factor_id uuid,
  selected_totp_counter bigint,
  selected_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_token auth_one_time_tokens%ROWTYPE;
  completed_signup_id uuid;
  selected_email_hash text;
BEGIN
  SELECT selected_user.email_lookup_hash INTO selected_email_hash
  FROM auth_one_time_tokens token
  JOIN users selected_user ON selected_user.id = token.user_id
  WHERE token.token_hash = selected_setup_token_hash
    AND token.purpose = 'MFA_SETUP'
    AND token.consumed_at IS NULL AND token.expires_at > now();
  IF selected_email_hash IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq|account-user|' || selected_email_hash, 0
  ));

  SELECT token.* INTO selected_token FROM auth_one_time_tokens token
  WHERE token.token_hash = selected_setup_token_hash AND token.purpose = 'MFA_SETUP'
    AND token.consumed_at IS NULL AND token.expires_at > now()
  FOR UPDATE;
  IF selected_token.id IS NULL OR selected_token.organization_id IS NULL THEN RETURN false; END IF;

  -- One email has one active organization in v1. Lock every membership before
  -- activating the factor/user so a concurrent administrator cannot revive a
  -- superseded invitation into a second tenant.
  PERFORM 1 FROM organization_memberships membership
  WHERE membership.user_id = selected_token.user_id
  ORDER BY membership.organization_id, membership.id
  FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.user_id = selected_token.user_id
      AND membership.organization_id = selected_token.organization_id
      AND NOT membership.active
  ) OR EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.user_id = selected_token.user_id
      AND membership.organization_id <> selected_token.organization_id
      AND membership.active
  ) THEN
    RETURN false;
  END IF;

  UPDATE auth_mfa_factors factor
  SET status = 'ACTIVE', verified_at = now(), last_accepted_counter = selected_totp_counter
  WHERE factor.id = selected_factor_id AND factor.user_id = selected_token.user_id AND factor.status = 'PENDING';
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE auth_one_time_tokens SET consumed_at = now() WHERE id = selected_token.id;
  UPDATE users SET active = true WHERE id = selected_token.user_id AND NOT is_demo;
  UPDATE organization_memberships SET active = true
  WHERE user_id = selected_token.user_id AND organization_id = selected_token.organization_id;
  UPDATE auth_organization_signups SET status = 'ACTIVE', completed_at = now()
  WHERE user_id = selected_token.user_id
    AND organization_id = selected_token.organization_id
    AND status = 'ENROLLING'
  RETURNING id INTO completed_signup_id;
  INSERT INTO auth_security_events(user_id, organization_id, event_type, outcome, request_id)
  VALUES (selected_token.user_id, selected_token.organization_id, 'MFA_ENROLLED', 'SUCCESS', selected_request_id);
  IF completed_signup_id IS NOT NULL THEN
    INSERT INTO auth_security_events(
      user_id, organization_id, event_type, outcome, request_id, metadata
    ) VALUES (
      selected_token.user_id, selected_token.organization_id,
      'ORGANIZATION_SIGNUP_ACTIVATED', 'SUCCESS', selected_request_id,
      jsonb_build_object('signupId', completed_signup_id)
    );
  END IF;
  INSERT INTO auth_email_outbox(id, user_id, organization_id, template_type, request_id)
  VALUES (gen_random_uuid(), selected_token.user_id, selected_token.organization_id, 'SECURITY_MFA_ENABLED', selected_request_id);
  RETURN true;
END
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION
  app.auth_begin_organization_signup(
    uuid, uuid, uuid, uuid, text, text, text, text, text, text, text,
    text, text, text, accounting_profile, integer, manual_posting_mode,
    text, text, text, text, uuid, text, text, text
  ),
  app.auth_consume_signup_accept_limits(text),
  app.auth_accept_organization_signup(text, text, uuid, text, text, text)
FROM PUBLIC;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON auth_organization_signups FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION
      app.auth_begin_organization_signup(
        uuid, uuid, uuid, uuid, text, text, text, text, text, text, text,
        text, text, text, accounting_profile, integer, manual_posting_mode,
        text, text, text, text, uuid, text, text, text
      ),
      app.auth_consume_signup_accept_limits(text),
      app.auth_accept_organization_signup(text, text, uuid, text, text, text)
    TO business_finlynq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_auth_worker') THEN
    REVOKE ALL ON auth_organization_signups FROM business_finlynq_auth_worker;
  END IF;
END
$$;
