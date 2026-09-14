# Microsoft Entra External ID SSO

Business Finlynq uses the same Microsoft Entra External ID tenant and user flow
as EPM, but it is a separate confidential OIDC client. A browser that already
has an Entra session from either application can enter the other application
without entering credentials again.

Do not share application registrations, client IDs, client secrets, callback
URIs, or application cookies between EPM and Business Finlynq. The common Entra
tenant session provides SSO; each application retains its own revocable local
session and authorization model.

## Provider registrations

Create distinct Entra app registrations for development and production with
these exact Web redirect URIs:

- `https://stage.business.finlynq.com/api/auth/oidc/callback`
- `https://business.finlynq.com/api/auth/oidc/callback`

Use the existing Finlynq External ID tenant (`56ed1f1b-7e98-4a32-8711-534e375b9d6d`)
and the same sign-up/sign-in user flow as EPM. Configure only the authorization
code flow. Business Finlynq adds PKCE (`S256`), state, and nonce to every
request and accepts only signed `RS256` ID tokens for its own client ID.

The current shared provider contract is:

```dotenv
AUTH_OIDC_ISSUER=https://56ed1f1b-7e98-4a32-8711-534e375b9d6d.ciamlogin.com/56ed1f1b-7e98-4a32-8711-534e375b9d6d/v2.0
AUTH_OIDC_AUTHORIZATION_ENDPOINT=https://finlynq.ciamlogin.com/56ed1f1b-7e98-4a32-8711-534e375b9d6d/oauth2/v2.0/authorize
AUTH_OIDC_TOKEN_ENDPOINT=https://finlynq.ciamlogin.com/56ed1f1b-7e98-4a32-8711-534e375b9d6d/oauth2/v2.0/token
AUTH_OIDC_JWKS_URI=https://finlynq.ciamlogin.com/56ed1f1b-7e98-4a32-8711-534e375b9d6d/discovery/v2.0/keys
AUTH_OIDC_ALLOWED_TENANTS=56ed1f1b-7e98-4a32-8711-534e375b9d6d
```

Provider metadata must be checked against Entra before an environment is
enabled. Never infer or copy the EPM client ID or secret.

## Identity assignment and self-service signup

OIDC email claims never authorize or link Business accounts. Business Finlynq
keys a Microsoft identity only by the verified Entra `(issuer, tid, oid)`
tuple. The static, root-managed identity map remains a transitional way to
assign an existing account. Microsoft self-service signup persists the same
exact tuple in the database after separately verifying the contact email and
before activating the owner account. Mutable Microsoft email claims are not
used for either path.

The mounted JSON file uses this shape:

```json
{
  "schemaVersion": "business-finlynq-oidc-identity-map/v1",
  "mappings": [
    {
      "issuer": "https://56ed1f1b-7e98-4a32-8711-534e375b9d6d.ciamlogin.com/56ed1f1b-7e98-4a32-8711-534e375b9d6d/v2.0",
      "externalTenantId": "56ed1f1b-7e98-4a32-8711-534e375b9d6d",
      "externalPrincipalId": "00000000-0000-4000-8000-000000000001",
      "userId": "00000000-0000-4000-8000-000000000002",
      "organizationId": "00000000-0000-4000-8000-000000000003",
      "membershipId": "00000000-0000-4000-8000-000000000004"
    }
  ]
}
```

The map may contain zero mappings once every required legacy assignment is
persisted. Source tuples and Business target tuples must both be unique. The
database revalidates that a mapped or persisted user, real organization, and
membership are active and that the Business contact email was verified before
issuing a session.

With Microsoft signup enabled, a new user:

1. authenticates with Microsoft;
2. enters Business and contact-email details;
3. verifies the contact email from a one-use link;
4. re-confirms the same immutable Microsoft principal;
5. optionally creates an independent Business Finlynq password; and
6. becomes active immediately when the fresh, signed Microsoft token reports
   trusted MFA assurance; otherwise enrolls a TOTP authenticator first.

If the optional password is omitted, the account has no usable Business
password and signs in through Microsoft. If it is supplied, Microsoft and
email/password are independent login methods. A Microsoft password is never
requested, transmitted to, or stored by Business Finlynq.

## Environment activation

Install the client secret and identity map as separate root-owned files in the
environment secret directory, group-readable by `business-finlynq-secrets`,
mode `0440`. Point the host Compose environment at those files:

```dotenv
AUTH_OIDC_CLIENT_ID=<environment-specific-client-id>
AUTH_OIDC_CLIENT_SECRET_FILE=<environment-secret-directory>/oidc-client-secret
AUTH_OIDC_IDENTITY_MAP_FILE=<environment-secret-directory>/oidc-identity-map.json
AUTH_OIDC_MFA_AMR_CLAIM_PROVISIONED=true
AUTH_OIDC_MFA_AUTH_CONTEXTS=
AUTH_OIDC_ENABLED=true
AUTH_OIDC_SIGNUP_ENABLED=false
```

`ACCOUNT_LOGIN_ENABLED`, authentication email delivery, and its worker must
also be ready. The internal health response reports `oidcAuthentication` and
`oidcMfaAssurance` as `ready` only after it has parsed the provider, client
secret, identity map, and an explicit MFA-assurance claim contract.
Enable `AUTH_OIDC_SIGNUP_ENABLED=true` independently only after the database
migration, verification-email worker, and complete Microsoft signup acceptance
have passed in that environment. The detailed health response then reports
`oidcSignup` as `ready`. This gate does not enable local email/password signup;
`ACCOUNT_SIGNUP_ENABLED` remains separate.

## Microsoft MFA assurance policy

FinLynQ treats Microsoft MFA as satisfying its session MFA and privileged
step-up boundary only after all normal OIDC checks succeed: authorization code
plus PKCE, one-use state and nonce, trusted RS256 signature/JWKS, exact issuer,
Business client audience, allowed tenant, and bounded token lifetime. It then
accepts one of these two claim shapes:

- the ID token `amr` array contains the exact value `mfa`; or
- the ID token `acrs` array contains an authentication-context ID listed in
  `AUTH_OIDC_MFA_AUTH_CONTEXTS`.

The authentication-context allow-list is empty by default. Add an ID only after
an administrator has reviewed the corresponding Conditional Access policy and
confirmed that it requires MFA. Microsoft notes that an authentication-context
claim can be issued when no Conditional Access policy is attached, so claim
presence alone is not assurance. See Microsoft's
[optional claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference),
[optional-claims configuration](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims),
and [authentication-context guidance](https://learn.microsoft.com/en-us/entra/identity-platform/developer-guide-conditional-access-authentication-context).

For the preferred `amr` path, open the environment-specific Entra app
registration, select **Token configuration**, add the optional `amr` claim to
the **ID token**, and confirm the application manifest contains an `idToken`
optional-claim entry whose name is exactly `amr`. Only after that reviewed
change is present set `AUTH_OIDC_MFA_AMR_CLAIM_PROVISIONED=true`. This setting
is an operational attestation, not a request for Entra to add the claim.

If the tenant cannot emit `amr`, keep the attestation `false` and populate
`AUTH_OIDC_MFA_AUTH_CONTEXTS` with one or more reviewed `acrs` identifiers.
Readiness fails closed when OIDC is enabled but neither path is configured, or
when the attestation is not an exact boolean. Generic `acr` values are never a
configuration or runtime fallback.

FinLynQ never infers MFA from `pwd`, an arbitrary `acr`, an unreviewed context,
or a malformed/missing claim. Those sessions remain valid ordinary SSO
sessions, but protected actions continue to require local TOTP. Trusted Entra
assurance lasts only for the active, revocable FinLynQ session (24-hour absolute
maximum and normal idle/session revocation checks); it is not copied to a
password, demo, or later OIDC session.

## Acceptance and promotion

Validate development before promotion:

1. Verify the environment's app-registration manifest contains the optional
   ID-token `amr` claim and the Compose environment attests it with
   `AUTH_OIDC_MFA_AMR_CLAIM_PROVISIONED=true`; or record the reviewed Conditional
   Access policies for every configured `AUTH_OIDC_MFA_AUTH_CONTEXTS` value.
   Confirm internal readiness reports `oidcMfaAssurance` as `ready`.
2. Decode a development ID token only in an approved secure troubleshooting
   workflow and confirm the intended `amr: ["mfa"]` or allow-listed `acrs`
   evidence is actually present. Do not paste or retain tokens in tickets,
   logs, shell history, or deployment artifacts.
3. Open EPM and complete Microsoft sign-in.
4. In the same browser, open the Business Finlynq login page and select
   **Continue with Microsoft**.
5. Confirm Entra does not request credentials again and Business Finlynq opens
   the mapped real workspace.
6. With Microsoft signup disabled, confirm an unassigned identity is rejected.
7. Enable Microsoft signup, use a new Entra identity, verify a separate contact
   email, and sign in without a Business password. Confirm a token with trusted
   MFA activates without redundant TOTP, while a token without evidence still
   requires authenticator enrollment.
8. Repeat with the optional Business password enabled and verify both sign-in
   methods independently. Confirm that editing the verification URL cannot
   switch the signup to a different activation method.
9. Confirm a demo session is replaced and sign-out revokes only the Business
   Finlynq session.
10. Confirm password login, public demo access, local MFA step-up, session
   revocation, and internal readiness continue to work.

Promote only the exact development revision that passed these checks. Production
uses a separate client registration and secret, plus a separately reviewed
identity map. Local sign-out intentionally does not terminate the shared Entra
browser session or the EPM session; coordinated single logout would require a
separate front-channel logout design in both applications.
