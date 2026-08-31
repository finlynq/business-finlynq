#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS="${ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS:-180}"
ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS="${ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS:-120000}"
readonly accounting_metrics_file="${ACCOUNTING_EVIDENCE_METRICS_FILE:-/var/lib/business-finlynq/accounting-evidence.prom}"
readonly accounting_lock_file="${ACCOUNTING_EVIDENCE_LOCK_FILE:-/var/lib/business-finlynq/accounting-evidence.lock}"

[[ "$ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS" =~ ^[0-9]+$ \
  && "$ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS" -ge 30 \
  && "$ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS" -le 900 ]] || {
  printf '%s\n' "Accounting-evidence timeout must be between 30 and 900 seconds" >&2
  exit 2
}
[[ "$ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS" =~ ^[0-9]+$ \
  && "$ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS" -ge 1000 \
  && "$ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS" -le 300000 ]] || {
  printf '%s\n' "Accounting-evidence statement timeout must be between 1000 and 300000 milliseconds" >&2
  exit 2
}
for command_name in awk chmod date docker flock grep install jq mktemp mv rm timeout touch; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required accounting-evidence command is unavailable: %s\n' "$command_name" >&2
    exit 2
  }
done

metrics_directory="${accounting_metrics_file%/*}"
lock_directory="${accounting_lock_file%/*}"
[[ "$accounting_metrics_file" == /* && "$metrics_directory" != "$accounting_metrics_file" \
  && "$accounting_lock_file" == /* && "$lock_directory" != "$accounting_lock_file" \
  && ! -L "$metrics_directory" && ! -L "$accounting_metrics_file" \
  && ! -L "$lock_directory" && ! -L "$accounting_lock_file" \
  && ( ! -e "$metrics_directory" || -d "$metrics_directory" ) \
  && ( ! -e "$accounting_metrics_file" || -f "$accounting_metrics_file" ) \
  && ( ! -e "$lock_directory" || -d "$lock_directory" ) \
  && ( ! -e "$accounting_lock_file" || -f "$accounting_lock_file" ) ]] || {
  printf '%s\n' "Accounting-evidence state paths must be absolute and non-symbolic" >&2
  exit 2
}
install -d -m 0775 -- "$metrics_directory" "$lock_directory"
touch -- "$accounting_lock_file"
chmod 0660 -- "$accounting_lock_file"

exec 9>"$accounting_lock_file"
flock --exclusive --wait 5 9 || {
  printf '%s\n' "A prior accounting-evidence verification is still active" >&2
  exit 75
}

verification_output="$(mktemp)"
verification_success=0
verification_run_unixtime="$(date +%s)"
verification_last_success_unixtime=0
verification_duration_seconds=0
if [[ -f "$accounting_metrics_file" && ! -L "$accounting_metrics_file" ]]; then
  previous_success="$(awk '$1 == "business_finlynq_accounting_evidence_verification_last_success_unixtime" { print $2; exit }' "$accounting_metrics_file")"
  [[ "$previous_success" =~ ^[0-9]+$ ]] && verification_last_success_unixtime="$previous_success"
fi

write_metrics() {
  local exit_status="$1" metrics_temporary
  metrics_temporary="$(mktemp "${accounting_metrics_file}.tmp.XXXXXX")" || return 1
  chmod 0644 -- "$metrics_temporary"
  {
    printf '%s\n' '# HELP business_finlynq_accounting_evidence_verification_success Whether the latest bounded full-history audit/outbox verification succeeded.'
    printf '%s\n' '# TYPE business_finlynq_accounting_evidence_verification_success gauge'
    printf 'business_finlynq_accounting_evidence_verification_success %s\n' "$([[ "$exit_status" == "0" && "$verification_success" == "1" ]] && printf '1' || printf '0')"
    printf '%s\n' '# HELP business_finlynq_accounting_evidence_verification_last_run_unixtime Unix time of the latest bounded full-history verification attempt.'
    printf '%s\n' '# TYPE business_finlynq_accounting_evidence_verification_last_run_unixtime gauge'
    printf 'business_finlynq_accounting_evidence_verification_last_run_unixtime %s\n' "$verification_run_unixtime"
    printf '%s\n' '# HELP business_finlynq_accounting_evidence_verification_last_success_unixtime Unix time of the latest successful full-history verification.'
    printf '%s\n' '# TYPE business_finlynq_accounting_evidence_verification_last_success_unixtime gauge'
    printf 'business_finlynq_accounting_evidence_verification_last_success_unixtime %s\n' "$verification_last_success_unixtime"
    printf '%s\n' '# HELP business_finlynq_accounting_evidence_verification_duration_seconds Duration of the latest bounded full-history verification.'
    printf '%s\n' '# TYPE business_finlynq_accounting_evidence_verification_duration_seconds gauge'
    printf 'business_finlynq_accounting_evidence_verification_duration_seconds %s\n' "$verification_duration_seconds"
  } >"$metrics_temporary"
  mv -f -- "$metrics_temporary" "$accounting_metrics_file"
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  rm -f -- "$verification_output"
  if ! write_metrics "$exit_status"; then
    printf '%s\n' "Accounting-evidence metrics could not be written" >&2
    exit_status=1
  fi
  exit "$exit_status"
}
trap cleanup EXIT INT TERM

started_at="$(date +%s)"
verification_status=0
timeout --signal=TERM --kill-after=5 "${ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS}s" \
  docker compose --profile operations run --rm --no-deps -T \
    --env "ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS=$ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS" \
    verify_accounting_evidence \
  </dev/null >"$verification_output" 2>&1 \
  || verification_status=$?
finished_at="$(date +%s)"
verification_duration_seconds="$(( finished_at - started_at ))"

if [[ "$verification_status" == "0" ]] \
  && grep -E '^\{.*\}$' "$verification_output" \
    | jq -s -e 'any(.[]; type == "object" and .status == "verified" and .integrityErrors == 0)' \
      >/dev/null 2>&1; then
  verification_success=1
  verification_last_success_unixtime="$finished_at"
  printf '%s\n' "Business Finlynq accounting-evidence verification passed"
else
  printf '%s\n' "Business Finlynq accounting-evidence verification failed" >&2
  exit 1
fi
