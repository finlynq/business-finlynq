# Product delivery status

Last reviewed: 2026-08-31.

This tracker records implementation state for the [product work order](product-implementation-work-order-2026-08.md). Existing demo or hosted capabilities are useful evidence, but they do not make a work package Done unless that package's complete acceptance and operational evidence exists.

| Package | Status | Current evidence and remaining gate |
|---|---|---|
| G0-01 — schema and migration truth | Done | The implementation adds a complete 71-table Drizzle snapshot baseline, non-mutating declaration-drift detection, exact snapshot-plus-migration verification of columns/defaults/foreign keys/checks/uniques (including `NULLS NOT DISTINCT`)/exclusion constraints/indexes, exact RLS policy semantics, and exact direct/effective/PUBLIC runtime-grant verification. Commit `bcdab17` passed clean replay, predecessor upgrade, populated backup-role dump/transactional restore, all role reconciliations, schema/grant verification, production build, hardened-image build, browser release gate, and dependency audit in [quality-gate run 33386617605](https://github.com/finlynq/business-finlynq/actions/runs/33386617605). |
| G0-02 — tenant mutations and request boundaries | Done | The implementation covers the journal and organization-administration writable boundaries, rollback error preservation, explicit proxy trust, bounded/redacted mutation routes, canonical/versioned fingerprints with legacy replay compatibility, minimal public health output, nonce-based CSP, deterministic journal-type registry checks, demo-reset failure tests, pinned container images, and batched AR/AP write paths. The complete local suite passed 105 files/526 tests, and the live PostgreSQL, full database-backed test, browser, build, image, and audit gates passed for commit `bcdab17` in [quality-gate run 33386617605](https://github.com/finlynq/business-finlynq/actions/runs/33386617605). |
| G0-03 — real-account activation | In progress | Migrations `0030`–`0031` add default-disabled per-organization write state, a versioned session resolver, an owner-only audited enable/disable function, shared/exclusive disable fencing, and graph-leaf enforcement for the immutable audit chain. The strict `org:writes` operator command, runtime fail-closed gate, activation/emergency/support runbook, tenant-backed read-after-disable behavior, and focused isolation/concurrency tests are implemented. Local lint, typecheck, build, drift checks, and 109 files/547 non-database tests pass. Live PostgreSQL replay/grant/concurrency validation, the production-like identity and backup/restore journey, Resend/operator evidence, browser automation, and two-person sign-off remain required before Done. |
| G0-04 — organization-key rotation | Proposed | Initial organization DEKs, encryption, restore verification, and recovery are implemented. Resumable record re-encryption, blind-index rebuild, dual-version reads, verified cutover, retirement, abort/retry, and rotation/restore drills are not implemented. |
| G0-05 — operations and incidents | In progress | Monitoring, encrypted off-server backup, restore, rollback, scheduler, role reconciliation, and release runbooks exist. Retained live restore/alert/release evidence, centralized operational metrics, incident exercises, and commit-addressed release artifacts remain incomplete. |
| G0-06 — production pilot review | Blocked | Depends on G0-01 through G0-05. No signed named-pilot evidence bundle exists yet. |
| R1 — complete bookkeeping core | Proposed | Several GL, AR/AP, reporting, settings, and workspace slices are already present, but the work order's shared screen/list/import/report/document and pilot acceptance packages have not passed as a gate. |
| R2 — bank-to-close | Proposed | An initial hardened SimpleFIN observation/reconciliation slice exists. It is not the complete import, matching, sign-off, tax-return, close, and pilot gate described by R2. |
| R3 — customer and supplier service | Proposed | Not started as a release gate. |
| R4 — controlled extensibility | Proposed | Informational MCP seams exist; no public API/MCP/OAuth/webhook surface is active. |
| R5 — modular expansion | Proposed | Inventory and every other advanced module remain selection-gated. |

## Current implementation batch

The completed first work-order batch was intentionally limited to the earliest blockers and independent high-risk request-boundary fixes:

1. preserve the work order, engineering handoff, and competitive analysis in the active repository;
2. repair migration snapshot truth and introduce repeatable drift/database/grant gates;
3. complete the existing tenant RLS/FORCE posture;
4. prevent journal posting from bypassing the organization write boundary;
5. preserve domain errors when transaction rollback itself fails;
6. replace implicit forwarding-header trust with an explicit proxy-hop contract;
7. consolidate audited mutations behind bounded, authorized, redacted route factories;
8. canonicalize command fingerprints while retaining a controlled legacy lookup window;
9. reduce public health detail, enforce a request-nonce CSP, and centralize failure logging;
10. make journal-type metadata one generated, drift-checked source of truth;
11. harden the runtime database role against inherited, PUBLIC, default, function, and column privileges;
12. bind newly issued sessions to a deterministic user-agent hash without breaking legacy sessions; and
13. remove high-volume AR/AP query and insert loops while preserving the compatibility service boundary.

The next dependency-ordered package is G0-03. Later G0 and product packages remain ordered by section 19 of the work order. Do not start R1 feature completion while a G0 P0 blocker remains unresolved.
