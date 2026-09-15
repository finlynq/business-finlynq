-- Treat only cryptographically verified Entra MFA evidence as FinLynQ step-up.
-- The application derives the bounded assurance enum after RS256, issuer,
-- audience, tenant, nonce, state, PKCE and token-lifetime verification.

CREATE OR REPLACE FUNCTION app.auth_issue_oidc_user_session(
  selected_user_id uuid,
  selected_organization_id uuid,
  selected_membership_id uuid,
  selected_token_hash text,
  selected_ip_hash text,
  selected_user_agent_hash text,
  selected_request_id text,
  selected_oidc_credential_hash text,
  selected_mfa_assurance text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  created_session_id uuid;
BEGIN
  IF selected_mfa_assurance NOT IN ('NONE', 'AMR_MFA', 'AUTH_CONTEXT') THEN
    RAISE EXCEPTION 'Invalid OIDC MFA assurance' USING ERRCODE = '22023';
  END IF;

  created_session_id := app.auth_issue_oidc_user_session(
    selected_user_id, selected_organization_id, selected_membership_id,
    selected_token_hash, selected_ip_hash, selected_user_agent_hash,
    selected_request_id, selected_oidc_credential_hash
  );
  IF created_session_id IS NULL OR selected_mfa_assurance = 'NONE' THEN
    RETURN created_session_id;
  END IF;

  UPDATE auth_sessions selected_session SET
    mfa_verified_at = now(),
    step_up_expires_at = selected_session.expires_at
  WHERE selected_session.id = created_session_id
    AND selected_session.user_id = selected_user_id
    AND selected_session.organization_id = selected_organization_id
    AND selected_session.auth_method = 'OIDC'
    AND selected_session.session_mode = 'REAL'
    AND selected_session.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OIDC session assurance target changed' USING ERRCODE = '40001';
  END IF;

  INSERT INTO auth_security_events(
    user_id, organization_id, session_id, event_type, outcome, request_id,
    metadata
  ) VALUES (
    selected_user_id, selected_organization_id, created_session_id,
    'OIDC_MFA_ASSURANCE_ACCEPTED', 'SUCCESS', selected_request_id,
    jsonb_build_object('assurance', selected_mfa_assurance)
  );
  RETURN created_session_id;
END
$$;
--> statement-breakpoint

-- A fresh matching Entra proof may activate an owner signup without creating a
-- second factor. Missing assurance preserves the existing pending TOTP flow.
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
  selected_external_principal_id text,
  selected_mfa_assurance text
)
RETURNS TABLE(user_id uuid, email_ciphertext text, organization_name text, factor_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  accepted_user_id uuid;
  accepted_email_ciphertext text;
  accepted_organization_name text;
  accepted_factor_id uuid;
  accepted_organization_id uuid;
  completed_signup_id uuid;
BEGIN
  IF selected_mfa_assurance NOT IN ('NONE', 'AMR_MFA', 'AUTH_CONTEXT') THEN
    RAISE EXCEPTION 'Invalid OIDC MFA assurance' USING ERRCODE = '22023';
  END IF;

  SELECT accepted.user_id, accepted.email_ciphertext,
    accepted.organization_name, accepted.factor_id
  INTO accepted_user_id, accepted_email_ciphertext,
    accepted_organization_name, accepted_factor_id
  FROM app.auth_accept_oidc_organization_signup(
    selected_token_hash, selected_password_hash, selected_password_enabled,
    selected_factor_id, selected_factor_secret_ciphertext,
    selected_setup_token_hash, selected_request_id, selected_issuer,
    selected_external_tenant_id, selected_external_principal_id
  ) accepted;
  IF accepted_user_id IS NULL THEN RETURN; END IF;
  IF selected_mfa_assurance = 'NONE' THEN
    RETURN QUERY SELECT accepted_user_id, accepted_email_ciphertext,
      accepted_organization_name, accepted_factor_id;
    RETURN;
  END IF;

  SELECT signup.organization_id INTO accepted_organization_id
  FROM auth_organization_signups signup
  WHERE signup.user_id = accepted_user_id
    AND signup.status = 'ENROLLING'
  FOR UPDATE;
  IF accepted_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM auth_oidc_identities identity
    WHERE identity.user_id = accepted_user_id
      AND identity.issuer = selected_issuer
      AND identity.external_tenant_id = selected_external_tenant_id
      AND identity.external_principal_id = selected_external_principal_id
  ) THEN
    RAISE EXCEPTION 'OIDC signup assurance target changed' USING ERRCODE = '40001';
  END IF;

  UPDATE auth_mfa_factors factor SET
    status = 'REVOKED', revoked_at = coalesce(factor.revoked_at, now())
  WHERE factor.id = accepted_factor_id
    AND factor.user_id = accepted_user_id
    AND factor.status = 'PENDING';
  UPDATE auth_one_time_tokens token SET consumed_at = now()
  WHERE token.token_hash = selected_setup_token_hash
    AND token.user_id = accepted_user_id
    AND token.organization_id = accepted_organization_id
    AND token.purpose = 'MFA_SETUP'
    AND token.consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OIDC signup activation token changed' USING ERRCODE = '40001';
  END IF;

  UPDATE users selected_user SET active = true, mfa_required = false
  WHERE selected_user.id = accepted_user_id
    AND NOT selected_user.active
    AND NOT selected_user.is_demo;
  UPDATE organization_memberships membership SET active = true
  WHERE membership.user_id = accepted_user_id
    AND membership.organization_id = accepted_organization_id
    AND NOT membership.active;
  UPDATE auth_organization_signups signup SET
    status = 'ACTIVE', completed_at = now()
  WHERE signup.user_id = accepted_user_id
    AND signup.organization_id = accepted_organization_id
    AND signup.status = 'ENROLLING'
  RETURNING signup.id INTO completed_signup_id;
  IF completed_signup_id IS NULL THEN
    RAISE EXCEPTION 'OIDC signup activation state changed' USING ERRCODE = '40001';
  END IF;

  INSERT INTO auth_security_events(
    user_id, organization_id, event_type, outcome, request_id, metadata
  ) VALUES (
    accepted_user_id, accepted_organization_id,
    'ORGANIZATION_SIGNUP_ACTIVATED', 'SUCCESS', selected_request_id,
    jsonb_build_object(
      'signupId', completed_signup_id,
      'authentication', 'OIDC',
      'mfaAssurance', selected_mfa_assurance
    )
  );
  RETURN QUERY SELECT accepted_user_id, accepted_email_ciphertext,
    accepted_organization_name, NULL::uuid;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.auth_issue_oidc_user_session(
  uuid, uuid, uuid, text, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_accept_oidc_organization_signup(
  text, text, boolean, uuid, text, text, text, text, text, text, text
) FROM PUBLIC;
--> statement-breakpoint

COMMENT ON FUNCTION app.auth_issue_oidc_user_session(
  uuid, uuid, uuid, text, text, text, text, text, text
) IS 'Issues a normal revocable OIDC session and grants session-bounded MFA step-up only for application-verified Entra MFA evidence.';
COMMENT ON FUNCTION app.auth_accept_oidc_organization_signup(
  text, text, boolean, uuid, text, text, text, text, text, text, text
) IS 'Activates a freshly reverified Entra owner without redundant TOTP only when the signed token carried trusted MFA assurance; otherwise preserves local enrollment.';
--> statement-breakpoint

DO $entra_mfa_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE EXECUTE ON FUNCTION app.auth_issue_oidc_user_session(
      uuid, uuid, uuid, text, text, text, text, text
    ) FROM business_finlynq_app;
    REVOKE EXECUTE ON FUNCTION app.auth_accept_oidc_organization_signup(
      text, text, boolean, uuid, text, text, text, text, text, text
    ) FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.auth_issue_oidc_user_session(
      uuid, uuid, uuid, text, text, text, text, text, text
    ) TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.auth_accept_oidc_organization_signup(
      text, text, boolean, uuid, text, text, text, text, text, text, text
    ) TO business_finlynq_app;
  END IF;
END
$entra_mfa_grants$;
