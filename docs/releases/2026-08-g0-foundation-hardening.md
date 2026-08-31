# G0 foundation hardening release note

Status: pre-release verification on `codex/g0-foundation-hardening`.

## Impact

This release establishes the migration and request-security baseline required by G0-01 and G0-02. It does not add a customer-facing module. It makes column, default, foreign-key, check, uniqueness (including `NULLS NOT DISTINCT`), exclusion-constraint, index, and RLS-policy drift detectable; reconciles the application database role to an exact least-privilege contract; closes tenant write-boundary gaps; and gives mutation routes one bounded, redacted failure contract.

## Feature flags

No new product feature flag is introduced. Existing real-account write activation remains unchanged; per-organization activation belongs to G0-03.

## Migrations

- `0025_tenant_rls_completion.sql` completes and asserts RLS, FORCE RLS, and policies for the organization data model.
- `0026_snapshot_baseline.sql` establishes the repaired Drizzle snapshot baseline without changing runtime data.
- `0027_session_user_agent_binding.sql` requires new sessions to carry a user-agent binding and prevents an existing binding from being removed. Legacy unbound sessions remain compatible until they expire or are revoked.
- `0028_bank_match_allocation_idempotency.sql` binds manual allocation retries to a reconciliation-scoped key and canonical v2 command fingerprint, accepts the precise pre-canonicalization v1 retry fingerprint, and rejects changed payloads without blocking independent split allocations.
- `0029_restore_safe_currency_lookup.sql` removes the unsafe cross-table signup CHECK, pins the currency minor-unit lookup to trusted schemas, and replaces the existence rule with a validated signup-to-currency foreign key so populated archives restore safely in one transaction regardless of COPY order.

The release must pass both a clean migration replay and an upgrade from the predecessor migration before promotion.

## Operational action

- Run the PostgreSQL runtime-role reconciliation script after migrations and verify the resulting schema contract, RLS policies, and direct, effective, PUBLIC, function, sequence, schema, default, and column privileges.
- Set `TRUSTED_PROXY_HOPS=1` for the current single-Caddy production topology. A missing or invalid value fails closed and ignores forwarded client addresses.
- Run the database lifecycle, backup/restore, browser, and production build gates for the exact commit before promotion.
- Retain the CI evidence URL and restored-backup verification result with the release record.

## Known limitations

- This branch is not eligible for production until its local quality gate and live PostgreSQL/browser CI jobs are green.
- G0-03 per-organization real-account activation, G0-04 key rotation, and the remaining product packages are intentionally outside this release.
- The two `public.digest` overloads required by invoker-security database code are the only intended public-schema functions executable by the runtime role.

## Rollback

Roll back the application and configuration artifact to the preceding verified commit if request behavior regresses. Do not run destructive down-migrations: the RLS and session-binding changes are security controls. Repair database defects forward, reconcile the runtime role again, and verify restore evidence before re-enabling writes. During investigation, disable new commands while retaining read-only accounting and audit evidence.
