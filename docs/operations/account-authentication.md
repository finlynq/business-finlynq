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

## Self-service owner signup

`ACCOUNT_SIGNUP_ENABLED` is an independent acquisition gate and defaults to `false`. It requires real login and authentication email delivery to be ready. Turning signup off stops new requests while already-issued verification links may still finish as long as `ACCOUNT_LOGIN_ENABLED=true`.

Production signup also requires Cloudflare Turnstile. Create a widget restricted to `business.finlynq.com`, put its public site key in `SIGNUP_TURNSTILE_SITE_KEY`, mount the one-line secret from `TURNSTILE_SECRET_KEY_FILE`, and set `SIGNUP_TURNSTILE_ENABLED=true`. The server calls Siteverify for every signup, verifies the `organization_signup` action and exact application hostname, and fails closed on provider errors or malformed responses. An unchallenged signup is allowed only in non-production development. See Cloudflare's server-side validation requirements: <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>.

The public flow deliberately has three stages:

1. `POST /api/auth/signup/request` consumes durable IP and normalized-email budgets before the external bot check or any organization-key work. A successful eligible request creates only an encrypted inactive pending user, one-use 24-hour token, encrypted outbox payload, and pending signup record. The response is identical when the email already belongs to an account. Version 1 permits one organization per globally normalized email.
2. The emailed fragment link opens `/complete-signup`. After a token/principal database budget admits the request, the server hashes the password. One narrowly scoped `SECURITY DEFINER` function then atomically creates the `REAL` organization, wrapped version-1 DEK, owner membership, five role templates, one legal entity and primary ledger, 12 calendar periods, the 13-account standard chart and base combinations, Custom 1–8 definitions, and the chosen posting policy. No demo transactions, parties, tax registrations, or synthetic identifiers are copied. If any insert fails, PostgreSQL rolls back the whole foundation and leaves the verification token usable.
3. Email possession sets the password and offers a locally generated TOTP QR code plus a copyable manual key. The user may confirm the current code and activate with MFA, or explicitly continue with password-only sign-in. Either choice consumes the setup token and activates the user and membership atomically. Password-only sessions never receive an MFA timestamp or privileged-operation step-up. An interrupted setup can request a fresh signup email; accepted accounting configuration and the existing wrapped key are preserved rather than replaced.

The Canadian selection derives CAD and `CAN_ASPE`; the US selection derives USD and `US_GAAP_NONPUBLIC`. Region, entity code, fiscal year, and `AUTO_POST` versus `REVIEW_REQUIRED` are explicit inputs. `0000` remains reserved and Custom 1–8 begin empty, nullable, and hidden.

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

Invitation acceptance is deliberately staged:

1. The user opens the one-use, 72-hour fragment link and creates a password of at least 14 characters.
2. The browser receives a new TOTP secret and locally generated QR image over TLS. The user may confirm a valid six-digit code within 30 minutes, or explicitly activate password-only access and enroll later from **Account & security**.

No password, invitation token, setup token, TOTP secret, or email plaintext is written to application logs.

## MFA and step-up

TOTP is recommended but optional for ordinary workspace access. Accounts that enabled it must provide password and TOTP at login. Accounts that explicitly skipped it receive a password-only opaque database-backed session with null MFA and step-up timestamps. Enabling TOTP later requires the signed-in user to re-enter the current password before a new secret is issued; confirmation atomically rotates the current bearer token, upgrades that session, revokes the user’s other sessions, consumes every older password-reset token, denies any pending or approved recovery request, and makes future logins require TOTP. The pre-enrollment token becomes invalid before the replacement cookie is returned, so a copied password-only token cannot inherit MFA assurance, and an older factorless reset link cannot downgrade the new recovery posture. Each accepted TOTP counter is stored atomically, so the same code cannot be replayed for login, recovery, approval, or step-up.

Privileged accounting and administration operations are not downgraded for password-only accounts. Period reopening or sealing, role and accounting-configuration changes, sensitive banking operations, recovery approval, and every other existing step-up-protected mutation still require an active TOTP factor and a fresh ten-minute step-up. A password-only user must enroll from **Account & security** before performing those operations. Reserved platform-administrator grants also continue to require verified active MFA before linkage.

`POST /api/auth/mfa/step-up` performs reusable step-up and marks the current session for ten minutes. Privileged application services must call `hasRecentStepUp` in addition to normal authorization immediately before a sensitive mutation. Recovery approval performs its own fresh TOTP verification even if the session was recently stepped up.

TOTP and recovery attempts are never limited only by source IP. Durable database budgets also apply to the authenticated session and user for step-up, the opaque token and resolved user for reset/enrollment, and the approver session/user plus recovery request for co-owner approval. These budgets are consumed atomically and remain fixed if a caller rotates addresses: eight step-up or approval attempts per session/request window, eight reset attempts per token-hour, eight enrollment attempts per setup-token half-hour, and three recovery escalations per reset-token day. Conservative user-day ceilings apply across newly issued sessions or tokens.

## Password recovery policy

Every request returns the same generic text. Valid requests enqueue a one-use link; invalid identities do not create an outbox row.

- Accounts with an available active TOTP factor must provide a fresh authenticator code; the factor remains active after the password changes.
- If the factor is unavailable, the link holder must explicitly escalate recovery. A **different** active recovery administrator in the same organization must approve when one is available. The approver must sign in and provide a fresh TOTP code after verifying the requester through another channel.
- If no other eligible recovery administrator exists, escalation applies a 72-hour security delay; the link remains valid for 96 hours. This is an emergency fallback and must trigger an operations alert.
- An ordinary account that has no enrolled factor may continue from its one-hour email link, but it must enroll and verify a replacement factor before the password reset completes.

A co-owner-approved, delayed, or factorless recovery does not merely remove MFA. The browser receives a new TOTP secret over TLS, and the reset completes only after a valid code from that replacement authenticator is verified. The database then atomically revokes the old factor, activates the replacement, sets `users.mfa_required=true`, changes `users.password_hash` and `password_changed_at`, consumes competing reset and setup tokens, revokes every active user session, records immutable events, and queues password-and-factor security notifications. Organization encryption keys and accounting records are untouched.

## Enablement checklist

- Replay the complete canonical migration journal through `0023_optional_authenticator_enrollment` on a fresh database, then run both explicit post-migration role reconcilers and test with the non-owner app and worker roles.
- Restore the database together with the exact identity secret and organization wrapping key in an isolated drill. Without the identity secret, emails, TOTP factors, and queued token payloads cannot be decrypted; without the organization key, accounting data cannot be decrypted.
- Verify the worker health/age alert and force a retryable provider failure and a permanent failure.
- Complete both MFA and password-only signup/invitation paths; verify password-only login has no step-up; enroll MFA later with current-password reauthentication; then verify MFA login, explicit step-up, logout, password reset, co-owner approval, delayed sole-owner recovery, session revocation, and security-notification delivery.
- Verify direct runtime-role reads of auth tables fail.
- Keep `ACCOUNT_SIGNUP_ENABLED=false` until the Resend sender, live worker, Turnstile hostname/action configuration, mounted Turnstile secret, generic duplicate-email behavior, atomic rollback test, and full password/TOTP activation flow are verified.
- Only then set `ACCOUNT_LOGIN_ENABLED=true` and, in a separate change, `ACCOUNT_SIGNUP_ENABLED=true`; keep `BUSINESS_WRITES_ENABLED=false` until the separate accounting write gates pass.
- Follow [Real-account activation and emergency write disable](./real-account-activation.md) for production-like restore evidence, the two-person pilot exercise, per-organization enablement, activation audit verification, and emergency disable. Account login never enables accounting writes by itself.
