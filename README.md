# Business Finlynq

Open-source, audit-first accounting for small businesses at `business.finlynq.com`.

This repository is intentionally separate from personal Finlynq. It reuses proven architectural ideas—organization envelope encryption, explicit service boundaries, and extension seams for future banking and AI access—without sharing databases, keys, cookies, or mutable financial records.

> Release status: the public site is an isolated, writable synthetic demo—not a production bookkeeping service or a complete ERP. The demo covers manual GL, service/non-stock receivables and payables, recorded settlements, transaction tax decisions, reporting, and period controls. Real-account activation, production tax filing, banking, inventory, live payment execution, and MCP access remain gated.

Public access exchanges `/try-demo` for a short-lived PostgreSQL session plus a separate host-only daily claim to one exclusive sandbox organization. Only digests are stored. Logout and session expiry preserve that browser's changed business; the Toronto nightly reset invalidates claims and restores the 128-slot pool. Demo writes remain limited to a live demo-link session in a `SANDBOX` organization. See [docs/roadmap.md](docs/roadmap.md).

The hosted demo keeps `ACCOUNT_LOGIN_ENABLED=false`, `ACCOUNT_SIGNUP_ENABLED=false`, and `BUSINESS_WRITES_ENABLED=false`. Self-service real-account signup is implemented behind independent login, email-delivery, and bot-protection gates; it must not be enabled as an accidental side effect of demo writes.

## P0 interactive demo

The public P0 release is a focused interactive product preview over synthetic data. Every visitor receives an independently encrypted sandbox seeded with two legal entities, complete GL/fiscal/tax configuration, and usable customer and supplier accounts. Changes persist inside that sandbox so reports and downstream workflows reflect them during the session.

Visitors can create and post balanced manual journals according to the seeded role and posting policy; create, issue, and void service/non-stock invoices and bills; record and reverse synthetic receipt/payment allocations; exercise transaction-tax decisions and snapshots; review reporting; and test period controls. Recorded receipts and supplier payments are accounting events only—no money moves and no bank is connected.

Each session ends after 15 minutes idle or one hour total, but the browser claim survives logout and session expiry until 04:15 `America/Toronto`. Re-entry resumes the same sandbox. Nightly reconciliation invalidates claims, purges registered tenant rows child-first, restores the exact seed, increments every sandbox generation, and returns the full pool to service. Ordinary deployments prepare only additive dirty slots and never run this destructive reset.

Do not enter real or confidential information. Inventory, bank feeds/reconciliation, live payments, tax returns or filing, identity/recovery administration, and MCP writes are not part of this demo.

The browser acceptance checklist and production launch gates are in [docs/operations/interactive-demo.md](docs/operations/interactive-demo.md). The deployment and rollback contract is in [docs/deployment/vps.md](docs/deployment/vps.md).

## Product contract

- One organization can contain multiple legal entities.
- Each legal entity has one visible primary ledger in v0; the schema permits more later.
- Canadian entities use ASPE and U.S. non-public entities use U.S. GAAP profiles.
- Posted journals are exact-decimal, balanced, immutable, and corrected by linked reversal/replacement.
- Periods move through `OPEN`, `ADJUSTMENT_ONLY`, `HARD_CLOSED`, and `SEALED`.
- Party, customer, and supplier numbers never occupy chart-of-account segments.
- The canonical account key has 13 typed fields: Entity, Account, Subaccount, Department, Intercompany, and Custom 1–8.
- Inventory is deferred; current invoice and bill lines are service/non-stock only.
- A future MCP surface starts with organization-bound reads and explicit draft proposals through the same authorization, RLS, and audit path as the UI; no public MCP endpoint is active today.

The complete frozen decisions and invariants are in [docs/architecture/001-foundation.md](docs/architecture/001-foundation.md).

## Local development

Requirements: Node.js 24+, npm 11+, and PostgreSQL 16+.

```bash
cp .env.example .env.local
npm install
npm run dev
```

Quality checks:

```bash
npm run check
npm run build
```

Database migrations are the source of truth. Drizzle declarations provide type-safe access but do not replace migration replay in CI or production.

## Modules

```text
kernel
├── organizations → legal entities → ledgers
├── ledger → periods + COA + posting + corrections
├── parties → customer/supplier roles + encrypted addresses
├── tax → shared decision contract + jurisdiction packs
└── subledger → AR/AP open items → ledger + parties

UI / HTTP API / future MCP → application services → one posting service → PostgreSQL
```

Manufacturing, inventory, insurance, projects, payroll, banking, and other domains use versioned module manifests assembled at the application composition root. No module can bypass ledger invariants or edit another module's posted entries.

## Security boundary

Sensitive party data and connector credentials are selectively envelope-encrypted with an organization DEK. Exact ledger amounts and query keys remain queryable inside an encrypted PostgreSQL deployment so the database can enforce balance and reporting. Password/email recovery re-establishes access; it never rotates away or deletes the organization’s accounting data.

The wrapping root is loaded from a mounted secret file in production, and the runtime database role cannot mutate or delete wrapped organization keys. Initial organization-key provisioning, encrypted party writes, blind-index exact-name search, and restore-time key verification are implemented. Online key rotation remains disabled until re-encryption and blind-index rebuilding can complete atomically.

Production uses a separate OS service user, database, wrapping root, identity encryption secret, host-only cookies, storage, port, and off-server backup set from personal Finlynq. Session tokens are opaque and revocable; only their digest is stored. Password reset changes the user credential and revokes sessions without touching organization encryption keys or accounting rows.

## License

Business Finlynq is licensed under GNU AGPL-3.0-or-later. See [LICENSE](LICENSE).
