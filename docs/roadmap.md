# Build roadmap

The architecture review is accepted. Delivery is intentionally sliced so an attractive demo cannot be mistaken for a production accounting system.

The detailed release order and acceptance gates now live in the [product implementation work order](plan/product-implementation-work-order-2026-08.md). Current package state is maintained in [the delivery tracker](plan/delivery-status.md). Existing milestone labels below describe shipped baseline capability; they do not supersede an incomplete G0/R1/R2 gate.

## Milestone 0 — foundation baseline implemented; G0 hardening in verification

- Separate open-source repository and isolated `business.finlynq.com` deployment namespace.
- Responsive demo dashboard.
- Multi-organization, multi-entity, ledger, period, chart-of-account, party, AR/AP, tax, audit, outbox, and key-version schema.
- Fixed account key fields: Entity, Account, Subaccount, Department, Intercompany, and Custom 1–8. Null renders as reserved `0000`; customer/supplier numbers remain party/subledger identifiers.
- Exact-decimal double-entry and FX contracts.
- Versioned module manifests and source-owned journal types.
- Database-enforced posting, immutable submitted/posted content, reversal relations, period locking, canonical approval hashes, tenant-qualified references, RLS, audit chaining, and least-privilege runtime grants.
- Ontario HST and Washington sales-tax reference packs with manual-review outcomes for unsupported facts.
- Envelope-encryption primitives, mounted-root secret loading, CI, Docker/Compose, and VPS runbook.

## P0 writable interactive demo baseline implemented

- Each browser claims an isolated, independently encrypted synthetic sandbox instead of sharing a mutable demo tenant.
- Manual GL, service/non-stock AR/AP, recorded settlement and allocation, transaction-tax snapshot, trial-balance/reporting, and period-control workflows persist across logout and session expiry until nightly reset.
- `DEMO_LOGIN_ENABLED=true` and `DEMO_WRITES_ENABLED=true` authorize sandbox-only mutations. Real login, signup, and business writes use separate gates and never inherit demo authority.
- Sessions expire after 15 minutes idle or one hour total. A hash-only host claim reopens the same organization, while 04:15 Toronto nightly reconciliation invalidates all claims and rebuilds the additive 128-slot pool.
- Inventory, live bank credentials in the sandbox, live payment execution, production tax returns/filing, and public MCP access remain out of scope. Synthetic banking/reconciliation is reset with the rest of the demo.
- The release passes the isolation, browser, reset, and monitoring checklist in [operations/interactive-demo.md](operations/interactive-demo.md).

P0 demonstrates durable accounting behavior inside disposable synthetic tenants; it does not satisfy or bypass any real-account milestone exit gate.

## Milestone 1 — identity/recovery baseline hosted; per-organization activation pending

- Signed session/OIDC identity resolver that produces tenant context server-side.
- Invitations, memberships, custom roles, MFA step-up, session revocation, and security notifications.
- Rate-limited email password reset that never changes or destroys the organization DEK.
- Co-owner/recovery-factor approval and delayed sole-owner recovery.
- Privileged organization-key provision/rotation/rewrap service and restore drill.
- Encrypted party names, addresses, tax IDs, bank details, attachments, and connector credentials with blind-index search where required.

The hosted release runs the isolated email worker with verified delivery, self-service owner signup, password plus TOTP activation, password recovery that preserves the organization DEK, invitations, roles, and session administration. The source gates remain fail-closed for new deployments. Online organization-key rotation is deliberately unavailable until record re-encryption and blind-index rebuilding can be made atomic.

## Milestone 2 — general-ledger workflow baseline implemented

- Organization/entity onboarding, ASPE or U.S. GAAP profile, functional currency, fiscal calendar, and demo chart creation.
- Segment configuration/rendering, journal draft/submit/approve/post, reversal/replacement, recurring journals, trial balance, general ledger, and period close/reopen UI.
- Audit explorer, CSV import to draft, attachments, and financial statements.

Tenant onboarding, multi-company configuration, enabled currencies and append-only FX rates, configurable account-segment presentation, manual journal draft/role-based auto-post, explicit posting, linked reversal, source-module ownership, period close/reopen/seal, debit/credit drilldown, trial balance, balance sheet, profit and loss, account inquiry, and CSV export are implemented. Recurring journals, bulk CSV journal import, and attachments remain later work.

## Milestone 3 — receivables/payables demo workflow baseline implemented

- Customer/supplier account workflows, quotes/orders where needed, invoices, bills, credit notes, payments, allocations, aging, statements, and realized FX.
- Append-only open-item allocation/settlement events; balances are derived rather than overwritten.
- Deterministic invoice/bill synchronous posting when the actor has the posting role; otherwise create a reviewable draft.

The current release implements an organization-wide encrypted party directory, entity-specific customer/supplier roles, scalable filtered AR/AP registers, service/non-stock invoice and bill drafts, issue/post, open items, recorded receipt/payment allocation, realized-FX posting, effective-dated FX suggestions, and void/reversal with source-owned journal lineage and transaction-tax snapshots. Quotes/orders, dedicated credit-note UX, aging statements/dunning, and external payment execution remain later work.

## Milestone 4 — tax reference-pack baseline; production packs pending

- Effective-dated Ontario HST and Washington location-rate ingestion with evidence, approvals, regression fixtures, tax returns, and reconciliation to the ledger.
- Preserve recoverable and nonrecoverable tax components separately through snapshot and GL mapping.
- Add jurisdictions as independent signed/versioned packs against the same engine contract.

The demo uses bundled Ontario and Washington reference packs for transaction decisions and evidence snapshots only. It does not ingest live official rates, prepare production returns, or file tax.

## Milestone 5 — initial banking/reconciliation baseline implemented

- Encrypted bank connections, import observations, deterministic matching suggestions, bank reconciliation, transfer handling, and cash reporting.
- Bank and AI actions remain observations/drafts; neither can post or delete history.

The initial release provides hardened SimpleFIN connection/sync for private tenants, encrypted credentials and descriptions, immutable versioned observations, account mapping, exact-decimal reconciliation, and immutable encrypted categorization-rule versions that produce manual-review suggestions only. The public demo uses synthetic observations and does not accept external credentials. Converting suggestions into GL/AR/AP/transfer drafts, direct bank-initiated posting, payment initiation, and unattended acceptance remain intentionally unavailable.

## Milestone 6 — MCP and public API

- Organization-bound OAuth service principals, rate limits, idempotency, tool-level scopes, audit, and revocation.
- Read tools and explicit draft creation only in v0. Posting, approval, period reopen, role changes, recovery, payment execution, and hard deletion are never MCP tools.

No public MCP endpoint is active in the writable-demo release.

## Later modular work

Inventory is designed for but not built. A future inventory manifest can add item/location/valuation/subledger contracts without changing the 13-field account key. Manufacturing, projects, insurance, payroll, fixed assets, budgeting, consolidation, and secondary ledgers follow the same module contract and release gates.
