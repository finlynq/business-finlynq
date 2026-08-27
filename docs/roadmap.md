# Build roadmap

The architecture review is accepted. Delivery is intentionally sliced so an attractive demo cannot be mistaken for a production accounting system.

## Milestone 0 — hardened foundation (complete)

- Separate open-source repository and isolated `business.finlynq.com` deployment namespace.
- Responsive demo dashboard.
- Multi-organization, multi-entity, ledger, period, chart-of-account, party, AR/AP, tax, audit, outbox, and key-version schema.
- Fixed account key fields: Entity, Account, Subaccount, Department, Intercompany, and Custom 1–8. Null renders as reserved `0000`; customer/supplier numbers remain party/subledger identifiers.
- Exact-decimal double-entry and FX contracts.
- Versioned module manifests and source-owned journal types.
- Database-enforced posting, immutable submitted/posted content, reversal relations, period locking, canonical approval hashes, tenant-qualified references, RLS, audit chaining, and least-privilege runtime grants.
- Ontario HST and Washington sales-tax reference packs with manual-review outcomes for unsupported facts.
- Envelope-encryption primitives, mounted-root secret loading, CI, Docker/Compose, and VPS runbook.

## P0 writable interactive demo release

- Each visitor leases an isolated, independently encrypted synthetic sandbox instead of sharing a mutable demo tenant.
- Manual GL, service/non-stock AR/AP, recorded settlement and allocation, transaction-tax snapshot, trial-balance/reporting, and period-control workflows persist for the visitor's session.
- `DEMO_LOGIN_ENABLED=true` and `DEMO_WRITES_ENABLED=true` authorize sandbox-only mutations; `ACCOUNT_LOGIN_ENABLED=false` and `BUSINESS_WRITES_ENABLED=false` keep real identities and organizations fail-closed.
- Sessions expire after 15 minutes idle or one hour total. Released/expired slots are reset to the exact seed, and nightly reconciliation revokes remaining demo sessions and rebuilds the full pool.
- Inventory, bank connections/reconciliation, live payment execution, production tax returns/filing, and public MCP access remain out of scope.
- The release passes the isolation, browser, reset, and monitoring checklist in [operations/interactive-demo.md](operations/interactive-demo.md).

P0 demonstrates durable accounting behavior inside disposable synthetic tenants; it does not satisfy or bypass any real-account milestone exit gate.

## Milestone 1 — identity, recovery, and encrypted master data (implemented; activation gated)

- Signed session/OIDC identity resolver that produces tenant context server-side.
- Invitations, memberships, custom roles, MFA step-up, session revocation, and security notifications.
- Rate-limited email password reset that never changes or destroys the organization DEK.
- Co-owner/recovery-factor approval and delayed sole-owner recovery.
- Privileged organization-key provision/rotation/rewrap service and restore drill.
- Encrypted party names, addresses, tax IDs, bank details, attachments, and connector credentials with blind-index search where required.

Exit gate: recovery and encrypted persistence pass end-to-end tests; only then may `BUSINESS_WRITES_ENABLED` be enabled for a real organization in a non-production test environment. The sandbox-only demo gate is independent.

The application paths and automated tests for this milestone are present. Public activation still requires a verified sending domain/provider credential, a running isolated email worker, separately escrowed recovery material, and an operator-observed acceptance exercise. Online organization-key rotation is deliberately unavailable until record re-encryption and blind-index rebuilding can be made atomic.

## Milestone 2 — usable general ledger (core workflow implemented)

- Organization/entity onboarding, ASPE or U.S. GAAP profile, functional currency, fiscal calendar, and demo chart creation.
- Segment configuration/rendering, journal draft/submit/approve/post, reversal/replacement, recurring journals, trial balance, general ledger, and period close/reopen UI.
- Audit explorer, CSV import to draft, attachments, and financial statements.

Tenant onboarding, encrypted master data, manual journal draft/role-based auto-post, explicit posting, full linked reversal, source-module ownership, and period close/reopen/seal services are implemented. Posting-policy administration UI, interactive reversal controls, recurring journals, CSV import, attachments, and the complete reporting set remain gated work.

## Milestone 3 — receivables and payables (core demo workflow implemented)

- Customer/supplier account workflows, quotes/orders where needed, invoices, bills, credit notes, payments, allocations, aging, statements, and realized FX.
- Append-only open-item allocation/settlement events; balances are derived rather than overwritten.
- Deterministic invoice/bill synchronous posting when the actor has the posting role; otherwise create a reviewable draft.

The current demo slice implements customer/supplier accounts, service/non-stock invoice and bill drafts, issue/post, open items, recorded receipt/payment allocation, realized-FX posting, and void/reversal with source-owned journal lineage and transaction-tax snapshots. Quotes/orders, credit-note UX, aging, statements, dunning, and external payment execution remain later work.

## Milestone 4 — production tax packs

- Effective-dated Ontario HST and Washington location-rate ingestion with evidence, approvals, regression fixtures, tax returns, and reconciliation to the ledger.
- Preserve recoverable and nonrecoverable tax components separately through snapshot and GL mapping.
- Add jurisdictions as independent signed/versioned packs against the same engine contract.

The demo uses bundled Ontario and Washington reference packs for transaction decisions and evidence snapshots only. It does not ingest live official rates, prepare production returns, or file tax.

## Milestone 5 — banking and reconciliation

- Encrypted bank connections, import observations, deterministic matching suggestions, bank reconciliation, transfer handling, and cash reporting.
- Bank and AI actions remain observations/drafts; neither can post or delete history.

## Milestone 6 — MCP and public API

- Organization-bound OAuth service principals, rate limits, idempotency, tool-level scopes, audit, and revocation.
- Read tools and explicit draft creation only in v0. Posting, approval, period reopen, role changes, recovery, payment execution, and hard deletion are never MCP tools.

No public MCP endpoint is active in the writable-demo release.

## Later modular work

Inventory is designed for but not built. A future inventory manifest can add item/location/valuation/subledger contracts without changing the 13-field account key. Manufacturing, projects, insurance, payroll, fixed assets, budgeting, consolidation, and secondary ledgers follow the same module contract and release gates.
