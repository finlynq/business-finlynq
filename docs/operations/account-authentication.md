# Real-account authentication and recovery

Real accounts are fail-closed. `ACCOUNT_LOGIN_ENABLED=true` is not sufficient by itself: authentication email delivery must also be explicitly enabled, a provider selected, a verified sender configured, and the provider credential mounted from a file. Password resets never rotate or replace organization DEKs or the organization root wrapping key.

## External setup required

Business Finlynq currently ships one email-provider adapter: Resend. Before enabling real accounts:

1. Verify a dedicated sending subdomain in Resend and publish its SPF and DKIM records. Add DMARC after validation. Resend recommends a subdomain to isolate sending reputation: <https://resend.com/docs/dashboard/domains/introduction>.
2. Create a **sending-access** API key restricted to that domain, not a full-access key: <https://resend.com/docs/dashboard/api-keys/introduction>.
3. Put the one-line API key in `/etc/business-finlynq/secrets/resend-api-key`, root-owned and readable only by the deployment secret group. Set `AUTH_RESEND_API_KEY_FILE` to that host path. Never put the key in `.env`, Compose YAML, Git, a command argument, or a container image.
4. Set `AUTH_EMAIL_PROVIDER=resend`, `AUTH_EMAIL_FROM` to a mailbox on the verified domain, and optionally `AUTH_EMAIL_REPLY_TO`. Set `AUTH_EMAIL_DELIVERY_ENABLED=true` only when the worker is ready.
5. Start the `auth-email` Compose profile and verify a real invitation, reset, new-login notice, MFA notice, retry, and dead-letter alert before setting `ACCOUNT_LOGIN_ENABLED=true`.

Resend requests use an outbox UUID as the `Idempotency-Key`; Resend retains idempotency keys for 24 hours: <https://resend.com/docs/dashboard/emails/idempotency-keys>.

## Delivery boundary

Recovery and invitation requests write to `auth_email_outbox` in the same PostgreSQL transaction as the one-time token. The HTTP request never calls the email provider. This keeps known and unknown recovery requests inside the same padded response envelope and avoids account enumeration through provider latency.

Recipient addresses remain encrypted as identity fields. Raw invitation/reset tokens are encrypted with the independent identity encryption key and authenticated to the outbox UUID before being stored. The application runtime role cannot claim or complete deliveries and has no direct access to outbox, token, factor, or session tables.

The worker uses the dedicated `business_finlynq_auth_worker` database role. That role can execute only the heartbeat and claim/complete/fail delivery functions and cannot read auth tables or issue sessions. Its independent password is supplied from `AUTH_WORKER_DATABASE_PASSWORD_FILE`; never reuse the application or migration password.

The worker updates a singleton database heartbeat on every loop, including an empty queue. When real accounts are enabled, application readiness validates non-secret delivery metadata and fails closed if that heartbeat is stale, a delivery lease is stuck, or the oldest due message exceeds the allowed age. The app does not mount or read the provider credential. The worker uses a two-minute lease, exponential retry, a maximum of eight attempts, and provider idempotency; an expired final-attempt lease is recoverable with the same stable provider idempotency key instead of being stranded. Permanent failures and exhausted retries become `DEAD` and append an authentication security event. Alert separately on any dead message and on the age of the oldest pending message. Successful outbox rows are retained for 30 days and then pruned in bounded batches; they do not replace the immutable authentication event archive.

## Invite an account

The organization, role template, entity, ledger, and chart must already exist through the tenant-onboarding boundary. The invitation tool only creates an encrypted identity and inactive membership for an existing organization UUID and existing role UUID; it verifies that the role belongs to the organization.

Run the tool from the one-shot operator/migrator image with the discrete `BUSINESS_FINLYNQ_MIGRATION_DB_*` settings, the identity secret, and non-secret email-delivery metadata. `DATABASE_MIGRATION_URL` remains a local-development fallback, but production Compose does not interpolate owner credentials into a URL. The invite container has only the private database network: it queues an encrypted outbox delivery and neither mounts the provider key nor calls the provider directly.

```text
npm run auth:invite -- \
  --organization 00000000-0000-4000-8000-000000000000 \
  --role 00000000-0000-4000-8000-000000000000 \
  --email owner@example.com \
  --name "Organization owner"
```

The first account is allowed only when the organization has no active member and the selected role has `organization.recovery.manage`. Later invitations require `--invited-by <user-uuid>`; that user must be an active recovery administrator in the organization. The tool never prints the raw invitation token. Reissuing an invitation invalidates earlier invitations and incomplete MFA setup.

Invitation acceptance is deliberately two-stage:

1. The user opens the one-use, 72-hour fragment link and creates a password of at least 14 characters.
2. The browser receives a new TOTP secret over TLS and asks the user to add it to an authenticator. The user and membership remain inactive until a valid six-digit code is confirmed within 15 minutes.

No password, invitation token, setup token, TOTP secret, or email plaintext is written to application logs.

## MFA and step-up

Invited users must enroll TOTP. Login verifies password and TOTP before issuing an opaque database-backed session. Each accepted TOTP counter is stored atomically, so the same code cannot be replayed for login, recovery, approval, or step-up.

`POST /api/auth/mfa/step-up` performs reusable step-up and marks the current session for ten minutes. Privileged application services must call `hasRecentStepUp` in addition to normal authorization immediately before a sensitive mutation. Recovery approval performs its own fresh TOTP verification even if the session was recently stepped up.

TOTP and recovery attempts are never limited only by source IP. Durable database budgets also apply to the authenticated session and user for step-up, the opaque token and resolved user for reset/enrollment, and the approver session/user plus recovery request for co-owner approval. These budgets are consumed atomically and remain fixed if a caller rotates addresses: eight step-up or approval attempts per session/request window, eight reset attempts per token-hour, eight enrollment attempts per setup-token half-hour, and three recovery escalations per reset-token day. Conservative user-day ceilings apply across newly issued sessions or tokens.

## Password recovery policy

Every request returns the same generic text. Valid requests enqueue a one-use link; invalid identities do not create an outbox row.

- Accounts with an available active TOTP factor must provide a fresh authenticator code; the factor remains active after the password changes.
- If the factor is unavailable, the link holder must explicitly escalate recovery. A **different** active recovery administrator in the same organization must approve when one is available. The approver must sign in and provide a fresh TOTP code after verifying the requester through another channel.
- If no other eligible recovery administrator exists, escalation applies a 72-hour security delay; the link remains valid for 96 hours. This is an emergency fallback and must trigger an operations alert.
- An ordinary account that has no enrolled factor may continue from its one-hour email link, but it must enroll and verify a replacement factor before the password reset completes.

A co-owner-approved, delayed, or factorless recovery does not merely remove MFA. The browser receives a new TOTP secret over TLS, and the reset completes only after a valid code from that replacement authenticator is verified. The database then atomically revokes the old factor, activates the replacement, changes `users.password_hash` and `password_changed_at`, consumes the token, revokes every active user session, records immutable events, and queues password-and-factor security notifications. Organization encryption keys and accounting records are untouched.

## Enablement checklist

- Replay the complete canonical migration journal through `0010_auth_principal_rate_limits` on a fresh database, then run both explicit post-migration role reconcilers and test with the non-owner app and worker roles.
- Restore the database together with the exact identity secret and organization wrapping key in an isolated drill. Without the identity secret, emails, TOTP factors, and queued token payloads cannot be decrypted; without the organization key, accounting data cannot be decrypted.
- Verify the worker health/age alert and force a retryable provider failure and a permanent failure.
- Complete an invitation and TOTP enrollment, login, explicit step-up, logout, password reset, co-owner approval, delayed sole-owner recovery, session revocation, and security-notification delivery.
- Verify direct runtime-role reads of auth tables fail.
- Only then set `ACCOUNT_LOGIN_ENABLED=true`; keep `BUSINESS_WRITES_ENABLED=false` until the separate accounting write gates pass.
