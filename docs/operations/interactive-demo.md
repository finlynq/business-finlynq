# Writable interactive demo acceptance

The public demo is a bounded, writable accounting sandbox over synthetic data. Each visitor receives an exclusive database organization; no visitor selects a tenant or shares another visitor's mutable records. Demo persistence is intentionally temporary and is separate from real-account activation.

## Production release boundary

The hosted demo uses this exact five-gate boundary:

```dotenv
DEMO_LOGIN_ENABLED=true
DEMO_WRITES_ENABLED=true
ACCOUNT_LOGIN_ENABLED=false
ACCOUNT_SIGNUP_ENABLED=false
BUSINESS_WRITES_ENABLED=false
```

`DEMO_WRITES_ENABLED` authorizes mutations only for a live `demo-link` session whose claimed organization is registered as a synthetic `SANDBOX`. `ACCOUNT_SIGNUP_ENABLED` independently controls owner acquisition, and `BUSINESS_WRITES_ENABLED` independently controls real organizations. Real-account activation is a separate release gate.

## Isolation and lifecycle contract

- A new browser atomically claims one `READY` sandbox slot. The opaque claim is host-only and HttpOnly; only its digest is stored. The immutable public template is never claimed or mutated.
- Every slot has its own organization, legal entities, users, memberships, role assignments, wrapped organization DEK, and independently encrypted seed data.
- A session expires after 15 minutes without activity and has a one-hour absolute maximum. The browser cookie cannot extend that maximum.
- Logout or expiry revokes only the short-lived session. Re-entry from the same browser issues a new session for the same `ASSIGNED` sandbox and preserves its changes.
- Nightly reconciliation at 04:15 `America/Toronto` invalidates every daily claim, revokes remaining sessions, resets every slot to the exact seed, verifies the baseline, and returns successful slots to `READY` with an incremented generation. No five-minute/session-release reset exists.
- Reset is an owner-only maintenance operation with no tenant selector. It purges tenant business data child-first while preserving the registered organization, synthetic identity, membership, role, and key envelope. Failed resets leave the slot `QUARANTINED`.
- Synthetic accounting content belongs in PostgreSQL only. Do not put journal, party, tax, or subledger content in cookies, browser local storage, logs, or analytics.

See [demo-sandbox-maintenance.md](demo-sandbox-maintenance.md) for operator commands, locking, schedules, and rollback behavior.

## Supported demo workflows

The release may persist the following synthetic actions inside the leased sandbox:

- balanced manual GL drafts and role/policy-driven posting;
- linked reversal/void behavior and period-state enforcement;
- customer and supplier account use, service/non-stock invoice and bill drafts, issue/post, and void;
- recorded customer receipts and supplier payments, exact open-item allocations, settlement reversal, and realized-FX accounting;
- transaction-tax decisions and immutable tax snapshots using the bundled Ontario and Washington reference packs;
- trial-balance/reporting views and exports that reflect the visitor's saved sandbox activity;
- permitted period transitions and locked-period rejection.

Recorded receipts and supplier payments are accounting records only. The demo has no inventory, bank feed or bank connection, live payment execution, tax return or filing service, identity/recovery administration, or public MCP endpoint. Do not imply those capabilities in UI copy or acceptance evidence.

## Browser acceptance checklist

- HTTP redirects to the exact HTTPS origin, the certificate is valid, and expected security and `private, no-store` headers are present.
- Speculative browser requests cannot claim a sandbox. Anonymous workspace requests redirect to login, and `/try-demo` issues only a same-site, rate-limited server session.
- Two clean browser profiles entering concurrently receive different session and organization identities. A journal, party, document, settlement, period change, or report result created in one is absent from the other.
- Every visible sidebar item, dashboard link, button, row action, dialog close action, and account-menu action has a visible result; there are no dead controls.
- Browser back/forward navigation, direct route loading, refresh, and not-found/error handling work without unhandled console or request failures. Refresh preserves the active sandbox rather than replacing it with the baseline.
- Manual journals reject invalid exact decimals, unbalanced lines, control-account misuse, unauthorized posting, and locked periods. A valid request is saved once, and retry behavior does not duplicate it.
- AR/AP forms enforce party role, entity/ledger, dates, currency/FX facts, tax evidence, source ownership, and version checks. Issuing produces the expected source-owned journal and open item.
- Receipt/payment allocations cannot exceed or cross the selected party, source type, ledger, or currency. Voiding reverses allocations and accounting lineage instead of deleting history.
- Tax-review outcomes and snapshots remain traceable to their pack/version and evidence. The UI does not claim to file a return or fetch a live official rate.
- Trial-balance pages and CSV exports are non-empty, correctly labeled, keep unlike currencies separate, and reflect the current sandbox's posted activity.
- Period controls reject ordinary posting in restricted periods and preserve the audit path for permitted transitions and corrections.
- Keyboard order, visible focus, dialog focus containment, labels, status announcements, mobile layout, and zoom remain usable across writable forms and confirmation states.
- The workspace clearly identifies synthetic, disposable data and warns visitors not to enter real or confidential information.
- Logout revokes the current session but preserves the browser claim. Re-entry returns to the same changed organization; another clean browser still receives a different organization. After nightly reset, the original browser receives a newly seeded available sandbox.
- Pool exhaustion fails closed with a temporary-unavailable response; no fixed template, dirty slot, quarantined slot, or real organization is substituted.

Run the checklist against a production build and again at `https://business.finlynq.com` after deployment.

`npm run test:e2e` automates public-route and security-header checks, GL posting, AR issue/void, the AP bill/payment/allocation/reversal chain, concurrent-browser isolation, and logout/re-entry claim continuity. It intentionally does not invoke owner maintenance against the deployed site; reset and baseline verification remain explicit operator acceptance.

## Release and nightly reset acceptance

Before enabling traffic for every release:

1. Apply the current migrations and bootstrap the full sandbox pool.
2. In an announced destructive acceptance window, run one full nightly-mode reconciliation and require all 128 slots to verify as `READY` with no quarantine.
3. Exercise one complete GL and one complete AR or AP workflow, log out, reopen from the same browser, and verify that the changed data remains while a clean browser cannot see it.
4. Run nightly reconciliation, verify that visitor-created rows are gone and the exact baseline returns, then enable the single nightly scheduler and set `MONITOR_EXPECT_DEMO_MAINTENANCE=true`.
5. Confirm alerts for a failed/overdue reset, quarantined slot, repeated pool exhaustion, and an inactive reconciliation timer.

Nightly reconciliation is destructive only to registered synthetic sandbox business data. It must never select the immutable template or a real organization. Backup and restore validation still uses the separately provisioned read-only backup role; writable demo access does not broaden that role.

## Real-account launch gates

The writable demo does not authorize real customer data. `ACCOUNT_LOGIN_ENABLED` and `BUSINESS_WRITES_ENABLED` remain false until the separate real-account release decision covers verified email delivery and recovery, encrypted persistence/key recovery drills, off-server backups and restore evidence, authorization and concurrency suites, monitoring, retention, production tax data, and the intended real-tenant modules. MCP activation requires its own organization-bound authentication, scopes, revocation, idempotency, rate limits, and audit review.
