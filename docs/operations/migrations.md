# Database migration and schema-truth runbook

Business Finlynq treats the reviewed SQL journal under `migrations/drizzle/` as the deployment source of truth. Drizzle declarations under `src/db/schema/` are the typed application contract, and the latest generated snapshot is the machine-readable bridge between them. All three must move together.

Never use `drizzle-kit push` against a Business Finlynq database. Never edit a generated snapshot or its identity chain by hand. Production changes are forward-only SQL migrations; posted accounting history is corrected through application events, not data-rewriting migrations.

## Choose the migration flow

For a table, column, index, enum, or foreign-key change represented in the Drizzle declarations:

1. Change the declaration first.
2. Run `npm run db:generate -- --name <descriptive_name>`.
3. Review the generated SQL, snapshot, and journal entry as one change.
4. If PostgreSQL needs a safer expand/backfill/switch implementation, replace only the generated SQL with the reviewed forward migration. Preserve the generated snapshot and journal entry because they describe the intended final declaration state.

For functions, triggers, grants, RLS/FORCE policy, data backfills, or other reviewed SQL that does not change a declaration:

1. Run `npm run db:generate:custom -- --name <descriptive_name>`.
2. Put the reviewed SQL in the generated migration file.
3. Keep the generated metadata entry; a custom migration intentionally carries the preceding declaration snapshot forward.

Do not combine unrelated schema and data changes. Prefer expand → backfill → verify → switch reads/writes → contract in a later release. Backfills must be resumable, idempotent, observable, and reconciled with row counts and exact-decimal control totals.

Journal types are an additional generated data contract. The enabled module manifests under `src/modules/*/manifest.ts` are their TypeScript source of truth. Every definition has a permanent UUID plus an immutable namespaced key/version. After adding a supported journal type, run:

```bash
npm run journal-types:generate-seed
```

Review `migrations/generated/journal-type-definitions.sql`, copy its idempotent statement into the new forward migration, and commit the updated artifact with that migration. Do not register a planned type until its owning module has an end-to-end posting or draft workflow. `journal-types:check-seed` catches a stale generated artifact, while `journal-types:verify-db` compares every seeded database row and field with the compiled registry. Runtime readiness performs the same database comparison and fails closed on drift.

## Required verification

Before review:

```bash
npm run db:check-drift
npm run journal-types:check-seed
npm run check
npm run build
```

`db:check-drift` copies the current metadata into a disposable project-local directory, runs Drizzle generation there, and fails with a generated-SQL preview if declarations differ from the latest snapshot. It never writes a candidate migration into the real journal.

With the disposable PostgreSQL test URLs configured, replay the complete journal, reconcile the application, authentication-worker, and backup roles, then run the database schema verifier and integration suites. The verifier compares every public base table, column, PostgreSQL type, nullability rule, normalized column default, foreign key, check constraint, named unique constraint, exclusion constraint, and index with the latest snapshot. Migrations `0004` through `0025` predate the generated declaration baseline, so their declarative `CREATE TABLE`/`ALTER TABLE` CHECK, UNIQUE (including `NULLS NOT DISTINCT`), EXCLUDE, and named FOREIGN KEY clauses plus explicit `CREATE INDEX` statements are parsed in journal order as a narrow migration-owned contract; matching `DROP INDEX` and `DROP COLUMN` statements remove legacy expectations. Exclusion constraints are compared separately from ordinary indexes, so their constraint-backed GiST indexes do not create false extra-index diagnostics. This is not an ignore list: every captured object is compared with PostgreSQL and a missing, extra, or changed definition or predicate fails verification. The normalizer accounts for PostgreSQL's documented parse/deparse equivalents (`IN` as `ANY (ARRAY[...])` and `BETWEEN` as paired inequalities) while retaining literal values, bounds, operators, and logical grouping. When adding a hand-authored constraint or index to a forward migration, extend the parser only if the statement form is not already supported and add a deparse fixture.

The verifier also requires both RLS and FORCE RLS on `organizations` and every organization-qualified table. Runtime grants are checked twice: the direct application-role ACL must exactly match the reviewed relation matrix, and effective access must contain no additional path through `PUBLIC`, column ACLs, grant options, or role memberships. The runtime reconciler removes current and default `PUBLIC` table, sequence, function, schema, and column privileges before reapplying the allowlist. It revokes both global owner defaults and per-schema defaults: PostgreSQL's per-schema default-privilege entries are additive and cannot subtract the built-in global `PUBLIC EXECUTE` default for new functions. CI creates transactional future table, sequence, and function probes after reconciliation and proves that neither `PUBLIC` nor the runtime role receives implicit access.

Every RLS-protected table must also define an explicit policy. Normal tenant data uses a tenant-qualified policy tied to `app.current_organization_id()`. Identity and demo control-plane tables that are intentionally unavailable through direct runtime grants use an owner-only policy instead: the policy dynamically compares `current_user` with the relation's current owner so reviewed `SECURITY DEFINER` functions continue to work under `FORCE ROW LEVEL SECURITY` without hard-coding a deployment role. Do not substitute an owner-only policy for a tenant policy on an application-facing table.

Every migration release must demonstrate:

- clean replay into an empty PostgreSQL database;
- upgrade from the supported predecessor with sentinel rows preserved;
- runtime, worker, and backup grant reconciliation;
- exact snapshot-versus-`information_schema` agreement;
- RLS/FORCE coverage for every tenant table;
- encrypted backup creation and restore into the isolated restore-drill namespace; and
- forward-migration and runtime verification after restore.

CI supplies disposable PostgreSQL roles and URLs and runs the clean replay, grant reconciliation, schema contract, database suites, build, and browser gate. It also runs `scripts/operations/verify-ci-database-lifecycle.sh predecessor-upgrade`: the guarded helper creates only the fixed loopback sibling database `business_finlynq_test_predecessor_upgrade`, stages and replays migrations 0000 through 0024, writes a tenant sentinel, upgrades through 0029, reconciles all three roles, verifies the sentinel, and runs the current schema/grant verifier. The helper requires `CI=true`, `GITHUB_ACTIONS=true`, the exact `BUSINESS_FINLYNQ_CI_DATABASE_GUARD` confirmation phrase, the fixed `business_finlynq_test` source, and explicit loopback owner settings. It also refuses a PostgreSQL cluster containing any non-CI database. Its exit trap force-drops only the two recognized CI sibling names and removes only its runner-temporary directory.

The runtime verifier synthesizes built-in global default ACLs for the current database owner and for roles that own existing application relations or functions. It intentionally does not infer future object creation from schema ownership alone: on PostgreSQL 15 and later the `public` schema is normally owned by the special `pg_database_owner` role. Explicit schema-scoped default ACL rows are still inspected for every owner, so a stale PUBLIC or runtime-role grant remains release-blocking.

A release operator still follows the backup/restore and deployment runbooks for production evidence. The CI sibling checks are deliberately unable to address any non-loopback database and are not production migration commands.

## Snapshot rebaseline history

Migrations `0004` through `0025` were hand-authored while the generated snapshot chain remained at `0003`. Migration `0026_snapshot_baseline` is the one-time no-op journal entry paired with a generated snapshot of the complete 71-table declaration state. Its SQL must remain a no-op because the historical migrations already create those objects. Future schema changes use one of the two flows above; another manual rebaseline is not permitted.
