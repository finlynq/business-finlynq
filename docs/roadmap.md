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

## Milestone 1 — identity, recovery, and encrypted master data

- Signed session/OIDC identity resolver that produces tenant context server-side.
- Invitations, memberships, custom roles, MFA step-up, session revocation, and security notifications.
- Rate-limited email password reset that never changes or destroys the organization DEK.
- Co-owner/recovery-factor approval and delayed sole-owner recovery.
- Privileged organization-key provision/rotation/rewrap service and restore drill.
- Encrypted party names, addresses, tax IDs, bank details, attachments, and connector credentials with blind-index search where required.

Exit gate: recovery and encrypted persistence pass end-to-end tests; only then may `BUSINESS_WRITES_ENABLED` be enabled in a non-production test environment.

## Milestone 2 — usable general ledger

- Organization/entity onboarding, ASPE or U.S. GAAP profile, functional currency, fiscal calendar, and demo chart creation.
- Segment configuration/rendering, journal draft/submit/approve/post, reversal/replacement, recurring journals, trial balance, general ledger, and period close/reopen UI.
- Audit explorer, CSV import to draft, attachments, and financial statements.

## Milestone 3 — receivables and payables

- Customer/supplier account workflows, quotes/orders where needed, invoices, bills, credit notes, payments, allocations, aging, statements, and realized FX.
- Append-only open-item allocation/settlement events; balances are derived rather than overwritten.
- Deterministic invoice/bill synchronous posting when the actor has the posting role; otherwise create a reviewable draft.

## Milestone 4 — production tax packs

- Effective-dated Ontario HST and Washington location-rate ingestion with evidence, approvals, regression fixtures, tax returns, and reconciliation to the ledger.
- Preserve recoverable and nonrecoverable tax components separately through snapshot and GL mapping.
- Add jurisdictions as independent signed/versioned packs against the same engine contract.

## Milestone 5 — banking and reconciliation

- Encrypted bank connections, import observations, deterministic matching suggestions, bank reconciliation, transfer handling, and cash reporting.
- Bank and AI actions remain observations/drafts; neither can post or delete history.

## Milestone 6 — MCP and public API

- Organization-bound OAuth service principals, rate limits, idempotency, tool-level scopes, audit, and revocation.
- Read tools and explicit draft creation only in v0. Posting, approval, period reopen, role changes, recovery, payment execution, and hard deletion are never MCP tools.

## Later modular work

Inventory is designed for but not built. A future inventory manifest can add item/location/valuation/subledger contracts without changing the 13-field account key. Manufacturing, projects, insurance, payroll, fixed assets, budgeting, consolidation, and secondary ledgers follow the same module contract and release gates.
