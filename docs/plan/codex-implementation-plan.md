# Business Finlynq — Implementation Plan (Codex handoff)

Status: authored 2026-08-27 from a full three-track review (architecture/code quality, security, testing/CI/ops) plus `docs/roadmap.md` and `docs/architecture/001-foundation.md`. This document is self-contained: it is the work order for taking the project from the current P0 writable demo to a production bookkeeping service that covers the full set of financial areas (GL, AR/AP, tax, banking, inventory, fixed assets, budgeting, payroll, projects, consolidation, MCP/API).

Execute phases in order. Within a phase, items are ordered by priority. Do not start a later phase while a `[BLOCKER]` item in an earlier phase is open.

---

## 0. Ground rules — read before writing any code

These are frozen decisions from ADR 001 (`docs/architecture/001-foundation.md`) and load-bearing conventions verified in the codebase. Violating any of them is a defect, not a style choice.

1. **This Next.js version is not the one in your training data.** Read the relevant guide in `node_modules/next/dist/docs/` before writing Next-specific code. `src/proxy.ts` (not `middleware.ts`) is the correct proxy convention here.
2. **Money**: amounts move as strings; arithmetic only via `decimal.js` through `src/kernel/money.ts`; PostgreSQL `numeric(38,9)` for amounts, `numeric(38,18)` for FX rates; per-currency minor-unit quantization on posted amounts. Never use JS `number` for money.
3. **One posting service**: every journal that reaches POSTED goes through `postJournalInTransaction` (`src/modules/ledger/posting-service.ts`). New modules never insert/update posted journal rows directly. Posted rows are immutable; corrections are linked reversals/replacements. No hard deletes anywhere in app/API/MCP.
4. **Every mutation service** follows the established pattern: zod-parse the command → `assertTenantWritesEnabled(context)` → `withTenantTransaction` (`src/db/transaction.ts`) → `await assertWritableOrganization(client, context)` inside the transaction → idempotency-key claim with command-fingerprint verification → domain writes → audit event → outbox event. Copy an existing service (e.g. `src/modules/ledger/journal-service.ts`) as the template.
5. **Every HTTP mutation route** uses the shared route factory pattern (`src/app/api/_shared/subledger-mutation-route.ts`): same-origin check → principal + `principalCanWrite` → rate limit → bounded JSON → schema parse → redacted error logging (`errorType` + `requestId` only, never the error object or body).
6. **Tenancy**: every tenant row carries `organization_id`; accounting rows also carry `ledger_id`; composite tenant-scoped FKs; RLS with `FORCE ROW LEVEL SECURITY` on every new tenant table against the non-owner runtime role; `app.current_organization_id()` fails closed. Org id always comes from the server-resolved principal — no API ever accepts a client-supplied organization id.
7. **Migrations are the source of truth.** Hand-written SQL in `migrations/drizzle/`, replayed in CI. Every new tenant table needs: RLS policy + FORCE, role grants reconciled in the grant-matrix scripts under `deploy/postgres/`, and a matching Drizzle declaration in `src/db/schema/` (kept in sync by discipline — and by the new guard added in Phase 1.3).
8. **Encryption**: sensitive party/connector data is envelope-encrypted with the org DEK (AES-256-GCM, AAD binding org/table/column/record/key-version — `src/security/organization-encryption.ts`); exact amounts and reporting keys stay queryable. Blind indexes for exact-match search on encrypted fields. Never log plaintext of encrypted fields (this is why route error logs are redacted).
9. **Flags**: `DEMO_LOGIN_ENABLED`, `DEMO_WRITES_ENABLED`, `ACCOUNT_LOGIN_ENABLED`, `BUSINESS_WRITES_ENABLED` are independent gates. Demo and real writes must remain structurally separated (DB trigger `guard_auth_session_mode` + org-mode match in `src/modules/workspace/write-policy.ts`). Nothing you build may weaken this.
10. **Quality gate for every task**: `npm run check` (lint zero-warnings + typecheck + vitest) and `npm run build` green; DB-integration suites (`tests/db/`) green with `TEST_DATABASE_URL` et al. set; new behavior gets behavioral tests at the same altitude as existing ones (service tests against live Postgres for DB behavior, route tests mocking only the service boundary). Update `docs/` in the same change when behavior or ops contracts move.

---

## Phase 0 — Review remediation (fix the known defects first)

Small, contained, all verified at file:line. Land as individual commits.

### 0.1 [BLOCKER] Repair the Drizzle snapshot chain
`migrations/drizzle/meta/` holds snapshots 0000–0003 while `_journal.json` runs to idx 11 (0004–0011 are hand-written). The next `drizzle-kit generate` will diff against snapshot 0003 and re-emit `CREATE TABLE` for `auth_sessions`, `demo_sandbox_slots`, etc., which fails on replay.
- Regenerate snapshots so the latest snapshot matches the real post-0011 schema, or adopt the `drizzle-kit generate --custom` flow for hand-authored migrations so the snapshot chain stays contiguous.
- Acceptance: `npm run db:generate` against the current schema produces an **empty** diff; CI migration replay still passes; add a CI step that fails if generate produces a non-empty diff (this becomes the schema-drift guard referenced in 1.3).

### 0.2 `postJournal` must call `assertWritableOrganization`
`src/modules/ledger/posting-service.ts:163-172` calls only `assertTenantWritesEnabled`; every sibling mutation (journal, period, posting-policy, party, AR/AP services) also calls `assertWritableOrganization` inside the transaction. Add `await assertWritableOrganization(client, command.context)` inside `postJournal`'s `withTenantTransaction` before `postJournalInTransaction`. Add a test mirroring the existing write-policy tests.

### 0.3 Fix `x-forwarded-for` trust
`src/modules/identity/request-security.ts:38-41` takes the **leftmost** XFF entry (client-controlled). Behind any proxy that appends rather than replaces XFF, an attacker rotates it to bypass every per-IP rate limit and drain the demo sandbox pool (per-IP two-lease cap in migration 0011 keys off this value).
- Introduce a `TRUSTED_PROXY` (or hop-count) env contract: when unset, ignore XFF entirely and use the socket address; when set, take the rightmost untrusted-boundary entry.
- Document in `docs/deployment/vps.md` that any non-Caddy fronting proxy must overwrite (not append) XFF.
- Acceptance: unit tests covering spoofed-leftmost, appended-chain, and no-proxy cases; demo lease cap unaffected for the reference deploy.

### 0.4 Migrate the five hand-rolled mutation routes onto the shared factory
`src/app/api/ledger/journals/route.ts`, `.../journals/[journalId]/post/route.ts`, `.../reverse/route.ts`, `.../periods/[periodId]/transition/route.ts`, `src/app/api/parties/route.ts` each re-implement ~60–90 lines of the boundary sequence and all five **log full error objects** (zod errors can embed received input; the parties path handles plaintext party names). Generalize `createSubledgerMutationRoute` (rename to `createMutationRoute`) and migrate all five. This fixes the log-redaction inconsistency structurally.
- Acceptance: no route handler logs an error object or request body; existing route tests pass unmodified except for log assertions.

### 0.5 Resolve the dead module-manifest layer
`src/modules/registry.ts`, the five `manifest.ts` files, `src/modules/ledger/journal-types.ts`, `posting-validator.ts`, `auto-post-policy.ts`, `fx-policy.ts`, and `mcp/policy.ts` are consumed only by tests; runtime truth lives in SQL seeds (migrations 0006/0011) and DB triggers. **Wire them in rather than deleting** (later phases need the registry): add a startup/CI assertion that compares `journalTypeRegistry` manifests against `journal_type_definitions` rows and fails on drift; delete only the parallel policy modules that will never be authoritative (`auto-post-policy.ts`, `fx-policy.ts` — confirm nothing else imports them).
- Acceptance: a deliberate drift (edit a manifest version) fails CI; module registry becomes the single TS source from which seed SQL for new journal types is generated (used by every later phase that adds journal types).

### 0.6 Smaller fixes (one commit each)
- `src/db/transaction.ts:145-147`: wrap ROLLBACK in try/catch so a rollback failure doesn't mask the domain error.
- Canonicalize idempotency fingerprints (sorted-key JSON serialization) in `journal-service.ts:75-77`, `ar-ap-service.ts`, `party-service.ts`; version the fingerprint so existing stored fingerprints stay valid (accept old-format match OR new-format match during a transition window).
- Batch per-row INSERT loops into multi-row `VALUES`/`UNNEST`: `journal-service.ts:261-287`, `ar-ap-service.ts:1118-1151`, `:1653`, `:2311`, `:941` (the pattern to copy is `journal-service.ts:460-479`).
- Fix the cartesian LEFT JOIN in `src/modules/workspace/tenant-workspace.ts:455-496` (periods × accounts): two queries or `json_agg` one side.
- `src/app/api/health/route.ts`: keep `/api/live` public; gate the flag-posture/revision body to loopback/internal callers.
- Session UA binding: store empty-string hash instead of NULL at issuance (migration touching the check in 0007's session resolution; keep backward compatibility for existing NULL rows).
- Remove dead `LocalRootKeyProvider.fromBase64` (`src/security/organization-encryption.ts:79-81`).
- Remove hardcoded `badge: "2"` in `src/modules/workspace/workspace-shell.tsx:20`.
- CSP: move to nonce-based `script-src` (App Router supports per-request nonces via the proxy/headers path); drop `'unsafe-inline'` from `next.config.ts:48`.
- ESLint: add type-aware `@typescript-eslint` rules, minimum `no-floating-promises` and `no-misused-promises`; fix anything they surface.
- `package.json`: add `"engines": { "node": ">=24", "npm": ">=11" }`.
- Dockerfile / docker-compose: pin base images by `@sha256` digest.
- Document DB-integration test setup (`TEST_DATABASE_URL`, `TEST_APP_DATABASE_URL`, `TEST_AUTH_WORKER_DATABASE_URL`, role provisioning via `deploy/postgres/`) in README + `.env.example`; make the skipped suites print a loud warning.
- Add integration tests for shared demo reset failure branches: forced identity or purge failure records FAILED and closes entry; repaired rerun restores READY; nightly reset revokes every live visitor session and restores the exact baseline.
- Split `src/modules/subledger/ar-ap-service.ts` (2,525 lines) along its seams: locks/idempotency helpers, pure line-building (already pure at :860-929), persistence, and the four command orchestrations. Pure refactor — tests must pass unmodified.

---

## Phase 1 — Production readiness (activate what's built)

Goal: a real (non-demo) organization can safely run on `business.finlynq.com` with `ACCOUNT_LOGIN_ENABLED=true` and `BUSINESS_WRITES_ENABLED=true` for onboarded orgs. Milestone 1 code exists; this phase clears its activation gates and closes operational gaps.

### 1.1 Account activation gate (Milestone 1 exit)
- Verified sending domain + provider credential for the auth email worker (`src/workers/auth-email-worker.ts`, Resend); worker deployed as the isolated service the compose file already defines.
- Recovery-material escrow procedure documented and rehearsed (`docs/operations/account-authentication.md`, `organization-keys.md`).
- Operator-observed acceptance exercise: scripted end-to-end pass of invite → login → MFA → password reset → co-owner recovery → sole-owner delayed recovery, against a production-like environment. Automate as a Playwright suite (`e2e/account-activation.e2e.ts`) run behind a flag in CI.
- Per-organization write enablement: replace the global `BUSINESS_WRITES_ENABLED` semantics with global-AND-per-org (an `organizations.writes_enabled_at` column set by an operator script `scripts/enable-org-writes.ts`), so one activated org doesn't open writes for all. `assertWritableOrganization` picks up the per-org check.

### 1.2 Online organization-key rotation
Currently deliberately disabled until re-encryption + blind-index rebuild are atomic.
- Implement chunked, resumable re-encryption: new key version wraps in `organization_key_versions`; background job re-encrypts encrypted columns table-by-table with per-chunk transactions and a progress cursor; blind indexes rebuilt alongside; reads accept (current, previous) key versions during rotation; cutover flips the active version only after verification counts match; old version retired after a grace period.
- Acceptance: rotation drill in CI-adjacent integration test (small dataset), restore-drill compose profile extended to verify post-rotation restores.

### 1.3 Schema-ops guardrails
- CI step from 0.1 (generate-diff must be empty).
- A startup assertion (dev/CI only) that Drizzle declarations match information_schema for tenant tables (column names/types), so "in sync by discipline" becomes "in sync by check".

### 1.4 Observability
- `docs/operations/monitoring-and-alerting.md` exists; implement what it promises that is missing: structured JSON logs with `requestId` propagation (already partially present), error-rate and auth-failure alerts, demo-pool depth gauge, outbox lag gauge, backup-verification alert. Expose an internal `/api/metrics` (loopback-only) in Prometheus format.

### 1.5 CD (optional but recommended)
- Keep the manual runbook as the contract, but encode it: a `deploy/release.sh` that performs the runbook steps (build → push → migrate → grant reconciliation → health verification → rollback adapter) so runbook drift stops being a standing risk. CI job builds and publishes the commit-addressed images the runbook consumes.

---

## Phase 2 — Complete the GL and AR/AP feature set (Milestones 2–3 gated work)

Everything here follows Ground Rules 3–7 exactly. Each feature = migration (if needed) + service + route(s) via the shared factory + UI + tests + docs.

### 2.1 GL completeness
- **Posting-policy administration UI** (service exists — `posting-policy-service.ts`): role-based auto-post configuration per journal type, admin-permission gated.
- **Interactive reversal controls** in the journal register (service exists): pick reversal period from allowed open periods, show linkage both directions.
- **Recurring journals**: `recurring_journal_templates` (tenant table, RLS) + schedule (RRULE-lite: monthly/quarterly/annual, day-of-period), generation worker that materializes DRAFTs through the normal draft service (never direct posting), skip/catch-up semantics for closed periods, template versioning. UI: template CRUD + upcoming-runs preview.
- **CSV import to draft**: streaming parse with the existing bounded reader, column mapping UI, per-row validation against the posting validator surface, import batch entity with per-row error report, output = DRAFT journals only. Formula-injection-safe export already exists; imports must sanitize likewise.
- **Attachments**: encrypted-at-rest object storage (filesystem volume in v0, seam for S3-compatible later), per-attachment envelope encryption with org DEK + AAD, attach to journals and source documents, size/type limits, audit events. No public URLs; streamed through an authorized route.
- **Approval workflow surface**: journal submit → approve → post chain for orgs where auto-post is off (permissions already modeled: draft/submit/approve/post).

### 2.2 Reporting set
Read-only, no posting-path risk; all reports respect period states and are exact-decimal.
- Trial balance (exists in demo scope) hardened for real orgs: by period range, by entity, segment filtering on the 13-field key.
- **General ledger detail** report with drill-down journal → source document.
- **Financial statements**: balance sheet, income statement, cash-flow (indirect) driven by an account-classification mapping table per accounting profile (ASPE / US GAAP non-public); statement layouts versioned per entity; comparative periods.
- **AR/AP aging** (30/60/90/custom buckets) from open items — balances derived, never stored.
- **Customer/supplier statements** (open items + activity for a date range, printable).
- CSV export for every report (reuse the injection-escaping exporter).

### 2.3 AR/AP completeness
- **Credit notes / debit notes**: first-class document kinds in `DOCUMENT_KIND_POLICY` with linked application against open items via the existing append-only allocation events; refund-without-application supported as its own settlement kind.
- **Quotes and orders** (non-posting documents): quote → order → invoice lineage with document-version snapshots; no GL effect until invoice issue.
- **Dunning**: reminder schedule config per customer account, generated notices (email via the auth email worker's delivery seam, generalized into a `notifications` outbox consumer), full audit trail. Email content must not include encrypted-field plaintext beyond what the recipient owns.
- **Realized/unrealized FX completion**: monetary open-item revaluation at period end using reverse-next-period method (ADR: revaluation journals auto-reverse in the next period), via a period-close step that generates DRAFT or posts per policy.

### 2.4 Multi-currency hardening
- Rate management UI: manual effective-dated rates per pair, rate-type taxonomy (spot/closing/average), provenance capture. (Live rate feeds are a Phase 4 banking-adjacent connector; keep the seam.)

---

## Phase 3 — Production tax (Milestone 4)

- **Effective-dated official rate ingestion**: Washington DOR location-rate files and Ontario HST rates ingested as signed, versioned pack data with evidence (source URL, checksum, effective window), operator approval step before a pack version activates. Regression fixtures per pack version.
- **Tax returns**: return periods per registration; return preparation aggregates posted tax snapshots (recoverable vs nonrecoverable preserved separately) into jurisdiction return lines; reconciliation report tying return lines to GL control accounts; return states DRAFT → APPROVED → FILED(manually) → CLOSED with period-control interaction (filing locks the tax period). **No e-filing integration in this slice** — FILED records the operator's external filing with reference + date.
- **Pack contract**: new jurisdictions ship as independent signed/versioned packs against the same engine contract (`src/modules/tax/`); MANUAL_REVIEW_REQUIRED remains the fail-closed outcome. Add one additional pack (e.g. a second Canadian province) to prove the contract generalizes.

---

## Phase 4 — Banking and reconciliation (Milestone 5)

ADR constraint: bank data and AI produce **observations/suggestions/drafts only** — nothing in this phase may post or delete history.

- **Encrypted bank connections**: connector credential storage via existing envelope encryption (schema seam already named in ADR); v0 connector = file import (OFX/QFX/CSV/CAMT.053), with the connector interface designed so an aggregator (Plaid/Flinks) can be added without schema change. No live aggregator in v0 unless separately approved.
- **Import observations**: `bank_transaction_observations` append-only tenant table; dedup by (connection, fit-id/hash); immutable raw payload retained encrypted.
- **Matching suggestions**: deterministic rule engine (amount+date window+reference heuristics) producing suggestions against open items and GL entries; user confirms → creates settlement/journal DRAFTs through existing services.
- **Bank reconciliation**: statement-period reconciliation workspace — opening/closing balance assertions, matched/unmatched observation lists, adjustment journal drafts for bank charges/interest, reconciliation sign-off snapshot (immutable), period-close integration (warn on unreconciled bank accounts).
- **Transfer handling**: inter-account and inter-entity transfer recognition (intercompany uses the Intercompany segment, never a party).
- **Cash reporting**: cash position and short-horizon forecast from open items + recurring templates.

---

## Phase 5 — Inventory (first deferred module, proves the module contract)

ADR: designed-for but not built; must be additive via a module manifest without changing the 13-field account key.

- **Module manifest** registered through the (now live, per 0.5) registry: journal types for receipt, shipment, adjustment, COGS.
- **Item master**: items, units of measure, item tax categories; location model (warehouse → location).
- **Valuation**: v0 = moving average cost per item/location (exact-decimal); FIFO layers as schema-ready extension, not built.
- **Stock subledger**: append-only quantity/value movements tied to source documents; on-hand derived, never overwritten (same derivation discipline as AR/AP open items).
- **Document integration**: invoice/bill lines gain optional item references; goods receipt → AP accrual → bill matching (3-way lite: order/receipt/bill quantity+price tolerance); COGS posting on shipment/invoice per policy through the one posting service.
- **Inventory reports**: on-hand by location, valuation summary reconciling to the inventory control account, movement history.
- Exit: inventory control accounts reconcile to the stock subledger in an integration test; module can be disabled per org without orphaning GL data.

---

## Phase 6 — Fixed assets and budgeting

### 6.1 Fixed assets
- Asset register (acquisition from bill lines or manual), asset classes mapping to GL accounts, depreciation profiles (straight-line, declining-balance) per accounting profile, monthly depreciation run generating DRAFT/auto-post journals per policy, disposal/partial-disposal with gain/loss posting, revaluation excluded (ASPE/US GAAP non-public v0), asset reports reconciling register to control accounts.

### 6.2 Budgeting
- Budget versions per entity/fiscal year over the same account-combination space; budget lines exact-decimal; import from CSV; budget-vs-actual reporting integrated into the statement layer; no posting-path interaction.

---

## Phase 7 — Payroll, projects, consolidation (scope-gate before building)

These are large; ship in this order only after Phases 1–4 are in production use. Each starts with its own ADR.

- **Payroll (v0 = journal integration, not calculation)**: import posted payroll summaries from external providers (CSV/API) into mapped GL postings with liability tracking. Full gross-to-net calculation, remittances, and filings are explicitly out of scope until a dedicated compliance review — do not build tax tables.
- **Projects**: project dimension usage (one of the Custom segments per org policy), project profitability reporting; time/expense capture only as drafts.
- **Consolidation & secondary ledgers**: schema already permits multiple ledgers per entity. Presentation-currency translation (never posting into the operating ledger, per ADR), elimination entries in a consolidation ledger, minority-interest out of scope v0.

---

## Phase 8 — MCP and public API (Milestone 6)

- Organization-bound OAuth service principals; token issuance/revocation UI under org admin; scopes at tool level.
- v0 tools: **read-only** (accounts, journals, open items, reports) plus **explicit draft creation** (journal draft, invoice/bill draft) through the same application services, RLS transaction context, rate limits, idempotency keys, and audit path as the UI.
- Hard exclusions (never MCP tools): posting, approval, period reopen, role changes, recovery, payment execution, hard deletion.
- The dormant `src/modules/mcp/policy.ts` becomes the authoritative scope table (wired per 0.5).
- Public HTTP API mirrors the MCP tool surface (same handlers, two protocols).
- Security review of this phase is mandatory before exposure; add MCP abuse tests (scope escalation attempts, cross-org probing, idempotency replay).

---

## Cross-cutting definition of done (applies to every task above)

1. `npm run check` and `npm run build` green; DB suites green against live Postgres.
2. New tenant tables: RLS + FORCE, grant-matrix reconciliation, restore-drill compatibility, demo-reset purge order updated (`demo-bootstrap.ts` child-first purge list) if demo-visible.
3. New mutations: idempotency key, audit event, outbox event, rate limit, redacted logging.
4. New journal types: registered in the module manifest registry (single source, per 0.5), seeded via generated SQL, covered by the drift assertion.
5. Docs updated in the same change: `docs/roadmap.md` status, relevant `docs/operations/*` runbook, README if user-visible.
6. Demo scope: decide per feature whether it enters the sandbox demo (then: seed data + reset baseline counts updated + e2e coverage in `e2e/release-gate.e2e.ts`) or stays flag-gated off in demo.
7. No new dependency without justification recorded in the PR; prod dependency count is deliberately small (7 today).
