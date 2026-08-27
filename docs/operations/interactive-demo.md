# Writable interactive demo acceptance

The public demo is a bounded, writable accounting sandbox over synthetic data. Each visitor receives an exclusive database organization; no visitor selects a tenant or shares another visitor's mutable records. Demo persistence is intentionally temporary and is separate from real-account activation.

## Production release boundary

The hosted demo uses this exact four-gate boundary:

```dotenv
DEMO_LOGIN_ENABLED=true
DEMO_WRITES_ENABLED=true
ACCOUNT_LOGIN_ENABLED=false
BUSINESS_WRITES_ENABLED=false
```

`DEMO_WRITES_ENABLED` authorizes mutations only for a live `demo-link` session whose leased organization is registered as a synthetic `SANDBOX`. `BUSINESS_WRITES_ENABLED` independently controls real organizations and remains false. Do not enable account login, email recovery, or real-organization writes as part of a demo release.

## Isolation and lifecycle contract

- Session issuance atomically leases one `READY` sandbox slot. The immutable public template is never leased or mutated.
- Every slot has its own organization, legal entities, users, memberships, role assignments, wrapped organization DEK, and independently encrypted seed data.
- A session expires after 15 minutes without activity and has a one-hour absolute maximum. The browser cookie cannot extend that maximum.
- Logout or expiry revokes the session and leaves the slot `DIRTY`. A dirty, expired, resetting, or quarantined slot cannot be claimed.
- Incremental maintenance resets released and expired slots. Nightly reconciliation revokes all remaining sandbox sessions, resets every slot to the exact seed, verifies the baseline, and returns successful slots to `READY` with an incremented generation.
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
- Logout revokes the current session. Re-entry receives a clean available slot, and the released slot is not claimable until incremental reset finishes.
- Pool exhaustion fails closed with a temporary-unavailable response; no fixed template, dirty slot, quarantined slot, or real organization is substituted.

Run the checklist against a production build and again at `https://business.finlynq.com` after deployment.

`npm run test:e2e` automates the public-route and security-header checks, GL posting, AR issue/void, the complete AP bill/payment/allocation/reversal chain, and concurrent-browser isolation. The isolation scenario keeps two visitors live at once, saves a private draft in one sandbox, proves it is absent from the other, releases the first lease, and confirms a third visitor cannot receive that dirty organization. It intentionally does not invoke owner maintenance because the same browser suite is also run against the deployed site; reset and baseline verification remain the explicit operator acceptance below.

## Release and nightly reset acceptance

Before enabling traffic for every release:

1. Apply the current migrations and bootstrap the full sandbox pool.
2. Run one full nightly-mode reconciliation and require every configured slot to verify as `READY` with no quarantine.
3. Exercise one complete GL and one complete AR or AP workflow in a leased slot, release it, run incremental reset, and verify that no visitor-created tenant rows survive and the exact baseline returns.
4. Enable both demo maintenance timers and set `MONITOR_EXPECT_DEMO_MAINTENANCE=true`.
5. Confirm alerts for a failed reset, quarantined slot, repeated pool exhaustion, and inactive reset/reconciliation timers.

Nightly reconciliation is destructive only to registered synthetic sandbox business data. It must never select the immutable template or a real organization. Backup and restore validation still uses the separately provisioned read-only backup role; writable demo access does not broaden that role.

## Real-account launch gates

The writable demo does not authorize real customer data. `ACCOUNT_LOGIN_ENABLED` and `BUSINESS_WRITES_ENABLED` remain false until the separate real-account release decision covers verified email delivery and recovery, encrypted persistence/key recovery drills, off-server backups and restore evidence, authorization and concurrency suites, monitoring, retention, production tax data, and the intended real-tenant modules. MCP activation requires its own organization-bound authentication, scopes, revocation, idempotency, rate limits, and audit review.
