# Business Finlynq

Open-source, audit-first accounting for small businesses at `business.finlynq.com`.

This repository is intentionally separate from personal Finlynq. It reuses proven architectural ideas—organization envelope encryption, explicit service boundaries, hardened SimpleFIN access, and extension seams for AI access—without sharing databases, keys, cookies, or mutable financial records.

> Release status: the hosted application provides self-service private organizations plus an isolated, writable synthetic demo. Its supported bookkeeping scope is general ledger, role-based posting, immutable corrections, period control, multi-company and multi-currency setup, unified parties, service/non-stock receivables and payables, transaction-tax decisions, bank-feed observations/reconciliation, and financial reporting. It is not a complete ERP or a tax filing/payment service; inventory, production returns/filing, live payment execution, and public MCP access remain gated.

Public access exchanges `/try-demo` for a short-lived PostgreSQL session plus a separate host-only daily claim to one exclusive sandbox organization. Only digests are stored. Logout and session expiry preserve that browser's changed business; the Toronto nightly reset invalidates claims and restores the 128-slot pool. Demo writes remain limited to a live demo-link session in a `SANDBOX` organization. See [docs/roadmap.md](docs/roadmap.md).

Real login, signup, business writes, demo writes, email delivery, bot protection, and bank feeds are independent deployment gates. The source defaults fail closed. The hosted release enables real-account onboarding only with the isolated email worker, verified sender, Turnstile, MFA enrollment, recovery, backup, and monitoring controls described in the operations runbooks.

## P0 interactive demo

The public demo is a focused interactive product preview over synthetic data. Every visitor receives an independently encrypted sandbox seeded with two legal entities, complete GL/fiscal/tax configuration, usable customer and supplier accounts, and synthetic bank observations. Changes persist inside that sandbox so reports and downstream workflows reflect them until the nightly reset.

Visitors can exercise the same bookkeeping settings and accounting workflows as a private owner: create and post balanced journals; create, issue, settle, and void service/non-stock invoices and bills; review tax evidence; configure companies, dimensions, currencies, and rates; reconcile synthetic bank activity; run financial statements and account inquiries; and test period controls. External bank credentials and outbound provider synchronization are disabled in the public sandbox. Recorded receipts and supplier payments are accounting events only—no money moves.

Each session ends after 15 minutes idle or one hour total, but the browser claim survives logout and session expiry until 04:15 `America/Toronto`. Re-entry resumes the same sandbox. Nightly reconciliation invalidates claims, purges registered tenant rows child-first, restores the exact seed, increments every sandbox generation, and returns the full pool to service. Ordinary deployments prepare only additive dirty slots and never run this destructive reset.

Do not enter real or confidential information in the demo. Inventory, live bank credentials, live payments, tax returns or filing, identity/recovery administration, and MCP writes are not part of the sandbox.

The browser acceptance checklist and production launch gates are in [docs/operations/interactive-demo.md](docs/operations/interactive-demo.md). The deployment and rollback contract is in [docs/deployment/vps.md](docs/deployment/vps.md).

## Product contract

- One organization can contain multiple legal entities.
- Each legal entity has one visible primary ledger in v0; the schema permits more later.
- A legal entity may use any supported ISO currency and two-letter country code; the current accounting-profile choices are Canadian ASPE and U.S. GAAP for non-public entities.
- Posted journals are exact-decimal, balanced, immutable, and corrected by linked reversal/replacement.
- Periods move through `OPEN`, `ADJUSTMENT_ONLY`, `HARD_CLOSED`, and `SEALED`.
- Party, customer, and supplier numbers never occupy chart-of-account segments.
- The canonical account key has 13 typed fields: Entity, Account, Subaccount, Department, Intercompany, and Custom 1–8.
- Tax automation is opt-in through explicit registration, jurisdiction, location, validity, and evidence facts. Ontario HST and the reviewed Washington location pack are bundled; everything else fails to manual review rather than silent zero tax.
- Inventory is deferred; current invoice and bill lines are service/non-stock only.
- A future MCP surface starts with organization-bound reads and explicit draft proposals through the same authorization, RLS, and audit path as the UI; no public MCP endpoint is active today.

The complete frozen decisions and invariants are in [docs/architecture/001-foundation.md](docs/architecture/001-foundation.md).

## Local development

Requirements: Node.js 24+, npm 11+, and PostgreSQL 16+. Cloud PDF ingestion also requires Poppler (`poppler-utils`); deployment images include it.

The MCP-driven Google Drive/OneDrive inbox keeps new cloud originals in user storage and uses the client for AI processing. See the [cloud inbox setup and operations guide](docs/operations/document-cloud-inbox.md). Provider credentials and live acceptance are required before enabling a deployment.

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

### Database integration tests

The ordinary test command includes PostgreSQL integration suites, but they
skip—and print a prominent warning—unless all required database URLs are set.
Use a disposable PostgreSQL 16 database only; the suites migrate, seed, lease,
reset, and delete test records.

Set `TEST_DATABASE_URL` to an owner connection, then provision the two
least-privilege roles with the same reviewed scripts used by production:

```bash
POSTGRES_USER=postgres POSTGRES_DB=business_finlynq_test PGHOST=127.0.0.1 \
  PGPASSWORD='<owner-password>' sh deploy/postgres/010-runtime-role.sh
POSTGRES_USER=postgres POSTGRES_DB=business_finlynq_test PGHOST=127.0.0.1 \
  PGPASSWORD='<owner-password>' sh deploy/postgres/015-auth-worker-role.sh
```

The scripts read the runtime and worker passwords from
`APP_DATABASE_PASSWORD_FILE` and `AUTH_WORKER_DATABASE_PASSWORD_FILE`.
Configure `TEST_APP_DATABASE_URL` for `business_finlynq_app` and
`TEST_AUTH_WORKER_DATABASE_URL` for `business_finlynq_auth_worker`, replay the
migrations with `npm run db:migrate`, then run `npm run test:db`. CI performs
this full owner/runtime/worker setup plus RLS, grant, predecessor-upgrade, and
restore verification on every push.

Database migrations are the deployment source of truth. Drizzle declarations and the latest generated snapshot are checked against that journal in CI, and `npm run db:check-drift` fails when a declaration would generate an unreviewed migration. Use `npm run db:generate` for declaration-backed changes and `npm run db:generate:custom` for reviewed functions, policies, grants, or backfills. The complete forward-only workflow and verification requirements are in [docs/operations/migrations.md](docs/operations/migrations.md).

## Modules

```text
kernel
├── organizations → legal entities → ledgers
├── ledger → periods + COA + posting + corrections
├── parties → customer/supplier roles + encrypted addresses
├── tax → shared decision contract + jurisdiction packs
├── subledger → AR/AP open items → ledger + parties
└── banking → encrypted SimpleFIN observations + reconciliation + draft proposals

UI / HTTP API / future MCP → application services → one posting service → PostgreSQL
```

Manufacturing, inventory, insurance, projects, payroll, and other future domains use versioned module manifests assembled at the application composition root. No module—including banking—can bypass ledger invariants or edit another module's posted entries.

## Security boundary

Sensitive party data and connector credentials are selectively envelope-encrypted with an organization DEK. Exact ledger amounts and query keys remain queryable inside an encrypted PostgreSQL deployment so the database can enforce balance and reporting. Password/email recovery re-establishes access; it never rotates away or deletes the organization’s accounting data.

The wrapping root is loaded from a mounted secret file in production, and the runtime database role cannot mutate or delete wrapped organization keys. Initial organization-key provisioning, encrypted party writes, blind-index exact-name search, and restore-time key verification are implemented. Online key rotation remains disabled until re-encryption and blind-index rebuilding can complete atomically.

Production uses a separate OS service user, database, wrapping root, identity encryption secret, host-only cookies, storage, port, and off-server backup set from personal Finlynq. Session tokens are opaque and revocable; only their digest is stored. Password reset changes the user credential and revokes sessions without touching organization encryption keys or accounting rows.

## License

Business Finlynq is licensed under GNU AGPL-3.0-or-later. See [LICENSE](LICENSE).
