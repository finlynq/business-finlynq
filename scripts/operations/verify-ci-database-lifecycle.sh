#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly expected_guard="business-finlynq-disposable-ci-databases"
readonly expected_source_database="business_finlynq_test"
readonly predecessor_database="business_finlynq_test_predecessor_upgrade"
readonly restore_database="business_finlynq_test_restore_verify"
readonly demo_organization_id="10000000-0000-4000-8000-000000000001"
readonly predecessor_sentinel_id="00000000-0000-4000-8000-0000000000fe"
readonly predecessor_audit_root_hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
readonly predecessor_audit_leaf_hash="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
readonly restore_correlation_aggregate_id="00000000-0000-4000-8000-0000000000c0"
readonly restore_correlation_request_a="00000000-0000-4000-8000-0000000000c1"
readonly restore_correlation_request_b="00000000-0000-4000-8000-0000000000c2"

fail() {
  printf 'CI database lifecycle verification failed: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail "choose exactly one mode: predecessor-upgrade or restore"
readonly verification_mode="$1"
case "$verification_mode" in
  predecessor-upgrade) readonly target_database="$predecessor_database" ;;
  restore) readonly target_database="$restore_database" ;;
  *) fail "unknown mode '$verification_mode'; choose predecessor-upgrade or restore" ;;
esac

for command_name in awk createdb dropdb grep node pg_dump pg_restore psql; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

: "${BUSINESS_FINLYNQ_CI_DATABASE_GUARD:?BUSINESS_FINLYNQ_CI_DATABASE_GUARD is required}"
: "${CI:?CI is required}"
: "${GITHUB_ACTIONS:?GITHUB_ACTIONS is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${PGPASSWORD:?owner PGPASSWORD is required}"
: "${DATABASE_MIGRATION_URL:?DATABASE_MIGRATION_URL is required}"
: "${APP_DATABASE_PASSWORD_FILE:?APP_DATABASE_PASSWORD_FILE is required}"
: "${AUTH_WORKER_DATABASE_PASSWORD_FILE:?AUTH_WORKER_DATABASE_PASSWORD_FILE is required}"
: "${BACKUP_DATABASE_PASSWORD_FILE:?BACKUP_DATABASE_PASSWORD_FILE is required}"

[[ "$BUSINESS_FINLYNQ_CI_DATABASE_GUARD" == "$expected_guard" ]] ||
  fail "the disposable-database confirmation phrase is missing"
[[ "$CI" == "true" ]] || fail "CI must be exactly true"
[[ "$GITHUB_ACTIONS" == "true" ]] || fail "GITHUB_ACTIONS must be exactly true"
[[ "$PGHOST" == "127.0.0.1" ]] || fail "PGHOST must be the loopback CI PostgreSQL service"
[[ "$PGPORT" == "5432" ]] || fail "PGPORT must be the fixed CI PostgreSQL port"
[[ "$POSTGRES_USER" == "postgres" ]] || fail "POSTGRES_USER must be the disposable cluster owner"
[[ "$POSTGRES_DB" == "$expected_source_database" ]] ||
  fail "POSTGRES_DB must be the fixed disposable source database"
[[ "$target_database" =~ ^business_finlynq_test_(predecessor_upgrade|restore_verify)$ ]] ||
  fail "target database escaped the fixed disposable namespace"
[[ "$target_database" != "$POSTGRES_DB" ]] || fail "target database cannot be the source database"

for secret_file in \
  "$APP_DATABASE_PASSWORD_FILE" \
  "$AUTH_WORKER_DATABASE_PASSWORD_FILE" \
  "$BACKUP_DATABASE_PASSWORD_FILE"; do
  [[ -r "$secret_file" ]] || fail "required CI role-password file is not readable: $secret_file"
done

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository_root="$(cd -- "$script_directory/../.." && pwd -P)"
readonly runner_temp="$(cd -- "$RUNNER_TEMP" && pwd -P)"
[[ "$runner_temp" != "/" ]] || fail "RUNNER_TEMP cannot be the filesystem root"

node <<'NODE'
const url = new URL(process.env.DATABASE_MIGRATION_URL);
const expected = {
  database: process.env.POSTGRES_DB,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  user: process.env.POSTGRES_USER,
};
const actual = {
  database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  host: url.hostname,
  port: url.port || "5432",
  user: decodeURIComponent(url.username),
};
for (const key of Object.keys(expected)) {
  if (actual[key] !== expected[key]) {
    throw new Error(`DATABASE_MIGRATION_URL ${key} does not match the guarded CI connection`);
  }
}
if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
  throw new Error("DATABASE_MIGRATION_URL must use PostgreSQL");
}
NODE

unexpected_databases="$(PGPASSWORD="$PGPASSWORD" psql \
  --host "$PGHOST" \
  --port "$PGPORT" \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  --no-password \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --tuples-only \
  --no-align \
  --command "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1', '$expected_source_database', '$predecessor_database', '$restore_database');")"
[[ -z "$unexpected_databases" ]] ||
  fail "PostgreSQL cluster contains non-CI databases and is not disposable: $unexpected_databases"

temporary_root="$(mktemp -d "$runner_temp/business-finlynq-${verification_mode}.XXXXXX")"
readonly temporary_root
readonly migration_config="$temporary_root/drizzle.config.ts"

cat > "$migration_config" <<'CONFIG'
const migrationFolder = process.env.BUSINESS_FINLYNQ_CI_MIGRATION_FOLDER;
const targetDatabase = process.env.BUSINESS_FINLYNQ_CI_TARGET_DATABASE;
if (!migrationFolder || !targetDatabase) {
  throw new Error("CI migration folder and target database are required");
}
const connection = new URL(process.env.DATABASE_MIGRATION_URL);
connection.pathname = `/${targetDatabase}`;
export default {
  dialect: "postgresql",
  out: migrationFolder,
  dbCredentials: { url: connection.toString() },
  strict: true,
  verbose: true,
};
CONFIG

drop_ci_database() {
  local selected_database="$1"
  case "$selected_database" in
    "$predecessor_database"|"$restore_database") ;;
    *) fail "refusing to drop an unrecognized database: $selected_database" ;;
  esac
  PGPASSWORD="$PGPASSWORD" dropdb \
    --host "$PGHOST" \
    --port "$PGPORT" \
    --username "$POSTGRES_USER" \
    --maintenance-db postgres \
    --no-password \
    --if-exists \
    --force \
    "$selected_database"
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e

  drop_ci_database "$target_database" >/dev/null 2>&1 || {
    printf 'CI database lifecycle cleanup could not drop %s\n' "$target_database" >&2
    cleanup_status=1
  }
  case "$temporary_root" in
    "$runner_temp"/business-finlynq-*) rm -rf -- "$temporary_root" || cleanup_status=1 ;;
    *)
      printf 'CI database lifecycle cleanup refused unsafe temporary path: %s\n' "$temporary_root" >&2
      cleanup_status=1
      ;;
  esac

  if [[ $original_status -eq 0 && $cleanup_status -ne 0 ]]; then
    original_status=$cleanup_status
  fi
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

database_url_for() {
  BUSINESS_FINLYNQ_CI_TARGET_DATABASE="$1" node <<'NODE'
const connection = new URL(process.env.DATABASE_MIGRATION_URL);
connection.pathname = `/${process.env.BUSINESS_FINLYNQ_CI_TARGET_DATABASE}`;
process.stdout.write(connection.toString());
NODE
}

psql_value() {
  local selected_database="$1"
  local query="$2"
  PGPASSWORD="$PGPASSWORD" psql \
    --host "$PGHOST" \
    --port "$PGPORT" \
    --username "$POSTGRES_USER" \
    --dbname "$selected_database" \
    --no-password \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --command "$query"
}

run_migrations() {
  local selected_database="$1"
  local migration_folder="$2"
  BUSINESS_FINLYNQ_CI_TARGET_DATABASE="$selected_database" \
  BUSINESS_FINLYNQ_CI_MIGRATION_FOLDER="$migration_folder" \
    node "$repository_root/node_modules/drizzle-kit/bin.cjs" migrate --config "$migration_config"
}

reconcile_roles() {
  local selected_database="$1"
  PGHOST="$PGHOST" PGPORT="$PGPORT" PGPASSWORD="$PGPASSWORD" \
    POSTGRES_USER="$POSTGRES_USER" POSTGRES_DB="$selected_database" \
    APP_DATABASE_PASSWORD_FILE="$APP_DATABASE_PASSWORD_FILE" \
    sh "$repository_root/deploy/postgres/010-runtime-role.sh"
  PGHOST="$PGHOST" PGPORT="$PGPORT" PGPASSWORD="$PGPASSWORD" \
    POSTGRES_USER="$POSTGRES_USER" POSTGRES_DB="$selected_database" \
    AUTH_WORKER_DATABASE_PASSWORD_FILE="$AUTH_WORKER_DATABASE_PASSWORD_FILE" \
    sh "$repository_root/deploy/postgres/015-auth-worker-role.sh"
  PGHOST="$PGHOST" PGPORT="$PGPORT" PGPASSWORD="$PGPASSWORD" \
    POSTGRES_USER="$POSTGRES_USER" POSTGRES_DB="$selected_database" \
    BACKUP_DATABASE_PASSWORD_FILE="$BACKUP_DATABASE_PASSWORD_FILE" \
    sh "$repository_root/deploy/postgres/020-backup-role.sh"
}

verify_schema_and_grants() {
  local selected_database="$1"
  local selected_url
  selected_url="$(database_url_for "$selected_database")"
  TEST_DATABASE_URL="$selected_url" DATABASE_MIGRATION_URL="$selected_url" \
    node "$repository_root/scripts/operations/verify-database-schema.mjs"
  DATABASE_MIGRATION_URL="$selected_url" \
    "$repository_root/node_modules/.bin/tsx" \
    "$repository_root/scripts/operations/verify-journal-type-registry.ts"
}

verify_fail_closed_default_privileges() {
  local selected_database="$1"
  PGPASSWORD="$PGPASSWORD" psql \
    --host "$PGHOST" \
    --port "$PGPORT" \
    --username "$POSTGRES_USER" \
    --dbname "$selected_database" \
    --no-password \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 <<'SQL'
BEGIN;
CREATE TABLE public.business_finlynq_acl_probe (id bigint PRIMARY KEY);
CREATE SEQUENCE public.business_finlynq_acl_probe_sequence;
CREATE FUNCTION public.business_finlynq_acl_probe_function()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS 'SELECT 1';

DO $default_acl_probe$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
      ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
    ) privilege(name)
    WHERE pg_catalog.has_table_privilege(
      'business_finlynq_app',
      'public.business_finlynq_acl_probe',
      privilege.name
    )
  ) THEN
    RAISE EXCEPTION 'runtime role received an implicit privilege on a future table';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) privilege(name)
    WHERE pg_catalog.has_sequence_privilege(
      'business_finlynq_app',
      'public.business_finlynq_acl_probe_sequence',
      privilege.name
    )
  ) THEN
    RAISE EXCEPTION 'runtime role received an implicit privilege on a future sequence';
  END IF;
  IF pg_catalog.has_function_privilege(
    'business_finlynq_app',
    'public.business_finlynq_acl_probe_function()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'runtime role received implicit EXECUTE on a future function';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault(
          CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
          relation.relowner
        )
      )
    ) privilege
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'business_finlynq_acl_probe',
        'business_finlynq_acl_probe_sequence'
      )
      AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC received an implicit privilege on a future relation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc selected_function
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = selected_function.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        selected_function.proacl,
        pg_catalog.acldefault('f'::"char", selected_function.proowner)
      )
    ) privilege
    WHERE namespace.nspname = 'public'
      AND selected_function.proname = 'business_finlynq_acl_probe_function'
      AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC received implicit EXECUTE on a future function';
  END IF;
END
$default_acl_probe$;
ROLLBACK;
SQL
}

stage_predecessor_migrations() {
  local predecessor_root="$temporary_root/predecessor-migrations"
  local predecessor_meta="$predecessor_root/meta"
  local migration_count=0
  mkdir -p -- "$predecessor_meta"
  for migration_path in "$repository_root"/migrations/drizzle/*.sql; do
    local migration_name
    local migration_prefix
    migration_name="$(basename -- "$migration_path")"
    [[ "$migration_name" =~ ^([0-9]{4})_.*\.sql$ ]] ||
      fail "migration file has no four-digit prefix: $migration_name"
    migration_prefix=$((10#${BASH_REMATCH[1]}))
    if (( migration_prefix <= 24 )); then
      cp -- "$migration_path" "$predecessor_root/$migration_name"
      migration_count=$((migration_count + 1))
    fi
  done
  [[ $migration_count -eq 25 ]] ||
    fail "expected 25 predecessor SQL migrations (0000-0024), found $migration_count"
  cp -- "$repository_root/migrations/drizzle/meta/_journal.json" "$predecessor_meta/_journal.json"
  BUSINESS_FINLYNQ_PREDECESSOR_JOURNAL="$predecessor_meta/_journal.json" node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const journalPath = process.env.BUSINESS_FINLYNQ_PREDECESSOR_JOURNAL;
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
journal.entries = journal.entries.filter((entry) => entry.idx <= 24);
if (journal.entries.length !== 25 || journal.entries.at(-1)?.idx !== 24) {
  throw new Error("predecessor journal must contain exactly migrations 0000 through 0024");
}
writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
NODE
  printf '%s' "$predecessor_root"
}

read_single_line_secret() {
  local secret_path="$1"
  local label="$2"
  local line_count
  local secret_value=""
  line_count="$(awk 'END { print NR }' "$secret_path")"
  [[ "$line_count" -eq 1 ]] || fail "$label must contain exactly one line"
  IFS= read -r secret_value < "$secret_path" || [[ -n "$secret_value" ]]
  [[ -n "$secret_value" && "$secret_value" != *$'\r'* && "$secret_value" != *$'\n'* ]] ||
    fail "$label must contain one non-empty line"
  printf '%s' "$secret_value"
}

drop_ci_database "$target_database"
PGPASSWORD="$PGPASSWORD" createdb \
  --host "$PGHOST" \
  --port "$PGPORT" \
  --username "$POSTGRES_USER" \
  --maintenance-db postgres \
  --no-password \
  --template template0 \
  --encoding UTF8 \
  "$target_database"
initial_relation_count="$(psql_value "$target_database" \
  "SELECT count(*) FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE relation.relkind IN ('r', 'p') AND namespace.nspname NOT IN ('pg_catalog', 'information_schema');")"
[[ "$initial_relation_count" == "0" ]] ||
  fail "newly created sibling database is not empty"

if [[ "$verification_mode" == "predecessor-upgrade" ]]; then
  predecessor_root="$(stage_predecessor_migrations)"
  readonly predecessor_root
  run_migrations "$predecessor_database" "$predecessor_root"

  predecessor_count="$(psql_value "$predecessor_database" \
    "SELECT count(*) FROM drizzle.__drizzle_migrations;")"
  [[ "$predecessor_count" == "25" ]] ||
    fail "predecessor replay recorded $predecessor_count migrations instead of 25"

  PGPASSWORD="$PGPASSWORD" psql \
    --host "$PGHOST" \
    --port "$PGPORT" \
    --username "$POSTGRES_USER" \
    --dbname "$predecessor_database" \
    --no-password \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 <<SQL
INSERT INTO organizations (
  id, slug, display_name, active, is_demo, organization_mode
) VALUES (
  '$predecessor_sentinel_id',
  'ci-predecessor-sentinel',
  'CI predecessor tenant sentinel',
  true,
  false,
  'REAL'
);

-- The graph is valid, but timestamp order disagrees with graph order. Migration
-- 0030 must preserve it and derive the next predecessor from the leaf hash,
-- never from the row with the maximum historical timestamp.
INSERT INTO audit_events (
  organization_id, actor_type, actor_id, auth_method, source_surface,
  action, entity_type, entity_id, request_id, safe_metadata,
  previous_event_hash, event_hash, occurred_at
) VALUES (
  '$predecessor_sentinel_id', 'SYSTEM', 'ci-predecessor', 'migration', 'WORKER',
  'ci.predecessor-audit-root', 'organization', '$predecessor_sentinel_id',
  '00000000-0000-4000-8000-0000000000a1', '{}', NULL,
  '$predecessor_audit_root_hash', '2040-01-01T00:00:00Z'
), (
  '$predecessor_sentinel_id', 'SYSTEM', 'ci-predecessor', 'migration', 'WORKER',
  'ci.predecessor-audit-leaf', 'organization', '$predecessor_sentinel_id',
  '00000000-0000-4000-8000-0000000000a2', '{}',
  '$predecessor_audit_root_hash', '$predecessor_audit_leaf_hash',
  '2030-01-01T00:00:00Z'
);
SQL

  run_migrations "$predecessor_database" "$repository_root/migrations/drizzle"
  upgraded_count="$(psql_value "$predecessor_database" \
    "SELECT count(*) FROM drizzle.__drizzle_migrations;")"
  [[ "$upgraded_count" == "32" ]] ||
    fail "predecessor upgrade recorded $upgraded_count migrations instead of 32"
  preserved_sentinel="$(psql_value "$predecessor_database" \
    "SELECT slug || '|' || display_name FROM organizations WHERE id = '$predecessor_sentinel_id';")"
  [[ "$preserved_sentinel" == "ci-predecessor-sentinel|CI predecessor tenant sentinel" ]] ||
    fail "tenant sentinel was not preserved through migrations 0025 through 0031"

  PGPASSWORD="$PGPASSWORD" psql \
    --host "$PGHOST" \
    --port "$PGPORT" \
    --username "$POSTGRES_USER" \
    --dbname "$predecessor_database" \
    --no-password \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 <<SQL
BEGIN;
SELECT set_config('app.organization_id', '$predecessor_sentinel_id', true);
SELECT set_config('app.actor_id', 'ci-predecessor-upgrade', true);
SELECT set_config('app.request_id', '00000000-0000-4000-8000-0000000000a3', true);
SELECT set_config('app.auth_method', 'migration-verification', true);
SELECT set_config('app.source_surface', 'WORKER', true);
SELECT set_config('app.reason', 'Verify predecessor audit graph preservation', true);
SELECT app.append_tenant_business_audit(
  '$predecessor_sentinel_id',
  'ci.predecessor-audit-after-upgrade',
  'organization',
  '$predecessor_sentinel_id',
  '{"source":"predecessor-upgrade"}'::jsonb,
  NULL
);
COMMIT;
SQL

  preserved_audit_chain="$(psql_value "$predecessor_database" \
    "SELECT count(*)::text || '|' ||
       max(previous_event_hash) FILTER (WHERE action='ci.predecessor-audit-after-upgrade') || '|' ||
       max((occurred_at > '2040-01-01T00:00:00Z'::timestamptz)::text)
         FILTER (WHERE action='ci.predecessor-audit-after-upgrade')
     FROM audit_events WHERE organization_id='$predecessor_sentinel_id';")"
  [[ "$preserved_audit_chain" == "3|$predecessor_audit_leaf_hash|true" ]] ||
    fail "predecessor audit graph was not preserved and extended from its graph leaf"
  upgraded_audit_leaf="$(psql_value "$predecessor_database" \
    "SELECT (leaf.leaf_event_hash = event.event_hash)::text
     FROM app.locked_audit_graph_leaf('$predecessor_sentinel_id') leaf
     JOIN audit_events event
       ON event.organization_id='$predecessor_sentinel_id'
      AND event.action='ci.predecessor-audit-after-upgrade';")"
  [[ "$upgraded_audit_leaf" == "true" ]] ||
    fail "upgraded predecessor audit helper did not return the appended graph leaf"

  reconcile_roles "$predecessor_database"
  verify_fail_closed_default_privileges "$predecessor_database"
  verify_schema_and_grants "$predecessor_database"
  printf '%s\n' \
    "Predecessor upgrade verification passed: replayed 0000-0024, preserved tenant and audit sentinels, upgraded through 0031, and verified schema/grants/journal types."
else
  # Create two otherwise-identical business events with explicit request IDs.
  # Their exact audit/outbox correlation must survive the populated logical
  # backup rather than being reconstructed from aggregate identity.
  PGPASSWORD="$PGPASSWORD" psql \
    --host "$PGHOST" \
    --port "$PGPORT" \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --no-password \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 <<SQL
BEGIN;
SELECT set_config('app.organization_id', '$demo_organization_id', true);
SELECT set_config('app.actor_id', 'ci-populated-restore', true);
SELECT set_config('app.auth_method', 'migration-verification', true);
SELECT set_config('app.source_surface', 'WORKER', true);
SELECT set_config('app.reason', 'Verify exact request correlation through logical restore', true);
SELECT set_config('app.request_id', '$restore_correlation_request_a', true);
SELECT app.append_tenant_business_audit(
  '$demo_organization_id',
  'organization.member-sessions-revoked',
  'organization_membership',
  '$restore_correlation_aggregate_id',
  '{"source":"populated-restore","sequence":1}'::jsonb,
  'organization.member-sessions-revoked'
);
SELECT set_config('app.request_id', '$restore_correlation_request_b', true);
SELECT app.append_tenant_business_audit(
  '$demo_organization_id',
  'organization.member-sessions-revoked',
  'organization_membership',
  '$restore_correlation_aggregate_id',
  '{"source":"populated-restore","sequence":2}'::jsonb,
  'organization.member-sessions-revoked'
);
COMMIT;
SQL

  source_request_correlation="$(psql_value "$POSTGRES_DB" \
    "SELECT string_agg(audit.request_id || ':' || outbox.request_id, ',' ORDER BY audit.request_id)
     FROM audit_events audit
     JOIN outbox_events outbox
       ON outbox.organization_id=audit.organization_id
      AND outbox.aggregate_type=audit.entity_type
      AND outbox.aggregate_id=audit.entity_id
      AND outbox.request_id=audit.request_id
     WHERE audit.organization_id='$demo_organization_id'
       AND audit.action='organization.member-sessions-revoked'
       AND audit.entity_id='$restore_correlation_aggregate_id'
       AND audit.request_id IN ('$restore_correlation_request_a','$restore_correlation_request_b');")"
  readonly source_request_correlation
  readonly expected_request_correlation="$restore_correlation_request_a:$restore_correlation_request_a,$restore_correlation_request_b:$restore_correlation_request_b"
  [[ "$source_request_correlation" == "$expected_request_correlation" ]] ||
    fail "source audit/outbox request correlation fixture is incomplete"

  source_migration_count="$(psql_value "$POSTGRES_DB" \
    "SELECT count(*) FROM drizzle.__drizzle_migrations;")"
  [[ "$source_migration_count" == "32" ]] ||
    fail "source database is not fully migrated through 0031 (found $source_migration_count records)"
  source_organization_count="$(psql_value "$POSTGRES_DB" "SELECT count(*) FROM organizations;")"
  [[ "$source_organization_count" =~ ^[1-9][0-9]*$ ]] ||
    fail "source database has no populated organization data to restore"
  source_demo_sentinel="$(psql_value "$POSTGRES_DB" \
    "SELECT slug || '|' || display_name FROM organizations WHERE id = '$demo_organization_id';")"
  [[ -n "$source_demo_sentinel" ]] ||
    fail "source database is missing the bootstrapped demo organization sentinel"

  backup_password="$(read_single_line_secret \
    "$BACKUP_DATABASE_PASSWORD_FILE" "backup database password file")"
  readonly backup_password
  readonly dump_path="$temporary_root/main-populated.dump"
  readonly dump_listing="$temporary_root/main-populated.list"
  PGPASSWORD="$backup_password" pg_dump \
    --host "$PGHOST" \
    --port "$PGPORT" \
    --username business_finlynq_backup \
    --dbname "$POSTGRES_DB" \
    --no-password \
    --format custom \
    --no-owner \
    --no-privileges \
    --file "$dump_path"
  [[ -s "$dump_path" ]] || fail "pg_dump produced an empty archive"
  pg_restore --list "$dump_path" > "$dump_listing"
  grep -Fq "TABLE DATA public organizations" "$dump_listing" ||
    fail "pg_dump archive does not contain organization data"

  PGPASSWORD="$PGPASSWORD" pg_restore \
    --host "$PGHOST" \
    --port "$PGPORT" \
    --username "$POSTGRES_USER" \
    --dbname "$restore_database" \
    --no-password \
    --exit-on-error \
    --single-transaction \
    --no-owner \
    --no-privileges \
    "$dump_path"

  run_migrations "$restore_database" "$repository_root/migrations/drizzle"
  reconcile_roles "$restore_database"
  verify_fail_closed_default_privileges "$restore_database"
  verify_schema_and_grants "$restore_database"

  restored_migration_count="$(psql_value "$restore_database" \
    "SELECT count(*) FROM drizzle.__drizzle_migrations;")"
  [[ "$restored_migration_count" == "$source_migration_count" ]] ||
    fail "restored migration history differs from the populated source"
  restored_organization_count="$(psql_value "$restore_database" "SELECT count(*) FROM organizations;")"
  [[ "$restored_organization_count" == "$source_organization_count" ]] ||
    fail "restored organization count differs from the populated source"
  restored_demo_sentinel="$(psql_value "$restore_database" \
    "SELECT slug || '|' || display_name FROM organizations WHERE id = '$demo_organization_id';")"
  [[ "$restored_demo_sentinel" == "$source_demo_sentinel" ]] ||
    fail "restored demo organization sentinel differs from the populated source"
  restored_request_correlation="$(psql_value "$restore_database" \
    "SELECT string_agg(audit.request_id || ':' || outbox.request_id, ',' ORDER BY audit.request_id)
     FROM audit_events audit
     JOIN outbox_events outbox
       ON outbox.organization_id=audit.organization_id
      AND outbox.aggregate_type=audit.entity_type
      AND outbox.aggregate_id=audit.entity_id
      AND outbox.request_id=audit.request_id
     WHERE audit.organization_id='$demo_organization_id'
       AND audit.action='organization.member-sessions-revoked'
       AND audit.entity_id='$restore_correlation_aggregate_id'
       AND audit.request_id IN ('$restore_correlation_request_a','$restore_correlation_request_b');")"
  [[ "$restored_request_correlation" == "$source_request_correlation" ]] ||
    fail "restored audit/outbox request IDs differ from the populated source"

  printf '%s\n' \
    "Logical restore verification passed: dumped populated data, preserved explicit audit/outbox request IDs, restored it, reran migrations and all role reconcilers, and verified schema/grants/journal types."
fi
