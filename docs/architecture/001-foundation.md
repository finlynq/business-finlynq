# ADR 001 — Business Finlynq foundation

Status: accepted for the v0 build on 2026-08-26.

## Bounded context and tenancy

An `organization` is a workspace/security boundary. It owns one or more `legal_entities`. Every tenant row carries `organization_id`; every accounting row also carries `ledger_id`. Composite foreign keys and PostgreSQL row-level security prevent cross-tenant references even if an application query omits a filter.

Each legal entity exposes one primary ledger in v0. The ledger table is not artificially limited to one total ledger, preserving a later path to tax, management, or consolidation ledgers. The primary ledger’s functional currency and accounting profile (`CAN_ASPE` or `US_GAAP_NONPUBLIC`) become immutable after the first posting.

## Money and foreign currency

- Monetary values use PostgreSQL `numeric(38,9)` and `decimal.js`; binary floating point is prohibited.
- FX rates use `numeric(38,18)` and one quote convention: functional-currency units per transaction-currency unit.
- Posted USD and CAD amounts quantize to two minor-unit digits. Unit prices and intermediate calculations retain higher precision.
- Tax packs own line/document rounding rules. Current packs use round-half-up at the line level.
- Every foreign-currency journal line snapshots transaction amount/currency, functional amount, rate, rate type, source, and effective time.
- Monetary open items use reverse-next-period revaluation. Partial settlement realizes FX on the allocated carrying amount only.
- Presentation-currency translation does not post into the operating ledger.

## Account classification

The rendered key is:

```text
Entity.Account.Subaccount.Department.Intercompany.Custom1.Custom2.Custom3.Custom4.Custom5.Custom6.Custom7.Custom8
```

All positions are separate typed columns on an account combination. Entity and Account are required. Other fields are nullable; the UI renders null as `0000`. Literal `0000` is reserved and cannot be created as a user code. Intercompany is a foreign key to another legal entity, never a party/address number.

Eight custom slots cost a small fixed amount per combination and avoid future schema changes. Unused slots are hidden. Their lifecycle is `EMPTY → CONFIGURED_UNBOUND → ACTIVE_LOCKED ↔ INACTIVE_LOCKED`. A configured slot may be reset only before protected use and with an audited administration permission. Used definitions and values are deactivated, never repurposed or deleted.

## Parties, AR, and AP

A Party has one organization-wide `party_number` and can independently have CUSTOMER and SUPPLIER roles. Legal-entity customer and supplier accounts carry their own display numbers. Prefixes such as `P:`, `C:`, `S:`, and `IC:` are search/display syntax only.

Effective-dated party addresses are encrypted. Issued source documents snapshot the address/version used. AR/AP control lines require a typed subledger account, party, source document, and open-item provenance. They cannot be entered as ordinary manual GL lines. AR and AP never net automatically, even when one Party has both roles.

## Journals and correction ownership

The source module owns its document workflow, draft proposal, view route, and correction experience. The ledger kernel exclusively creates and owns posted journal rows. Every journal records owner module, immutable namespaced journal type key/version, source document/version/event, origin channel, purpose, idempotency key, actor, and approval/content hash.

Posted journal headers and lines cannot be updated or deleted by the runtime role. A posted document “void” creates a linked full reversal in an allowed period. Replacement creates another linked journal. True hard deletion is excluded from the application, API, and MCP; any exceptional legal-erasure case follows the offline [break-glass deletion policy](../operations/hard-delete.md).

## Periods and posting

Period states are:

- `OPEN`: ordinary authorized posting.
- `ADJUSTMENT_ONLY`: allowlisted adjustment purposes and elevated posting permission only.
- `HARD_CLOSED`: no ordinary posting; correction goes to an allowed open period.
- `SEALED`: final state; reopening is unavailable to the application.

Posting and closing lock the same period row. One atomic posting service validates entity/ledger ownership, period, account policy, dimensions, tax/subledger extensions, exact debit/credit balance, idempotency, approval hash, audit event, and outbox event. Journal sequence numbers are allocated only if the transaction succeeds.

## Tax

The tax module is a stable decision contract plus separately versioned jurisdiction packs—not one universal law engine. The first packs are Ontario HST and Washington retail sales/use tax. Posted results snapshot facts, registration, evidence, jurisdiction/location, pack/rule version, rate components, rounding, and GL mappings.

Unknown, stale, or unsupported facts return `MANUAL_REVIEW_REQUIRED`, never a silent zero. Zero-rated, exempt, resale, marketplace-collected, and out-of-scope outcomes remain distinct. An entity activates a pack with an explicit encrypted registration reference, validity range, jurisdiction/location facts, and evidence; country or state alone never implies registration, nexus, or a Washington local rate. Washington v0 uses reviewed effective-dated DOR location data and does not claim automatic national address determination. B&O, lodging, vehicles, tribal rules, construction, and special taxes are outside the demo scope.

## Encryption and recovery

Each organization owns a random, versioned 256-bit DEK. A `KeyProvider` wraps it with a root key kept outside the database, repository, and ordinary environment files. Encryption uses authenticated AAD containing organization, table, column, record identity, and key version.

Party names/addresses, tax IDs, bank details, attachments, and connector credentials are selectively encrypted. Exact monetary values and reporting keys remain queryable inside database/disk/backup encryption. Password reset does not change the DEK. Email recovery uses a hashed, short-lived, single-use token, existing recovery factor or co-owner approval, session revocation, notification, and sole-owner delay controls.

## Roles, automation, and MCP

Role templates are Owner, Accountant/Approver, Bookkeeper/Maker, Viewer/Auditor, and Integration/MCP. Permissions separately cover draft, submit, approve, post, reverse, close, reopen, policy, members, and recovery.

Issuing an invoice or confirming a bill may synchronously post its deterministic journal when the actor has posting authority. General auto-post policy is off in v0. Bank feeds, imports, rules, and AI create observations, suggestions, or drafts only.

Hosted MCP uses an organization-bound OAuth service principal and the same application services/RLS transaction context as the UI. v0 tools are read-only plus explicitly scoped draft creation. MCP cannot self-approve, post, hard-delete, reopen periods, recover keys, elevate roles, or alter payment/security policy.

## Deployment boundary

`business.finlynq.com` may share the existing VPS hardware but not its trust namespace. It receives a separate OS service account, deploy directory, PostgreSQL database and least-privilege roles, encryption root, JWT/cookie name, OAuth credentials, port, storage path, resource limits, audit stream, and encrypted off-VPS backups. A later Finlynq integration will use explicit OIDC/account linking, not shared cookies, secrets, or databases.

## Banking boundary

SimpleFIN credentials and bank descriptions use the organization envelope key. Provider transactions are immutable, versioned observations, not journals. Reconciliation matches observations to posted cash lines through append-only allocations and a guarded preparer/reviewer lifecycle. Categorization rules are versioned append-only and currently create encrypted manual-review suggestions only; they cannot create source-module drafts, approve, post, mutate source books, or delete history.

## Deferred modules

Inventory, manufacturing, projects, insurance, payroll, fixed assets, consolidation, budgeting, secondary ledgers, payment execution, and public MCP are outside this slice. Module keys, source envelopes, and the ledger extension contract make them additive; no placeholder inventory tables are created.
