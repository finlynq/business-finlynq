# Platform administrator grants

`PLATFORM_ADMINISTRATOR` is a control-plane role. It is not an organization
membership and never grants tenant accounting access by itself.

A grant is reserved by canonical email using the identity HMAC blind index.
The email is also stored as an authenticated ciphertext bound to the grant ID.
Provisioning does not create a user, password, organization, membership, MFA
factor, or session. The grant remains `PENDING_IDENTITY` until the matching
non-demo user has verified the email, completed active MFA enrollment, and can
authenticate through a live real session. Losing any of those assurances makes
the grant ineffective immediately; the authorization query rechecks every
condition even if an asynchronous linkage row were stale.

The initial `/app/platform` surface is a functional but deliberately read-only
control plane. It exposes only aggregate counts for active real organizations,
users, sessions, and platform-administrator grant states. It never returns
organization names, identity fields, grant identifiers, or tenant accounting
data. Platform mutations are not implied by this grant. Each future
control-plane operation must authorize the live session again inside its
database transaction and require a current MFA step-up.

## Operator provisioning

Use the migration-owner connection and mounted identity secret. Environment
input avoids placing the email in command arguments; neither the email, blind
index, nor ciphertext is printed by the command.

```text
PLATFORM_ADMIN_EMAIL=admin@example.com
PLATFORM_ADMIN_GRANTED_BY=operator:approved-release
PLATFORM_ADMIN_REASON=Approved initial Business Finlynq control-plane administrator
npm run auth:grant-platform-admin
```

The same values may be passed as `--email`, `--granted-by`, and `--reason`.
The command is serializable and idempotent for an existing non-revoked grant.
It refuses to silently restore a revoked grant. Its output contains only the
opaque grant ID, whether it was newly created, and `ACTIVE` or
`PENDING_IDENTITY`.

In hosted Compose, use the dedicated one-shot service. It receives the owner
database connection and mounted identity secret, runs with a read-only root
filesystem and dropped capabilities, and is attached only to the internal
database network. It receives no email-provider key and has no egress network.
Pass the three values from the operator environment so they are not added to
the service definition:

```text
docker compose --profile account-operations run --rm --no-deps \
  -e PLATFORM_ADMIN_EMAIL \
  -e PLATFORM_ADMIN_GRANTED_BY \
  -e PLATFORM_ADMIN_REASON \
  grant_platform_administrator
```

Do not place the email, identity key, or database owner credential in
repository files. The database service must already be healthy when `--no-deps`
is used.

Every creation, identity linkage, assurance unlink, and revocation is written
to `platform_administrator_grant_events`. That history is append-only; grants
cannot be deleted. A revoked grant requires a separate reviewed reauthorization
workflow rather than a provisioning retry.
