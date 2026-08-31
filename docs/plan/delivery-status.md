# Product delivery status

Last reviewed: 2026-08-31.

This tracker records implementation state for the [product work order](product-implementation-work-order-2026-08.md). Existing demo or hosted capabilities are useful evidence, but they do not make a work package Done unless that package's complete acceptance and operational evidence exists.

| Package | Status | Current evidence and remaining gate |
|---|---|---|
| G0-01 — schema and migration truth | In verification | The implementation adds a complete 71-table Drizzle snapshot baseline, non-mutating declaration-drift detection, exact snapshot-plus-migration verification of columns/defaults/foreign keys/checks/uniques (including `NULLS NOT DISTINCT`)/exclusion constraints/indexes, exact RLS policy semantics, and exact direct/effective/PUBLIC runtime-grant verification. Local generation, deliberate-drift, lint, type, unit, production-build, and independent clean PostgreSQL 16 replay/runtime-verifier gates pass. It becomes Done only after predecessor upgrade, full live database suites, restore, and the complete CI gate pass for the pushed commit. |
| G0-02 — tenant mutations and request boundaries | In verification | The reviewed implementation now covers the journal and organization-administration writable boundaries, rollback error preservation, explicit proxy trust, bounded/redacted mutation routes, canonical/versioned fingerprints with legacy replay compatibility, minimal public health output, nonce-based CSP, deterministic journal-type registry checks, demo-reset failure tests, pinned container images, and batched AR/AP write paths. The local lint, type, unit, drift, generated-seed, and production-build gates pass; live database and browser evidence must pass in CI before this package is Done. |
| G0-03 — real-account activation | Ready after G0-02 | Identity, signup, email delivery, recovery, roles, and session administration are hosted. Real writes still rely on one global switch; per-organization activation state, operator command, evidence, audit, emergency disable, and production-like identity acceptance remain required. |
| G0-04 — organization-key rotation | Proposed | Initial organization DEKs, encryption, restore verification, and recovery are implemented. Resumable record re-encryption, blind-index rebuild, dual-version reads, verified cutover, retirement, abort/retry, and rotation/restore drills are not implemented. |
| G0-05 — operations and incidents | In progress | Monitoring, encrypted off-server backup, restore, rollback, scheduler, role reconciliation, and release runbooks exist. Retained live restore/alert/release evidence, centralized operational metrics, incident exercises, and commit-addressed release artifacts remain incomplete. |
| G0-06 — production pilot review | Blocked | Depends on G0-01 through G0-05. No signed named-pilot evidence bundle exists yet. |
| R1 — complete bookkeeping core | Proposed | Several GL, AR/AP, reporting, settings, and workspace slices are already present, but the work order's shared screen/list/import/report/document and pilot acceptance packages have not passed as a gate. |
| R2 — bank-to-close | Proposed | An initial hardened SimpleFIN observation/reconciliation slice exists. It is not the complete import, matching, sign-off, tax-return, close, and pilot gate described by R2. |
| R3 — customer and supplier service | Proposed | Not started as a release gate. |
| R4 — controlled extensibility | Proposed | Informational MCP seams exist; no public API/MCP/OAuth/webhook surface is active. |
| R5 — modular expansion | Proposed | Inventory and every other advanced module remain selection-gated. |

## Current implementation batch

The first work-order batch remains intentionally limited to the earliest blockers and independent high-risk request-boundary fixes:

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

Later G0 and product packages remain ordered by section 19 of the work order. Do not start R1 feature completion while a G0 P0 blocker remains unresolved.
