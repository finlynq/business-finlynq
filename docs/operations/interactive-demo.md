# Interactive demo acceptance

The public demo uses a short-lived, server-side session over bundled synthetic data. Routes, navigation, search, export, dialogs, and validation previews work; persistence and accounting state changes do not. `BUSINESS_WRITES_ENABLED` remains `false` on every demo deployment.

## Browser acceptance checklist

- HTTP redirects to the exact HTTPS origin, the certificate is valid, and expected security headers are present.
- Every sidebar item, dashboard link, button, row action, dialog close action, and account-menu action has a visible result; there are no dead controls.
- Browser back/forward navigation, direct route loading, refresh, and not-found handling work without console or failed-request errors.
- Global search opens by button and keyboard shortcut, filters the synthetic dataset, handles empty results, and clears predictably.
- Trial-balance export downloads a non-empty, correctly labeled demo file with stable columns and separate currency values.
- Forms demonstrate required fields, exact decimal and currency handling, account segments, tax-review outcomes, and accessible inline errors without saving data.
- Posting, void/reversal, approval, hard close, reopen, seal, payment, role, recovery, and MCP write previews explicitly say that no state changed.
- Refreshing restores the canonical demo dataset; no preview writes to PostgreSQL, a cookie, local storage, or another durable store.
- Keyboard order, visible focus, dialog focus containment, labels, status announcements, mobile layout, and zoom are usable.
- The fixed demo identity cannot select another user or organization, has no write permissions, and receives no secrets or decrypted personal data.
- Anonymous workspace requests redirect to login, sign-out revokes the server-side session, and the demo link ignores speculative browser prefetches.

Run the checklist against a production build and again at `https://business.finlynq.com` after deployment.

## Production launch gates

The demo must not accept real party, banking, tax, or accounting data until all of these gates pass:

- MFA step-up and recovery-factor approval for privileged actions, building on the existing database-backed session resolution, revocation, secure cookies, origin checks, and durable rate limits.
- Tenant-scoped loaders for every workspace screen; until then `ACCOUNT_LOGIN_ENABLED` stays `false` and only the fixed demo identity can enter the workspace.
- Generic, single-use, expiring email recovery with security notifications, co-owner/recovery-factor approval, and delayed sole-owner controls.
- Organization DEK provision, encrypted master-data persistence, blind-index search, rotation/rewrap, and recovery from a separately escrowed root key.
- Complete GL, AR, AP, tax, multi-currency, void/reversal, approval, auto-post, and period-close application services that share one audited posting boundary.
- Non-superuser migration and runtime roles, explicit least-privilege grants, forced RLS verification, and no application hard-delete capability.
- Green unit, fresh-migration, non-owner PostgreSQL integration, concurrency, authorization, encryption/recovery, API/MCP, and browser end-to-end suites in CI.
- Effective-dated official tax data with evidence and regression fixtures; unsupported facts continue to require manual review.
- Encrypted off-VPS database backups, separate root-key escrow, a successful restore drill, immutable release artifacts, and tested forward-repair rollback.
- Alerts for TLS renewal, disk, containers, database health, audit delivery, backup age, and failed recovery attempts.
- MCP service-principal authentication, organization binding, revocation, scopes, idempotency, rate limits, and audit; production writes remain limited to explicit draft creation.

Only after these gates pass may writes be enabled in a non-production environment for acceptance testing. Production enablement requires a separate reviewed release decision.
