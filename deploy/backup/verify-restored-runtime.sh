#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

for command_name in curl jq psql; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is unavailable: $command_name"
done

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${APP_DATABASE_PASSWORD_FILE:?APP_DATABASE_PASSWORD_FILE is required}"
: "${AUTH_WORKER_DATABASE_PASSWORD_FILE:?AUTH_WORKER_DATABASE_PASSWORD_FILE is required}"
: "${BACKUP_DATABASE_PASSWORD_FILE:?BACKUP_DATABASE_PASSWORD_FILE is required}"

PGPORT="${PGPORT:-5432}"
RESTORE_APP_URL="${RESTORE_APP_URL:-http://restore_app:3000}"
RESTORE_EXPECTED_APP_ORIGIN="${RESTORE_EXPECTED_APP_ORIGIN:-https://business.finlynq.com}"
RESTORE_ALLOWED_HOST="${RESTORE_ALLOWED_HOST:-restore_database}"
RESTORE_CONFIRM_DISPOSABLE="${RESTORE_CONFIRM_DISPOSABLE:-}"
RESTORE_APP_DATABASE_USER="${RESTORE_APP_DATABASE_USER:-business_finlynq_app}"
RESTORE_AUTH_WORKER_DATABASE_USER="${RESTORE_AUTH_WORKER_DATABASE_USER:-business_finlynq_auth_worker}"
RESTORE_BACKUP_DATABASE_USER="${RESTORE_BACKUP_DATABASE_USER:-business_finlynq_backup}"

[[ "$RESTORE_CONFIRM_DISPOSABLE" == "business-finlynq-restore-drill" ]] || fail "Restore confirmation phrase is missing"
[[ "$PGHOST" == "$RESTORE_ALLOWED_HOST" ]] || fail "Runtime verification target is not the explicitly allowed disposable host"
[[ "$PGDATABASE" =~ ^business_finlynq_restore_drill(_[a-z0-9_]+)?$ ]] || fail "Runtime verification database is not a restore-drill database"
[[ "$PGPORT" =~ ^[0-9]+$ ]] || fail "PGPORT must be numeric"
[[ "$RESTORE_APP_URL" =~ ^http://restore_app(:[0-9]+)?$ ]] || fail "Restore application URL is outside the isolated restore service"
[[ "$RESTORE_EXPECTED_APP_ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || fail "Expected restored application origin must be an HTTPS origin"

read_secret() {
  local secret_file="$1"
  local secret_label="$2"
  local line_count
  local secret_value

  [[ -r "$secret_file" ]] || fail "$secret_label file is not readable"
  line_count="$(awk 'END { print NR }' "$secret_file")"
  [[ "$line_count" == "1" ]] || fail "$secret_label file must contain exactly one line"
  IFS= read -r secret_value < "$secret_file" || [[ -n "$secret_value" ]]
  [[ ${#secret_value} -ge 24 && ${#secret_value} -le 1024 ]] || fail "$secret_label must contain 24 to 1024 characters"
  [[ "$secret_value" != *$'\r'* && "$secret_value" != *$'\n'* ]] || fail "$secret_label must be a single line"
  printf '%s' "$secret_value"
}

temporary_directory="$(mktemp -d /tmp/business-finlynq-runtime-verify.XXXXXX)"
cleanup() {
  unset PGPASSWORD app_password worker_password backup_password
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT INT TERM

headers_path="$temporary_directory/headers"
body_path="$temporary_directory/body"
user_agent="Business-Finlynq-Restore-Drill/1"

log "Checking restored application readiness"
health_status="$(curl --silent --show-error \
  --connect-timeout 5 --max-time 15 \
  --user-agent "$user_agent" \
  --dump-header "$headers_path" \
  --output "$body_path" \
  --write-out '%{http_code}' \
  "$RESTORE_APP_URL/api/health")"
[[ "$health_status" == "200" ]] || fail "Restored application readiness returned HTTP $health_status"
jq -e '
  .status == "ready" and
  .checks.database == "ready" and
  .checks.organizationKey == "ready" and
  .checks.identityKey == "ready" and
  .checks.accountAuthentication == "disabled" and
  .checks.emailWorker == "disabled"
' "$body_path" >/dev/null || fail "Restored application readiness payload is invalid"
grep -Eiq '^cache-control:.*no-store' "$headers_path" || fail "Restored readiness response is cacheable"

log "Checking restored demo-session issuance and resolution"
demo_result="$(curl --silent --show-error \
  --connect-timeout 5 --max-time 15 \
  --max-redirs 0 \
  --user-agent "$user_agent" \
  --dump-header "$headers_path" \
  --output /dev/null \
  --write-out $'%{http_code}\n%{redirect_url}' \
  "$RESTORE_APP_URL/try-demo?next=/app")"
demo_status="${demo_result%%$'\n'*}"
redirect_location="${demo_result#*$'\n'}"
[[ "$demo_status" == "303" ]] || fail "Restored demo login returned HTTP $demo_status"
[[ "$redirect_location" == "$RESTORE_EXPECTED_APP_ORIGIN/app" ]] || fail "Restored demo login returned an unexpected redirect"
session_cookie="$(awk 'tolower($1) == "set-cookie:" { sub(/^[^:]+:[[:space:]]*/, ""); sub(/;.*/, ""); gsub(/\r/, ""); print; exit }' "$headers_path")"
[[ "$session_cookie" =~ ^business_finlynq_restore_session=[A-Za-z0-9_-]{32,200}$ ]] || fail "Restored demo login did not issue the expected opaque session cookie"

workspace_status="$(curl --silent --show-error \
  --connect-timeout 5 --max-time 20 \
  --user-agent "$user_agent" \
  --header "Cookie: $session_cookie" \
  --output "$body_path" \
  --write-out '%{http_code}' \
  "$RESTORE_APP_URL/app")"
[[ "$workspace_status" == "200" ]] || fail "Restored demo workspace returned HTTP $workspace_status"
grep -Fq "Accounting overview" "$body_path" || fail "Restored demo workspace did not render the expected page"

worker_password="$(read_secret "$AUTH_WORKER_DATABASE_PASSWORD_FILE" "Authentication-worker database password")"
PGPASSWORD="$worker_password"
export PGPASSWORD

log "Checking restored authentication-worker permissions"
psql --no-password --quiet --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --port "$PGPORT" --dbname "$PGDATABASE" \
  --username "$RESTORE_AUTH_WORKER_DATABASE_USER" \
  --command "SELECT app.auth_email_worker_heartbeat('00000000-0000-4000-8000-000000000001'::uuid);" >/dev/null
psql --no-password --quiet --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --port "$PGPORT" --dbname "$PGDATABASE" \
  --username "$RESTORE_AUTH_WORKER_DATABASE_USER" \
  --command "BEGIN; SELECT count(*) FROM app.auth_claim_email_delivery('00000000-0000-4000-8000-000000000001'::uuid); ROLLBACK;" >/dev/null

if psql --no-password --quiet --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --port "$PGPORT" --dbname "$PGDATABASE" \
  --username "$RESTORE_AUTH_WORKER_DATABASE_USER" \
  --command "SELECT count(*) FROM public.auth_email_outbox" >/dev/null 2>&1; then
  fail "Authentication worker can read the email outbox directly"
fi

worker_session_privilege="$(psql --no-password --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --port "$PGPORT" --dbname "$PGDATABASE" \
  --username "$RESTORE_AUTH_WORKER_DATABASE_USER" \
  --command "SELECT has_function_privilege(current_user, 'app.auth_issue_demo_session(text,text,text,text,text,text)', 'EXECUTE');")"
[[ "$worker_session_privilege" == "f" ]] || fail "Authentication worker can issue application sessions"

app_password="$(read_secret "$APP_DATABASE_PASSWORD_FILE" "Application database password")"
PGPASSWORD="$app_password"
export PGPASSWORD

readiness_result="$(psql --no-password --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --port "$PGPORT" --dbname "$PGDATABASE" \
  --username "$RESTORE_APP_DATABASE_USER" \
  --command "SELECT worker_ready FROM app.auth_email_delivery_readiness(60);")"
[[ "$readiness_result" == "t" ]] || fail "Application role cannot observe the restored worker heartbeat"

app_claim_privilege="$(psql --no-password --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --port "$PGPORT" --dbname "$PGDATABASE" \
  --username "$RESTORE_APP_DATABASE_USER" \
  --command "SELECT has_function_privilege(current_user, 'app.auth_claim_email_delivery(uuid)', 'EXECUTE');")"
[[ "$app_claim_privilege" == "f" ]] || fail "Application role can claim email deliveries"

backup_password="$(read_secret "$BACKUP_DATABASE_PASSWORD_FILE" "Backup database password")"
PGPASSWORD="$backup_password"
export PGPASSWORD

log "Checking restored backup-role permissions"
backup_role_contract="$(psql --no-password --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --port "$PGPORT" --dbname "$PGDATABASE" \
  --username "$RESTORE_BACKUP_DATABASE_USER" \
  --command "
    SELECT role.rolcanlogin
      AND role.rolbypassrls
      AND NOT role.rolsuper
      AND NOT role.rolcreatedb
      AND NOT role.rolcreaterole
      AND NOT role.rolreplication
      AND NOT role.rolinherit
      AND role.rolconnlimit = 2
      AND current_setting('transaction_read_only') = 'on'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace schema ON schema.oid = relation.relnamespace
        WHERE schema.nspname IN ('public', 'drizzle')
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (
            NOT has_table_privilege(current_user, relation.oid, 'SELECT')
            OR has_table_privilege(current_user, relation.oid, 'INSERT')
            OR has_table_privilege(current_user, relation.oid, 'UPDATE')
            OR has_table_privilege(current_user, relation.oid, 'DELETE')
            OR has_table_privilege(current_user, relation.oid, 'TRUNCATE')
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_proc routine
        JOIN pg_namespace schema ON schema.oid = routine.pronamespace
        WHERE schema.nspname <> 'information_schema'
          AND schema.nspname !~ '^pg_'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend dependency
            WHERE dependency.classid = 'pg_proc'::regclass
              AND dependency.objid = routine.oid
              AND dependency.deptype = 'e'
          )
          AND has_function_privilege(current_user, routine.oid, 'EXECUTE')
      )
    FROM pg_roles role
    WHERE role.rolname = current_user;")"
[[ "$backup_role_contract" == "t" ]] || fail "Restored backup role does not match the reviewed read-only contract"

backup_visible_organizations="$(psql --no-password --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --port "$PGPORT" --dbname "$PGDATABASE" \
  --username "$RESTORE_BACKUP_DATABASE_USER" \
  --command "SELECT count(*) > 0 FROM public.organizations;")"
[[ "$backup_visible_organizations" == "t" ]] || fail "Restored backup role cannot read the restored organization set"

if psql --no-password --quiet --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --port "$PGPORT" --dbname "$PGDATABASE" \
  --username "$RESTORE_BACKUP_DATABASE_USER" \
  --command "BEGIN; SET TRANSACTION READ WRITE; UPDATE public.organizations SET active = active; ROLLBACK;" \
  >/dev/null 2>&1; then
  fail "Restored backup role can write application data"
fi

log "Restored runtime verification passed: readiness, demo session, app ACL, worker ACL, and backup ACL"
