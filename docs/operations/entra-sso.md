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

- `https://dev.business.finlynq.com/api/auth/oidc/callback`
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

## Identity assignment

OIDC email claims do not create or link Business accounts. A root-managed,
read-only identity map assigns the verified Entra `(issuer, tid, oid)` tuple to
one existing Business user, organization, and membership. This avoids account
takeover through mutable or ambiguous email claims.

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

Source tuples and Business target tuples must both be unique. The database
revalidates that the mapped user, real organization, and membership are active
and that the Business email was verified before issuing a session.

## Environment activation

Install the client secret and identity map as separate root-owned files in the
environment secret directory, group-readable by `business-finlynq-secrets`,
mode `0440`. Point the host Compose environment at those files:

```dotenv
AUTH_OIDC_CLIENT_ID=<environment-specific-client-id>
AUTH_OIDC_CLIENT_SECRET_FILE=<environment-secret-directory>/oidc-client-secret
AUTH_OIDC_IDENTITY_MAP_FILE=<environment-secret-directory>/oidc-identity-map.json
AUTH_OIDC_ENABLED=true
```

`ACCOUNT_LOGIN_ENABLED`, authentication email delivery, and its worker must
also be ready. The internal health response reports `oidcAuthentication` as
`ready` only after it has parsed the provider, client secret, and identity map.

## Acceptance and promotion

Validate development before promotion:

1. Open EPM and complete Microsoft sign-in.
2. In the same browser, open the Business Finlynq login page and select
   **Continue with Microsoft**.
3. Confirm Entra does not request credentials again and Business Finlynq opens
   the mapped real workspace.
4. Confirm an unassigned Entra account is rejected, a demo session is replaced,
   and sign-out revokes only the Business Finlynq session.
5. Confirm password login, public demo access, local MFA step-up, session
   revocation, and internal readiness continue to work.

Promote only the exact development revision that passed these checks. Production
uses a separate client registration and secret, plus a separately reviewed
identity map. Local sign-out intentionally does not terminate the shared Entra
browser session or the EPM session; coordinated single logout would require a
separate front-channel logout design in both applications.
