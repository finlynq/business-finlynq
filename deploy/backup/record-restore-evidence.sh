#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

fail() {
  printf 'Restore evidence failed: %s\n' "$1" >&2
  exit 1
}

for command_name in awk date find grep jq openssl readlink sha256sum stat; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

: "${BACKUP_MANIFEST:?BACKUP_MANIFEST is required}"
: "${RESTORE_DRILL_STARTED_AT:?RESTORE_DRILL_STARTED_AT is required}"
: "${RESTORE_DRILL_COMPLETED_AT:?RESTORE_DRILL_COMPLETED_AT is required}"
: "${BUSINESS_FINLYNQ_IMAGE_REVISION:?BUSINESS_FINLYNQ_IMAGE_REVISION is required}"
: "${RESTORE_APP_IMAGE_ID:?RESTORE_APP_IMAGE_ID is required}"
: "${RESTORE_MIGRATOR_IMAGE_ID:?RESTORE_MIGRATOR_IMAGE_ID is required}"
: "${RESTORE_OPERATIONS_IMAGE_ID:?RESTORE_OPERATIONS_IMAGE_ID is required}"

BACKUP_OUTPUT_DIR="${BACKUP_OUTPUT_DIR:-/backups}"
RESTORE_REPORT_DIR="${RESTORE_REPORT_DIR:-$BACKUP_OUTPUT_DIR/restore-reports}"
RESTORE_RPO_SECONDS="${RESTORE_RPO_SECONDS:-21600}"
RESTORE_RTO_SECONDS="${RESTORE_RTO_SECONDS:-14400}"
RESTORE_REQUIRE_OFFSITE_EVIDENCE="${RESTORE_REQUIRE_OFFSITE_EVIDENCE:-true}"
RESTORE_ALLOW_EMPTY_SECRET_FIXTURES="${RESTORE_ALLOW_EMPTY_SECRET_FIXTURES:-false}"

[[ "$BACKUP_MANIFEST" =~ ^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+\.manifest\.json$ ]] \
  || fail "BACKUP_MANIFEST must be one safe Business Finlynq manifest name"
[[ "$RESTORE_DRILL_STARTED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || fail "RESTORE_DRILL_STARTED_AT must be a UTC second timestamp"
[[ "$RESTORE_DRILL_COMPLETED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || fail "RESTORE_DRILL_COMPLETED_AT must be a UTC second timestamp"
[[ "$RESTORE_RPO_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  || fail "RESTORE_RPO_SECONDS must be a positive integer"
[[ "$RESTORE_RTO_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  || fail "RESTORE_RTO_SECONDS must be a positive integer"
[[ ${#RESTORE_RPO_SECONDS} -le 5 ]] \
  && (( RESTORE_RPO_SECONDS <= 21600 )) \
  || fail "RESTORE_RPO_SECONDS cannot exceed the production 21600-second objective"
[[ ${#RESTORE_RTO_SECONDS} -le 5 ]] \
  && (( RESTORE_RTO_SECONDS <= 14400 )) \
  || fail "RESTORE_RTO_SECONDS cannot exceed the production 14400-second objective"
[[ "$RESTORE_REQUIRE_OFFSITE_EVIDENCE" == "true" || "$RESTORE_REQUIRE_OFFSITE_EVIDENCE" == "false" ]] \
  || fail "RESTORE_REQUIRE_OFFSITE_EVIDENCE must be true or false"
[[ "$RESTORE_ALLOW_EMPTY_SECRET_FIXTURES" == "true" \
  || "$RESTORE_ALLOW_EMPTY_SECRET_FIXTURES" == "false" ]] \
  || fail "RESTORE_ALLOW_EMPTY_SECRET_FIXTURES must be true or false"
[[ "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ \
  && ! "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^0+$ ]] \
  || fail "BUSINESS_FINLYNQ_IMAGE_REVISION must be a full Git revision"
for recovery_image_id in "$RESTORE_APP_IMAGE_ID" "$RESTORE_MIGRATOR_IMAGE_ID" "$RESTORE_OPERATIONS_IMAGE_ID"; do
  [[ "$recovery_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || fail "recovery image IDs must be immutable sha256 identifiers"
done

[[ -d "$BACKUP_OUTPUT_DIR" && ! -L "$BACKUP_OUTPUT_DIR" ]] \
  || fail "backup directory is missing or is a symbolic link"
BACKUP_OUTPUT_DIR="$(cd -- "$BACKUP_OUTPUT_DIR" && pwd -P)"
[[ "$BACKUP_OUTPUT_DIR" != "/" ]] || fail "refusing to inspect the filesystem root"

manifest_path="$BACKUP_OUTPUT_DIR/$BACKUP_MANIFEST"
[[ -f "$manifest_path" && ! -L "$manifest_path" ]] \
  || fail "selected backup manifest is missing or is a symbolic link"
manifest_path="$(readlink -f -- "$manifest_path")"
case "$manifest_path" in
  "$BACKUP_OUTPUT_DIR"/*) ;;
  *) fail "selected backup manifest resolves outside the backup directory" ;;
esac

schema_version="$(jq -r '.schemaVersion // empty' "$manifest_path")"
product="$(jq -r '.product // empty' "$manifest_path")"
recovery_point_at="$(jq -r '.createdAt // empty' "$manifest_path")"
archive_name="$(jq -r '.encryptedArchive // empty' "$manifest_path")"
archive_sha256="$(jq -r '.sha256 // empty' "$manifest_path")"
archive_bytes="$(jq -r '.encryptedBytes // empty' "$manifest_path")"
source_revision="$(jq -r '.sourceApplicationRevision // .applicationRevision // empty' "$manifest_path")"
backup_tool_revision="$(jq -r '.backupToolRevision // .applicationRevision // empty' "$manifest_path")"

[[ "$schema_version" == "1" && "$product" == "business-finlynq" ]] \
  || fail "selected manifest has an invalid schema or product"
[[ "$recovery_point_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || fail "selected manifest has an invalid recovery-point timestamp"
[[ "$archive_name" =~ ^business_finlynq_[A-Za-z0-9_.-]+\.dump\.age$ ]] \
  || fail "selected manifest has an unsafe archive name"
[[ "$archive_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "selected manifest has an invalid archive checksum"
[[ "$archive_bytes" =~ ^[1-9][0-9]*$ ]] \
  || fail "selected manifest has an invalid encrypted byte count"
[[ "$source_revision" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ && ! "$source_revision" =~ ^0+$ ]] \
  || fail "selected manifest has an invalid source application revision"
[[ "$backup_tool_revision" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ && ! "$backup_tool_revision" =~ ^0+$ ]] \
  || fail "selected manifest has an invalid backup-tool revision"

offsite_evidence_verified=false
offsite_receipt_name=""
offsite_receipt_signature_name=""
offsite_accepted_at=""
offsite_signing_key_sha256=""
if [[ "$RESTORE_REQUIRE_OFFSITE_EVIDENCE" == "true" ]]; then
  : "${BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE:?BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE is required for production off-site evidence}"
  : "${BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256:?BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256 is required for production off-site evidence}"
  [[ "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256" =~ ^[a-f0-9]{64}$ \
    && ! "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256" =~ ^0+$ ]] \
    || fail "pinned receiver receipt public-key fingerprint is invalid"
  [[ -f "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" \
    && ! -L "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" \
    && -r "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" ]] \
    || fail "pinned receiver receipt public key is missing or unsafe"
  openssl pkey -pubin -in "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" -pubcheck -noout >/dev/null 2>&1 \
    || fail "pinned receiver receipt public key is invalid"
  openssl pkey -pubin -in "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" -text_pub -noout 2>/dev/null \
    | grep -Fqi 'ED25519' || fail "pinned receiver receipt public key must use Ed25519"
  offsite_signing_key_sha256="$(sha256sum "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" | awk '{print $1}')"
  [[ "$offsite_signing_key_sha256" == "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256" ]] \
    || fail "receiver receipt public key does not match its pinned fingerprint"

  offsite_receipt_name="${archive_name%.dump.age}.receiver-receipt.json"
  offsite_receipt_signature_name="$offsite_receipt_name.sig"
  offsite_receipt_path="$BACKUP_OUTPUT_DIR/$offsite_receipt_name"
  offsite_receipt_signature_path="$BACKUP_OUTPUT_DIR/$offsite_receipt_signature_name"
  [[ -f "$offsite_receipt_path" && ! -L "$offsite_receipt_path" && -s "$offsite_receipt_path" ]] \
    || fail "selected recovery point has no receiver-generated off-site acceptance receipt"
  [[ -f "$offsite_receipt_signature_path" && ! -L "$offsite_receipt_signature_path" \
    && "$(stat -c '%s' "$offsite_receipt_signature_path")" == "64" ]] \
    || fail "selected recovery point has no safe Ed25519 receiver-receipt signature"
  offsite_accepted_at="$(jq -r '.acceptedAt // empty' "$offsite_receipt_path")"
  jq -e \
    --arg manifest "$BACKUP_MANIFEST" \
    --arg createdAt "$recovery_point_at" \
    --arg archive "$archive_name" \
    --argjson bytes "$archive_bytes" \
    --arg sha256 "$archive_sha256" \
    --arg sourceRevision "$source_revision" \
    --arg toolRevision "$backup_tool_revision" \
    --arg signingKeySha256 "$offsite_signing_key_sha256" \
    'keys == ["acceptedAt", "backupToolRevision", "createdAt", "encryptedArchive", "encryptedBytes", "manifest", "product", "receiptType", "result", "schemaVersion", "sha256", "signatureAlgorithm", "signingKeySha256", "sourceApplicationRevision"]
      and .schemaVersion == 2
      and .product == "business-finlynq"
      and .receiptType == "offsite-receiver-acceptance"
      and .result == "accepted"
      and .signatureAlgorithm == "ed25519"
      and .signingKeySha256 == $signingKeySha256
      and (.acceptedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and .manifest == $manifest
      and .createdAt == $createdAt
      and .encryptedArchive == $archive
      and .encryptedBytes == $bytes
      and .sha256 == $sha256
      and .sourceApplicationRevision == $sourceRevision
      and .backupToolRevision == $toolRevision' "$offsite_receipt_path" >/dev/null \
    || fail "selected recovery point has an invalid off-site acceptance receipt"
  openssl pkeyutl -verify -rawin -pubin \
    -inkey "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" \
    -in "$offsite_receipt_path" \
    -sigfile "$offsite_receipt_signature_path" >/dev/null 2>&1 \
    || fail "selected recovery point has an invalid receiver-receipt signature"
  offsite_evidence_verified=true
fi

started_epoch="$(date -u --date="$RESTORE_DRILL_STARTED_AT" +%s 2>/dev/null)" \
  || fail "restore start timestamp is not a real UTC date"
completed_epoch="$(date -u --date="$RESTORE_DRILL_COMPLETED_AT" +%s 2>/dev/null)" \
  || fail "restore completion timestamp is not a real UTC date"
recovery_point_epoch="$(date -u --date="$recovery_point_at" +%s 2>/dev/null)" \
  || fail "recovery-point timestamp is not a real UTC date"
(( recovery_point_epoch <= started_epoch )) \
  || fail "selected recovery point is later than the restore start"
if [[ "$offsite_evidence_verified" == "true" ]]; then
  offsite_accepted_epoch="$(date -u --date="$offsite_accepted_at" +%s 2>/dev/null)" \
    || fail "off-site acceptance timestamp is not a real UTC date"
  (( recovery_point_epoch <= offsite_accepted_epoch && offsite_accepted_epoch <= started_epoch )) \
    || fail "off-site acceptance timestamp is outside the recovery-point window"
fi
(( started_epoch <= completed_epoch )) \
  || fail "restore completion precedes its start"

recovery_point_age_seconds=$((started_epoch - recovery_point_epoch))
recovery_duration_seconds=$((completed_epoch - started_epoch))
checksum_prefix="${archive_sha256:0:12}"
matched_restore_report=""
matched_restore_verified_at=""

[[ ! -e "$RESTORE_REPORT_DIR" || ! -L "$RESTORE_REPORT_DIR" ]] \
  || fail "restore report directory is a symbolic link"
mkdir -p -- "$RESTORE_REPORT_DIR"
RESTORE_REPORT_DIR="$(cd -- "$RESTORE_REPORT_DIR" && pwd -P)"
case "$RESTORE_REPORT_DIR" in
  "$BACKUP_OUTPUT_DIR"/*) ;;
  *) fail "restore report directory resolves outside the backup directory" ;;
esac

while IFS= read -r -d '' candidate; do
  [[ ! -L "$candidate" ]] || continue
  candidate_sha="$(jq -r '.sha256 // empty' "$candidate" 2>/dev/null || true)"
  candidate_archive="$(jq -r '.encryptedArchive // empty' "$candidate" 2>/dev/null || true)"
  candidate_result="$(jq -r '.result // empty' "$candidate" 2>/dev/null || true)"
  candidate_verified_at="$(jq -r '.verifiedAt // empty' "$candidate" 2>/dev/null || true)"
  [[ "$candidate_sha" == "$archive_sha256" \
    && "$candidate_archive" == "$archive_name" \
    && "$candidate_result" == "restored-and-verified" \
    && "$candidate_verified_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || continue
  candidate_verified_epoch="$(date -u --date="$candidate_verified_at" +%s 2>/dev/null || true)"
  [[ "$candidate_verified_epoch" =~ ^[0-9]+$ \
    && "$candidate_verified_epoch" -ge "$started_epoch" \
    && "$candidate_verified_epoch" -le "$completed_epoch" ]] \
    || continue
  jq -e \
    '.checks.encryptedChecksum == true
      and .checks.archiveReadable == true
      and .checks.emptyDisposableTarget == true
      and .checks.transactionalRestore == true
      and .checks.applicationTables == true
      and .checks.organizationsTable == true
      and .checks.migrationHistory == true
      and (.applicationTableCount | type == "number" and . > 0)
      and (.migrationCount | type == "number" and . > 0)' \
    "$candidate" >/dev/null 2>&1 \
    || continue
  matched_restore_report="$(basename -- "$candidate")"
  matched_restore_verified_at="$candidate_verified_at"
  break
done < <(find "$RESTORE_REPORT_DIR" -maxdepth 1 -type f \
  -name "restore_*_${checksum_prefix}.json" -print0)

[[ -n "$matched_restore_report" ]] \
  || fail "no matching database-restore report with explicit passing checks exists for this drill window"

started_compact="${RESTORE_DRILL_STARTED_AT//-/}"
started_compact="${started_compact//:/}"
evidence_id="${started_compact}_${checksum_prefix}"
key_report_name="key-recovery_${evidence_id}.json"
accounting_report_name="accounting-prebootstrap_${evidence_id}.json"
runtime_report_name="runtime_${evidence_id}.json"
key_report_path="$RESTORE_REPORT_DIR/$key_report_name"
accounting_report_path="$RESTORE_REPORT_DIR/$accounting_report_name"
runtime_report_path="$RESTORE_REPORT_DIR/$runtime_report_name"
for evidence_report in "$key_report_path" "$accounting_report_path" "$runtime_report_path"; do
  [[ -f "$evidence_report" && ! -L "$evidence_report" ]] \
    || fail "required key/runtime evidence report is missing or is a symbolic link"
done

key_verified_at="$(jq -r '.verifiedAt // empty' "$key_report_path")"
accounting_verified_at="$(jq -r '.verifiedAt // empty' "$accounting_report_path")"
runtime_verified_at="$(jq -r '.verifiedAt // empty' "$runtime_report_path")"
jq -e \
  --arg sha256 "$archive_sha256" \
  --arg archive "$archive_name" \
  --argjson allowDiagnostic "$RESTORE_ALLOW_EMPTY_SECRET_FIXTURES" \
  '.schemaVersion == 1
    and .product == "business-finlynq"
    and .sha256 == $sha256
    and .encryptedArchive == $archive
    and .checks.wrappedOrganizationKeys == true
    and .checks.encryptedKeyCoverage == true
    and (.counts.wrappedOrganizationKeys | type == "number" and . > 0)
    and (.counts.encryptedOrganizationsMissingKeys | type == "number" and . == 0)
    and (.counts.encryptedIdentities | type == "number" and . >= 0)
    and (.counts.syntheticDemoIdentities | type == "number" and . >= 0)
    and (.counts.encryptedPartyNames | type == "number" and . >= 0)
    and (.counts.encryptedPartyAddresses | type == "number" and . >= 0)
    and (.counts.encryptedBankingFields | type == "number" and . >= 0)
    and .checks.encryptedIdentityDecryption == (.counts.encryptedIdentities > 0)
    and .checks.encryptedPartyDecryption == (.counts.encryptedPartyNames > 0)
    and .checks.encryptedAddressDecryption == (.counts.encryptedPartyAddresses > 0)
    and .checks.encryptedBankingDecryption == (.counts.encryptedBankingFields > 0)
    and ([
      if .counts.encryptedIdentities == 0 then "identity" else empty end,
      if .counts.encryptedPartyNames == 0 then "party-name" else empty end,
      if .counts.encryptedPartyAddresses == 0 then "party-address" else empty end
    ] as $expectedMissing
      | .diagnosticMissingRepresentatives == $expectedMissing
      and (
        (
          .result == "verified"
          and .checks.diagnosticEscapeUsed == false
          and ($expectedMissing | length) == 0
        )
        or (
          .result == "verified-diagnostic"
          and $allowDiagnostic
          and .checks.diagnosticEscapeUsed == true
          and ($expectedMissing | length) > 0
        )
      ))' \
  "$key_report_path" >/dev/null \
  || fail "key-recovery evidence did not pass its explicit checks"
key_report_result="$(jq -r '.result' "$key_report_path")"
key_recovery_verified=false
key_recovery_diagnostic=false
if [[ "$key_report_result" == "verified" ]]; then
  key_recovery_verified=true
else
  key_recovery_diagnostic=true
fi
jq -e \
  --arg sha256 "$archive_sha256" \
  --arg archive "$archive_name" \
  '.schemaVersion == 1
    and .product == "business-finlynq"
    and .result == "verified"
    and .phase == "post-grants-pre-bootstrap"
    and .sha256 == $sha256
    and .encryptedArchive == $archive
    and .checks.auditHashContract == true
    and .checks.auditHashRecomputation == true
    and .checks.auditOutboxIntegrity == true
    and .counts.status == "verified"
    and .counts.auditHashContractErrors == 0
    and .counts.auditHashMismatches == 0
    and .counts.integrityErrors == 0' \
  "$accounting_report_path" >/dev/null \
  || fail "pre-bootstrap accounting evidence did not pass its explicit checks"
jq -e \
  --arg sha256 "$archive_sha256" \
  --arg archive "$archive_name" \
  --arg drillStartedAt "$RESTORE_DRILL_STARTED_AT" \
  '.schemaVersion == 1
    and .product == "business-finlynq"
    and .result == "verified"
    and .sha256 == $sha256
    and .encryptedArchive == $archive
    and .drillStartedAt == $drillStartedAt
    and .checks.applicationReadiness == true
    and .checks.demoSession == true
    and .checks.applicationAcl == true
    and .checks.authenticationWorkerAcl == true
    and .checks.backupRoleAcl == true
    and .checks.auditOutboxIntegrity == true' \
  "$runtime_report_path" >/dev/null \
  || fail "restored-runtime evidence did not pass its explicit checks"

for evidence_verified_at in "$key_verified_at" "$accounting_verified_at" "$runtime_verified_at"; do
  [[ "$evidence_verified_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$ ]] \
    || fail "key/runtime evidence has an invalid verification timestamp"
  evidence_verified_epoch="$(date -u --date="$evidence_verified_at" +%s 2>/dev/null || true)"
  [[ "$evidence_verified_epoch" =~ ^[0-9]+$ \
    && "$evidence_verified_epoch" -ge "$started_epoch" \
    && "$evidence_verified_epoch" -le "$completed_epoch" ]] \
    || fail "component evidence is outside this drill window"
done
accounting_verified_epoch="$(date -u --date="$accounting_verified_at" +%s 2>/dev/null)"
key_verified_epoch="$(date -u --date="$key_verified_at" +%s 2>/dev/null)"
runtime_verified_epoch="$(date -u --date="$runtime_verified_at" +%s 2>/dev/null)"
(( accounting_verified_epoch <= key_verified_epoch \
  && key_verified_epoch <= runtime_verified_epoch )) \
  || fail "restore evidence ordering does not prove pre-bootstrap accounting verification"

rpo_met=false
rto_met=false
(( recovery_point_age_seconds < RESTORE_RPO_SECONDS )) && rpo_met=true
(( recovery_duration_seconds <= RESTORE_RTO_SECONDS )) && rto_met=true
result="verified-diagnostic-no-offsite"
production_recovery_evidence=false
if [[ "$key_recovery_diagnostic" == "true" ]]; then
  result="verified-diagnostic-empty-secret-fixtures"
  if [[ "$offsite_evidence_verified" != "true" ]]; then
    result="verified-diagnostic-no-offsite-empty-secret-fixtures"
  fi
elif [[ "$offsite_evidence_verified" == "true" ]]; then
  production_recovery_evidence=true
  result="verified-objectives-missed"
  [[ "$rpo_met" == "true" && "$rto_met" == "true" ]] && result="verified-objectives-met"
fi

report_timestamp="${RESTORE_DRILL_COMPLETED_AT//-/}"
report_timestamp="${report_timestamp//:/}"
report_name="restore-rehearsal_${report_timestamp}_${checksum_prefix}.json"
report_path="$RESTORE_REPORT_DIR/$report_name"
partial_report="$RESTORE_REPORT_DIR/.${report_name}.partial.$$"
cleanup() {
  rm -f -- "$partial_report"
}
trap cleanup EXIT INT TERM
[[ ! -e "$report_path" ]] || fail "refusing to overwrite an existing restore evidence report"

jq -n \
  --arg result "$result" \
  --arg startedAt "$RESTORE_DRILL_STARTED_AT" \
  --arg completedAt "$RESTORE_DRILL_COMPLETED_AT" \
  --arg recoveryPointAt "$recovery_point_at" \
  --arg archive "$archive_name" \
  --arg sha256 "$archive_sha256" \
  --arg sourceRevision "$source_revision" \
  --arg backupToolRevision "$backup_tool_revision" \
  --arg recoveryRevision "$BUSINESS_FINLYNQ_IMAGE_REVISION" \
  --arg recoveryAppImageId "$RESTORE_APP_IMAGE_ID" \
  --arg recoveryMigratorImageId "$RESTORE_MIGRATOR_IMAGE_ID" \
  --arg recoveryOperationsImageId "$RESTORE_OPERATIONS_IMAGE_ID" \
  --arg offsiteReceipt "$offsite_receipt_name" \
  --arg offsiteReceiptSignature "$offsite_receipt_signature_name" \
  --arg offsiteReceiptSigningKeySha256 "$offsite_signing_key_sha256" \
  --arg offsiteAcceptedAt "$offsite_accepted_at" \
  --arg restoreVerifiedAt "$matched_restore_verified_at" \
  --arg restoreReport "$matched_restore_report" \
  --arg keyVerifiedAt "$key_verified_at" \
  --arg keyReport "$key_report_name" \
  --arg preBootstrapAccountingVerifiedAt "$accounting_verified_at" \
  --arg preBootstrapAccountingReport "$accounting_report_name" \
  --arg runtimeVerifiedAt "$runtime_verified_at" \
  --arg runtimeReport "$runtime_report_name" \
  --argjson recoveryPointAgeSeconds "$recovery_point_age_seconds" \
  --argjson recoveryDurationSeconds "$recovery_duration_seconds" \
  --argjson rpoSeconds "$RESTORE_RPO_SECONDS" \
  --argjson rtoSeconds "$RESTORE_RTO_SECONDS" \
  --argjson rpoMet "$rpo_met" \
  --argjson rtoMet "$rto_met" \
  --argjson offsiteEvidenceVerified "$offsite_evidence_verified" \
  --argjson keyRecoveryVerified "$key_recovery_verified" \
  --argjson keyRecoveryDiagnostic "$key_recovery_diagnostic" \
  --argjson productionRecoveryEvidence "$production_recovery_evidence" \
  '{
    schemaVersion: 1,
    product: "business-finlynq",
    result: $result,
    productionRecoveryEvidence: $productionRecoveryEvidence,
    startedAt: $startedAt,
    completedAt: $completedAt,
    selectedRecoveryPointAt: $recoveryPointAt,
    recoveryPointAgeSeconds: $recoveryPointAgeSeconds,
    recoveryDurationSeconds: $recoveryDurationSeconds,
    objectives: {
      rpoSeconds: $rpoSeconds,
      rtoSeconds: $rtoSeconds,
      recoveryPointObjectiveMet: $rpoMet,
      recoveryTimeObjectiveMet: $rtoMet
    },
    encryptedArchive: $archive,
    sha256: $sha256,
    sourceApplicationRevision: $sourceRevision,
    backupToolRevision: $backupToolRevision,
    recoveryApplicationRevision: $recoveryRevision,
    recoveryImages: {
      app: $recoveryAppImageId,
      migrator: $recoveryMigratorImageId,
      operations: $recoveryOperationsImageId
    },
    offSiteAcceptanceReceipt: (if $offsiteReceipt == "" then null else $offsiteReceipt end),
    offSiteAcceptanceReceiptSignature: (if $offsiteReceiptSignature == "" then null else $offsiteReceiptSignature end),
    offSiteReceiptSigningKeySha256: (if $offsiteReceiptSigningKeySha256 == "" then null else $offsiteReceiptSigningKeySha256 end),
    offSiteAcceptedAt: (if $offsiteAcceptedAt == "" then null else $offsiteAcceptedAt end),
    databaseRestoreVerifiedAt: $restoreVerifiedAt,
    databaseRestoreReport: $restoreReport,
    keyRecoveryVerifiedAt: $keyVerifiedAt,
    keyRecoveryReport: $keyReport,
    preBootstrapAccountingVerifiedAt: $preBootstrapAccountingVerifiedAt,
    preBootstrapAccountingReport: $preBootstrapAccountingReport,
    restoredRuntimeVerifiedAt: $runtimeVerifiedAt,
    restoredRuntimeReport: $runtimeReport,
    checks: {
      encryptedArchive: true,
      offSiteRecoveryPoint: $offsiteEvidenceVerified,
      offSiteReceiptSignature: $offsiteEvidenceVerified,
      databaseRestore: true,
      forwardMigrations: true,
      roleReconciliation: true,
      keyRecovery: $keyRecoveryVerified,
      diagnosticKeyRecovery: $keyRecoveryDiagnostic,
      preBootstrapAuditOutboxIntegrity: true,
      auditOutboxIntegrity: true,
      restoredRuntime: true
    }
  }' >"$partial_report"
chmod 0600 -- "$partial_report"
mv -- "$partial_report" "$report_path"

if [[ "$rpo_met" != "true" || "$rto_met" != "true" ]]; then
  fail "restore completed but missed a recorded recovery objective; evidence=$report_name"
fi

if [[ "$production_recovery_evidence" != "true" ]]; then
  printf 'Restore diagnostic completed without production recovery evidence: result=%s report=%s\n' \
    "$result" "$report_name"
  exit 0
fi

printf 'Restore evidence passed: recovery_point_age_seconds=%s recovery_duration_seconds=%s report=%s\n' \
  "$recovery_point_age_seconds" "$recovery_duration_seconds" "$report_name"
