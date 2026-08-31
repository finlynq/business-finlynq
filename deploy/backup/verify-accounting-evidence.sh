#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

fail() {
  printf 'Accounting evidence verification failed: %s\n' "$1" >&2
  exit 1
}

for command_name in awk chmod date jq mkdir mv psql readlink rm; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${ACCOUNTING_EVIDENCE_DATABASE_PASSWORD_FILE:?ACCOUNTING_EVIDENCE_DATABASE_PASSWORD_FILE is required}"

PGPORT="${PGPORT:-5432}"
ACCOUNTING_EVIDENCE_QUERY_FILE="${ACCOUNTING_EVIDENCE_QUERY_FILE:-/usr/local/share/business-finlynq/accounting-evidence-query.sql}"
ACCOUNTING_EVIDENCE_OUTPUT_DIR="${ACCOUNTING_EVIDENCE_OUTPUT_DIR:-}"
ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS="${ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS:-120000}"

[[ "$PGPORT" =~ ^[0-9]+$ ]] || fail "PGPORT must be numeric"
[[ "$ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS" =~ ^[0-9]+$ \
  && "$ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS" -ge 1000 \
  && "$ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS" -le 300000 ]] \
  || fail "statement timeout must be between 1000 and 300000 milliseconds"
[[ -f "$ACCOUNTING_EVIDENCE_QUERY_FILE" && ! -L "$ACCOUNTING_EVIDENCE_QUERY_FILE" ]] \
  || fail "reviewed accounting-evidence query is unavailable"
[[ -r "$ACCOUNTING_EVIDENCE_DATABASE_PASSWORD_FILE" ]] \
  || fail "database password file is not readable"
password_lines="$(awk 'END { print NR }' "$ACCOUNTING_EVIDENCE_DATABASE_PASSWORD_FILE")"
[[ "$password_lines" == "1" ]] || fail "database password file must contain exactly one line"
IFS= read -r PGPASSWORD <"$ACCOUNTING_EVIDENCE_DATABASE_PASSWORD_FILE" || true
[[ ${#PGPASSWORD} -ge 24 && ${#PGPASSWORD} -le 1024 ]] \
  || fail "database password must contain 24 to 1024 characters"
[[ "$PGPASSWORD" != *$'\r'* && "$PGPASSWORD" != *$'\n'* ]] \
  || fail "database password must be a single line"
export PGPASSWORD
PGOPTIONS="-c statement_timeout=${ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS}"
export PGOPTIONS
trap 'unset PGPASSWORD PGOPTIONS' EXIT INT TERM

verification_row="$(psql \
  --quiet \
  --no-password \
  --tuples-only \
  --no-align \
  --field-separator='|' \
  --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" \
  --port "$PGPORT" \
  --dbname "$PGDATABASE" \
  --username "$PGUSER" \
  --file "$ACCOUNTING_EVIDENCE_QUERY_FILE")" \
  || fail "database query did not complete"

IFS='|' read -r \
  organization_count audit_event_count outbox_event_count \
  invalid_hash_count invalid_hash_contract_count hash_mismatch_count \
  invalid_audit_request_count invalid_outbox_request_count \
  root_anomaly_count leaf_anomaly_count missing_predecessor_count \
  forked_predecessor_count unreachable_event_count invalid_outbox_contract_count \
  audit_without_required_outbox_count outbox_without_correct_audit_count \
  paired_count_mismatch_count unexpected_field <<<"$verification_row"

[[ -z "${unexpected_field:-}" ]] || fail "database query returned an unexpected shape"
for count_value in \
  "$organization_count" "$audit_event_count" "$outbox_event_count" \
  "$invalid_hash_count" "$invalid_hash_contract_count" "$hash_mismatch_count" \
  "$invalid_audit_request_count" "$invalid_outbox_request_count" \
  "$root_anomaly_count" "$leaf_anomaly_count" "$missing_predecessor_count" \
  "$forked_predecessor_count" "$unreachable_event_count" "$invalid_outbox_contract_count" \
  "$audit_without_required_outbox_count" "$outbox_without_correct_audit_count" \
  "$paired_count_mismatch_count"; do
  [[ "$count_value" =~ ^[0-9]+$ ]] || fail "database query returned a non-numeric count"
done

integrity_error_count=$((
  invalid_hash_count + invalid_hash_contract_count + hash_mismatch_count +
  invalid_audit_request_count + invalid_outbox_request_count +
  root_anomaly_count + leaf_anomaly_count + missing_predecessor_count +
  forked_predecessor_count + unreachable_event_count + invalid_outbox_contract_count +
  audit_without_required_outbox_count + outbox_without_correct_audit_count +
  paired_count_mismatch_count
))

result="verified"
(( integrity_error_count == 0 )) || result="failed"
verification_json="$(jq -cn \
  --arg result "$result" \
  --argjson organizations "$organization_count" \
  --argjson auditEvents "$audit_event_count" \
  --argjson outboxEvents "$outbox_event_count" \
  --argjson auditHashContractErrors "$invalid_hash_contract_count" \
  --argjson auditHashMismatches "$hash_mismatch_count" \
  --argjson invalidOutboxContracts "$invalid_outbox_contract_count" \
  --argjson auditsWithoutRequiredOutbox "$audit_without_required_outbox_count" \
  --argjson outboxWithoutCorrectAudit "$outbox_without_correct_audit_count" \
  --argjson pairedCountMismatches "$paired_count_mismatch_count" \
  --argjson integrityErrors "$integrity_error_count" \
  '{
    status: $result,
    organizations: $organizations,
    auditEvents: $auditEvents,
    outboxEvents: $outboxEvents,
    auditHashContractErrors: $auditHashContractErrors,
    auditHashMismatches: $auditHashMismatches,
    invalidOutboxContracts: $invalidOutboxContracts,
    auditsWithoutRequiredOutbox: $auditsWithoutRequiredOutbox,
    outboxWithoutCorrectAudit: $outboxWithoutCorrectAudit,
    pairedCountMismatches: $pairedCountMismatches,
    integrityErrors: $integrityErrors
  }')"
if (( integrity_error_count != 0 )); then
  printf '%s\n' "$verification_json"
  fail "audit hash/graph or request/outbox lineage is inconsistent; only aggregate counts were emitted"
fi

if [[ -n "$ACCOUNTING_EVIDENCE_OUTPUT_DIR" ]]; then
  : "${RESTORE_EVIDENCE_ID:?RESTORE_EVIDENCE_ID is required for retained accounting evidence}"
  : "${RESTORE_SELECTED_SHA256:?RESTORE_SELECTED_SHA256 is required for retained accounting evidence}"
  : "${RESTORE_SELECTED_ARCHIVE:?RESTORE_SELECTED_ARCHIVE is required for retained accounting evidence}"
  ACCOUNTING_EVIDENCE_PHASE="${ACCOUNTING_EVIDENCE_PHASE:-}"
  [[ "$ACCOUNTING_EVIDENCE_PHASE" == "post-grants-pre-bootstrap" ]] \
    || fail "retained accounting evidence phase is invalid"
  [[ "$RESTORE_EVIDENCE_ID" =~ ^[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$ ]] \
    || fail "restore evidence id is invalid"
  [[ "$RESTORE_SELECTED_SHA256" =~ ^[a-f0-9]{64}$ ]] \
    || fail "restore evidence checksum is invalid"
  [[ "$RESTORE_SELECTED_ARCHIVE" =~ ^business_finlynq_[A-Za-z0-9_.-]+\.dump\.age$ ]] \
    || fail "restore evidence archive name is invalid"
  [[ ! -e "$ACCOUNTING_EVIDENCE_OUTPUT_DIR" || ! -L "$ACCOUNTING_EVIDENCE_OUTPUT_DIR" ]] \
    || fail "accounting evidence directory is a symbolic link"
  mkdir -p -- "$ACCOUNTING_EVIDENCE_OUTPUT_DIR"
  ACCOUNTING_EVIDENCE_OUTPUT_DIR="$(cd -- "$ACCOUNTING_EVIDENCE_OUTPUT_DIR" && pwd -P)"
  case "$ACCOUNTING_EVIDENCE_OUTPUT_DIR" in
    /backups/*) ;;
    *) fail "accounting evidence directory is outside the mounted backup path" ;;
  esac

  verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  report_name="accounting-prebootstrap_${RESTORE_EVIDENCE_ID}.json"
  report_path="$ACCOUNTING_EVIDENCE_OUTPUT_DIR/$report_name"
  partial_report="$ACCOUNTING_EVIDENCE_OUTPUT_DIR/.${report_name}.partial.$$"
  [[ ! -e "$report_path" ]] || fail "refusing to overwrite retained accounting evidence"
  cleanup_partial_report() {
    rm -f -- "$partial_report"
  }
  trap 'unset PGPASSWORD PGOPTIONS; cleanup_partial_report' EXIT INT TERM
  jq -n \
    --arg verifiedAt "$verified_at" \
    --arg phase "$ACCOUNTING_EVIDENCE_PHASE" \
    --arg sha256 "$RESTORE_SELECTED_SHA256" \
    --arg archive "$RESTORE_SELECTED_ARCHIVE" \
    --argjson counts "$verification_json" \
    '{
      schemaVersion: 1,
      product: "business-finlynq",
      result: "verified",
      verifiedAt: $verifiedAt,
      phase: $phase,
      sha256: $sha256,
      encryptedArchive: $archive,
      checks: {
        auditHashContract: ($counts.auditHashContractErrors == 0),
        auditHashRecomputation: ($counts.auditHashMismatches == 0),
        auditOutboxIntegrity: ($counts.integrityErrors == 0)
      },
      counts: $counts
    }' >"$partial_report"
  chmod 0600 -- "$partial_report"
  mv -- "$partial_report" "$report_path"
fi

printf '%s\n' "$verification_json"
