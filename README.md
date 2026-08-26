# Business Finlynq

Open-source, audit-first accounting for small businesses at `business.finlynq.com`.

This repository is intentionally separate from personal Finlynq. It reuses proven architectural ideas—organization envelope encryption, explicit service boundaries, bank-import seams, and AI/MCP accessibility—without sharing databases, keys, cookies, or mutable financial records.

> Foundation status: the repository contains the approved domain contracts, PostgreSQL schema, accounting controls, tax-pack examples, tests, and a demo dashboard. It is not yet production-ready accounting software.

The hosted demo is deliberately read-only. Public access now exchanges `/try-demo` for a short-lived, revocable PostgreSQL session tied to one fixed synthetic organization. Both `ACCOUNT_LOGIN_ENABLED=false` and `BUSINESS_WRITES_ENABLED=false` remain release gates: do not enable real identities or writes until tenant-scoped loaders, encrypted party persistence, configured recovery delivery, off-server restore drills, and source workflows have passed their acceptance tests. See [docs/roadmap.md](docs/roadmap.md).

## P0 interactive demo

The public P0 release is a focused interactive product preview over bundled synthetic data. All visible routes and controls are wired: navigation, global search, report export, dialogs, and form-validation previews work in the browser. They do not persist records or change accounting state.

Posting, void/reversal, approval, period close/reopen/seal, role changes, recovery, tax overrides, payments, and MCP writes remain disabled. A preview must say that it is a demo and must never imply that a journal, document, or setting was saved. Reloading returns to the canonical demo dataset.

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
- AI and MCP start read/draft-only and use the same authorization, RLS, and audit path as the UI.

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

UI / API / MCP → application services → one posting service → PostgreSQL
```

Manufacturing, inventory, insurance, projects, payroll, banking, and other domains use versioned module manifests assembled at the application composition root. No module can bypass ledger invariants or edit another module's posted entries.

## Security boundary

Sensitive party data and connector credentials are selectively envelope-encrypted with an organization DEK. Exact ledger amounts and query keys remain queryable inside an encrypted PostgreSQL deployment so the database can enforce balance and reporting. Password/email recovery re-establishes access; it never rotates away or deletes the organization’s accounting data.

The wrapping root is loaded from a mounted secret file in production, and the runtime database role cannot mutate or delete wrapped organization keys. The current milestone provides the cryptographic primitives and deployment boundary; the key-provisioning/recovery workflow and encrypted party write service remain launch gates.

Production uses a separate OS service user, database, wrapping root, identity encryption secret, host-only cookies, storage, port, and off-server backup set from personal Finlynq. Session tokens are opaque and revocable; only their digest is stored. Password reset changes the user credential and revokes sessions without touching organization encryption keys or accounting rows.

## License

Business Finlynq is licensed under GNU AGPL-3.0-or-later. See [LICENSE](LICENSE).
