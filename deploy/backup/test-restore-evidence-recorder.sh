#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

recorder="${RESTORE_EVIDENCE_RECORDER:-/usr/local/bin/business-finlynq-record-restore-evidence}"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/business-finlynq-restore-evidence.XXXXXX")"
recovery_revision="2222222222222222222222222222222222222222"
source_revision="1111111111111111111111111111111111111111"
receipt_signing_private_key="$fixture_root/receiver-receipt-signing-private.pem"
receipt_signing_public_key="$fixture_root/receiver-receipt-signing-public.pem"

for command_name in awk jq openssl sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required restore-evidence fixture command is unavailable: %s\n' "$command_name" >&2
    exit 2
  }
done
openssl genpkey -algorithm ED25519 -out "$receipt_signing_private_key"
openssl pkey -in "$receipt_signing_private_key" -pubout -out "$receipt_signing_public_key"
receipt_signing_public_key_sha256="$(sha256sum "$receipt_signing_public_key" | awk '{print $1}')"

cleanup() {
  case "$fixture_root" in
    "${TMPDIR:-/tmp}"/business-finlynq-restore-evidence.*) rm -rf -- "$fixture_root" ;;
    *) printf '%s\n' "Refusing to remove unexpected restore-evidence fixture" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

write_fixture() {
  local target_dir="$1"
  local sha256="$2"
  local recovery_point_at="$3"
  local started_at="$4"
  local completed_at="$5"
  local runtime_integrity="$6"
  local timestamp="${recovery_point_at//-/}"
  local started_compact="${started_at//-/}"
  local archive_name manifest_name receipt_name receipt_path evidence_id checksum_prefix
  timestamp="${timestamp//:/}"
  started_compact="${started_compact//:/}"
  archive_name="business_finlynq_${timestamp}_business_finlynq.dump.age"
  manifest_name="business_finlynq_${timestamp}_business_finlynq.manifest.json"
  receipt_name="${archive_name%.dump.age}.receiver-receipt.json"
  receipt_path="$target_dir/$receipt_name"
  checksum_prefix="${sha256:0:12}"
  evidence_id="${started_compact}_${checksum_prefix}"
  mkdir -p -- "$target_dir/restore-reports"
  jq -n \
    --arg createdAt "$recovery_point_at" \
    --arg archive "$archive_name" \
    --arg sha256 "$sha256" \
    --arg revision "$source_revision" \
    '{
      schemaVersion: 1,
      product: "business-finlynq",
      createdAt: $createdAt,
      encryptedArchive: $archive,
      encryptedBytes: 1234,
      sha256: $sha256,
      applicationRevision: $revision,
      sourceApplicationRevision: $revision,
      backupToolRevision: $revision,
      payload: "must-not-be-copied"
    }' >"$target_dir/$manifest_name"
  jq -n \
    --arg acceptedAt "$(date -u --date="$recovery_point_at + 1 minute" +%Y-%m-%dT%H:%M:%SZ)" \
    --arg manifest "$manifest_name" \
    --arg createdAt "$recovery_point_at" \
    --arg archive "$archive_name" \
    --arg sha256 "$sha256" \
    --arg sourceRevision "$source_revision" \
    --arg signingKeySha256 "$receipt_signing_public_key_sha256" \
    '{
      schemaVersion: 2,
      product: "business-finlynq",
      receiptType: "offsite-receiver-acceptance",
      result: "accepted",
      signatureAlgorithm: "ed25519",
      signingKeySha256: $signingKeySha256,
      acceptedAt: $acceptedAt,
      manifest: $manifest,
      createdAt: $createdAt,
      encryptedArchive: $archive,
      encryptedBytes: 1234,
      sha256: $sha256,
      sourceApplicationRevision: $sourceRevision,
      backupToolRevision: $sourceRevision
    }' >"$receipt_path"
  openssl pkeyutl -sign -rawin \
    -inkey "$receipt_signing_private_key" \
    -in "$receipt_path" \
    -out "$receipt_path.sig"
  jq -n \
    --arg verifiedAt "$(date -u --date="$started_at + 10 seconds" +%Y-%m-%dT%H:%M:%SZ)" \
    --arg archive "$archive_name" \
    --arg sha256 "$sha256" \
    '{
      schemaVersion: 1,
      product: "business-finlynq",
      result: "restored-and-verified",
      verifiedAt: $verifiedAt,
      encryptedArchive: $archive,
      sha256: $sha256,
      applicationTableCount: 42,
      migrationCount: 32,
      checks: {
        encryptedChecksum: true,
        archiveReadable: true,
        emptyDisposableTarget: true,
        transactionalRestore: true,
        applicationTables: true,
        organizationsTable: true,
        migrationHistory: true
      },
      payload: "must-not-be-copied"
    }' >"$target_dir/restore-reports/restore_fixture_${checksum_prefix}.json"
  jq -n \
    --arg verifiedAt "$(date -u --date="$started_at + 30 seconds" +%Y-%m-%dT%H:%M:%S.000Z)" \
    --arg sha256 "$sha256" \
    --arg archive "$archive_name" \
    '{
      schemaVersion: 1,
      product: "business-finlynq",
      result: "verified",
      verifiedAt: $verifiedAt,
      sha256: $sha256,
      encryptedArchive: $archive,
      checks: {
        wrappedOrganizationKeys: true,
        encryptedKeyCoverage: true,
        encryptedIdentityDecryption: true,
        encryptedPartyDecryption: true,
        encryptedAddressDecryption: true,
        encryptedBankingDecryption: true,
        diagnosticEscapeUsed: false
      },
      counts: {
        wrappedOrganizationKeys: 2,
        encryptedOrganizationsMissingKeys: 0,
        encryptedIdentities: 1,
        syntheticDemoIdentities: 128,
        encryptedPartyNames: 4,
        encryptedPartyAddresses: 4,
        encryptedBankingFields: 8
      },
      diagnosticMissingRepresentatives: [],
      payload: "must-not-be-copied"
    }' >"$target_dir/restore-reports/key-recovery_${evidence_id}.json"
  jq -n \
    --arg verifiedAt "$(date -u --date="$started_at + 20 seconds" +%Y-%m-%dT%H:%M:%SZ)" \
    --arg sha256 "$sha256" \
    --arg archive "$archive_name" \
    '{
      schemaVersion: 1,
      product: "business-finlynq",
      result: "verified",
      verifiedAt: $verifiedAt,
      phase: "post-grants-pre-bootstrap",
      sha256: $sha256,
      encryptedArchive: $archive,
      checks: {
        auditHashContract: true,
        auditHashRecomputation: true,
        auditOutboxIntegrity: true
      },
      counts: {
        status: "verified",
        organizations: 2,
        auditEvents: 4,
        outboxEvents: 2,
        auditHashContractErrors: 0,
        auditHashMismatches: 0,
        integrityErrors: 0
      },
      payload: "must-not-be-copied"
    }' >"$target_dir/restore-reports/accounting-prebootstrap_${evidence_id}.json"
  jq -n \
    --arg verifiedAt "$(date -u --date="$started_at + 40 seconds" +%Y-%m-%dT%H:%M:%SZ)" \
    --arg startedAt "$started_at" \
    --arg sha256 "$sha256" \
    --arg archive "$archive_name" \
    --argjson runtimeIntegrity "$runtime_integrity" \
    '{
      schemaVersion: 1,
      product: "business-finlynq",
      result: "verified",
      verifiedAt: $verifiedAt,
      drillStartedAt: $startedAt,
      sha256: $sha256,
      encryptedArchive: $archive,
      checks: {
        applicationReadiness: true,
        demoSession: true,
        applicationAcl: true,
        authenticationWorkerAcl: true,
        backupRoleAcl: true,
        auditOutboxIntegrity: $runtimeIntegrity
      },
      payload: "must-not-be-copied"
    }' >"$target_dir/restore-reports/runtime_${evidence_id}.json"
  printf '%s|%s\n' "$manifest_name" "$evidence_id"
}

run_recorder() {
  local target_dir="$1"
  local manifest="$2"
  local started_at="$3"
  local completed_at="$4"
  local rpo_seconds="${5:-21600}"
  local rto_seconds="${6:-14400}"
  local require_offsite="${7:-true}"
  local allow_empty_secret_fixtures="${8:-false}"
  BACKUP_OUTPUT_DIR="$target_dir" \
  BACKUP_MANIFEST="$manifest" \
  RESTORE_DRILL_STARTED_AT="$started_at" \
  RESTORE_DRILL_COMPLETED_AT="$completed_at" \
  RESTORE_RPO_SECONDS="$rpo_seconds" \
  RESTORE_RTO_SECONDS="$rto_seconds" \
  RESTORE_REQUIRE_OFFSITE_EVIDENCE="$require_offsite" \
  RESTORE_ALLOW_EMPTY_SECRET_FIXTURES="$allow_empty_secret_fixtures" \
  BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE="$receipt_signing_public_key" \
  BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256="$receipt_signing_public_key_sha256" \
  BUSINESS_FINLYNQ_IMAGE_REVISION="$recovery_revision" \
  RESTORE_APP_IMAGE_ID="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  RESTORE_MIGRATOR_IMAGE_ID="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
  RESTORE_OPERATIONS_IMAGE_ID="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" \
    "$recorder"
}

start_at="2026-08-31T12:00:00Z"
complete_at="2026-08-31T12:02:00Z"
recovery_at="2026-08-31T11:00:00Z"
valid_dir="$fixture_root/valid"
IFS='|' read -r valid_manifest valid_evidence_id < <(
  write_fixture "$valid_dir" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    "$recovery_at" "$start_at" "$complete_at" true
)
run_recorder "$valid_dir" "$valid_manifest" "$start_at" "$complete_at" >/dev/null
valid_report="$valid_dir/restore-reports/restore-rehearsal_20260831T120200Z_aaaaaaaaaaaa.json"
jq -e --arg signingKeySha256 "$receipt_signing_public_key_sha256" '
  .result == "verified-objectives-met"
  and .productionRecoveryEvidence == true
  and .recoveryPointAgeSeconds == 3600
  and .recoveryDurationSeconds == 120
  and .objectives.recoveryPointObjectiveMet == true
  and .objectives.recoveryTimeObjectiveMet == true
  and .checks.auditOutboxIntegrity == true
  and .checks.preBootstrapAuditOutboxIntegrity == true
  and (.preBootstrapAccountingReport | startswith("accounting-prebootstrap_"))
  and .checks.offSiteRecoveryPoint == true
  and .checks.offSiteReceiptSignature == true
  and .offSiteAcceptanceReceipt == "business_finlynq_20260831T110000Z_business_finlynq.receiver-receipt.json"
  and .offSiteAcceptanceReceiptSignature == "business_finlynq_20260831T110000Z_business_finlynq.receiver-receipt.json.sig"
  and .offSiteReceiptSigningKeySha256 == $signingKeySha256
  and .offSiteAcceptedAt == "2026-08-31T11:01:00Z"
  and .recoveryImages.app == "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  and .recoveryImages.migrator == "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  and .recoveryImages.operations == "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  and (has("payload") | not)
' "$valid_report" >/dev/null
! grep -Fq "must-not-be-copied" "$valid_report"

local_diagnostic_dir="$fixture_root/local-diagnostic"
IFS='|' read -r local_diagnostic_manifest local_diagnostic_evidence_id < <(
  write_fixture "$local_diagnostic_dir" "acacacacacacacacacacacacacacacacacacacacacacacacacacacacacacacac" \
    "$recovery_at" "$start_at" "$complete_at" true
)
run_recorder "$local_diagnostic_dir" "$local_diagnostic_manifest" "$start_at" "$complete_at" \
  21600 14400 false >/dev/null
jq -e '
  .result == "verified-diagnostic-no-offsite"
  and .productionRecoveryEvidence == false
  and .checks.offSiteRecoveryPoint == false
  and .checks.offSiteReceiptSignature == false
  and .offSiteAcceptanceReceiptSignature == null
  and .offSiteReceiptSigningKeySha256 == null
' "$local_diagnostic_dir/restore-reports/restore-rehearsal_20260831T120200Z_acacacacacac.json" >/dev/null

unsigned_receipt_dir="$fixture_root/unsigned-receipt"
IFS='|' read -r unsigned_receipt_manifest unsigned_receipt_evidence_id < <(
  write_fixture "$unsigned_receipt_dir" "adadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadad" \
    "$recovery_at" "$start_at" "$complete_at" true
)
rm -f -- "$unsigned_receipt_dir/business_finlynq_20260831T110000Z_business_finlynq.receiver-receipt.json.sig"
if run_recorder "$unsigned_receipt_dir" "$unsigned_receipt_manifest" "$start_at" "$complete_at" \
  >/dev/null 2>&1; then
  printf '%s\n' "Restore evidence recorder accepted an unsigned receiver receipt for production" >&2
  exit 1
fi
[[ ! -e "$unsigned_receipt_dir/restore-reports/restore-rehearsal_20260831T120200Z_adadadadadad.json" ]]
run_recorder "$unsigned_receipt_dir" "$unsigned_receipt_manifest" "$start_at" "$complete_at" \
  21600 14400 false >/dev/null
jq -e '
  .result == "verified-diagnostic-no-offsite"
  and .productionRecoveryEvidence == false
  and .checks.offSiteReceiptSignature == false
' "$unsigned_receipt_dir/restore-reports/restore-rehearsal_20260831T120200Z_adadadadadad.json" >/dev/null

forged_receipt_dir="$fixture_root/forged-receipt"
IFS='|' read -r forged_receipt_manifest forged_receipt_evidence_id < <(
  write_fixture "$forged_receipt_dir" "aeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae" \
    "$recovery_at" "$start_at" "$complete_at" true
)
attacker_private_key="$fixture_root/attacker-receipt-signing-private.pem"
openssl genpkey -algorithm ED25519 -out "$attacker_private_key"
forged_receipt="$forged_receipt_dir/business_finlynq_20260831T110000Z_business_finlynq.receiver-receipt.json"
openssl pkeyutl -sign -rawin \
  -inkey "$attacker_private_key" \
  -in "$forged_receipt" \
  -out "$forged_receipt.sig"
if run_recorder "$forged_receipt_dir" "$forged_receipt_manifest" "$start_at" "$complete_at" \
  >/dev/null 2>&1; then
  printf '%s\n' "Restore evidence recorder accepted a receipt signed by an unpinned key" >&2
  exit 1
fi
[[ ! -e "$forged_receipt_dir/restore-reports/restore-rehearsal_20260831T120200Z_aeaeaeaeaeae.json" ]]

if run_recorder "$valid_dir" "$valid_manifest" "$start_at" "$complete_at" 21601 14400 \
  >/dev/null 2>&1; then
  printf '%s\n' "Restore evidence recorder accepted a weakened production RPO" >&2
  exit 1
fi
if run_recorder "$valid_dir" "$valid_manifest" "$start_at" "$complete_at" 21600 14401 \
  >/dev/null 2>&1; then
  printf '%s\n' "Restore evidence recorder accepted a weakened production RTO" >&2
  exit 1
fi

stale_dir="$fixture_root/stale"
IFS='|' read -r stale_manifest stale_evidence_id < <(
  write_fixture "$stale_dir" "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" \
    "2026-08-31T03:00:00Z" "$start_at" "$complete_at" true
)
if run_recorder "$stale_dir" "$stale_manifest" "$start_at" "$complete_at" >/dev/null 2>&1; then
  printf '%s\n' "Restore evidence recorder accepted an RPO breach" >&2
  exit 1
fi
jq -e '
  .result == "verified-objectives-missed"
  and .objectives.recoveryPointObjectiveMet == false
  and .objectives.recoveryTimeObjectiveMet == true
' "$stale_dir/restore-reports/restore-rehearsal_20260831T120200Z_cccccccccccc.json" >/dev/null

tampered_dir="$fixture_root/tampered"
IFS='|' read -r tampered_manifest tampered_evidence_id < <(
  write_fixture "$tampered_dir" "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" \
    "$recovery_at" "$start_at" "$complete_at" false
)
if run_recorder "$tampered_dir" "$tampered_manifest" "$start_at" "$complete_at" >/dev/null 2>&1; then
  printf '%s\n' "Restore evidence recorder accepted a failed audit/outbox check" >&2
  exit 1
fi
[[ ! -e "$tampered_dir/restore-reports/restore-rehearsal_20260831T120200Z_dddddddddddd.json" ]]

prebootstrap_tampered_dir="$fixture_root/prebootstrap-tampered"
IFS='|' read -r prebootstrap_tampered_manifest prebootstrap_tampered_evidence_id < <(
  write_fixture "$prebootstrap_tampered_dir" "abababababababababababababababababababababababababababababababab" \
    "$recovery_at" "$start_at" "$complete_at" true
)
prebootstrap_report="$prebootstrap_tampered_dir/restore-reports/accounting-prebootstrap_${prebootstrap_tampered_evidence_id}.json"
jq '.checks.auditHashRecomputation = false' "$prebootstrap_report" >"$prebootstrap_report.partial"
mv -- "$prebootstrap_report.partial" "$prebootstrap_report"
if run_recorder "$prebootstrap_tampered_dir" "$prebootstrap_tampered_manifest" "$start_at" "$complete_at" \
  >/dev/null 2>&1; then
  printf '%s\n' "Restore evidence recorder accepted failed pre-bootstrap accounting evidence" >&2
  exit 1
fi
[[ ! -e "$prebootstrap_tampered_dir/restore-reports/restore-rehearsal_20260831T120200Z_abababababab.json" ]]

diagnostic_key_dir="$fixture_root/diagnostic-key"
IFS='|' read -r diagnostic_key_manifest diagnostic_key_evidence_id < <(
  write_fixture "$diagnostic_key_dir" "bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc" \
    "$recovery_at" "$start_at" "$complete_at" true
)
diagnostic_key_report="$diagnostic_key_dir/restore-reports/key-recovery_${diagnostic_key_evidence_id}.json"
jq '.result = "verified-diagnostic"
  | .checks.encryptedIdentityDecryption = false
  | .checks.diagnosticEscapeUsed = true
  | .counts.encryptedIdentities = 0
  | .diagnosticMissingRepresentatives = ["identity"]' \
  "$diagnostic_key_report" >"$diagnostic_key_report.partial"
mv -- "$diagnostic_key_report.partial" "$diagnostic_key_report"
if run_recorder "$diagnostic_key_dir" "$diagnostic_key_manifest" "$start_at" "$complete_at" \
  >/dev/null 2>&1; then
  printf '%s\n' "Restore evidence recorder accepted diagnostic key evidence without the explicit escape" >&2
  exit 1
fi
[[ ! -e "$diagnostic_key_dir/restore-reports/restore-rehearsal_20260831T120200Z_bcbcbcbcbcbc.json" ]]
run_recorder "$diagnostic_key_dir" "$diagnostic_key_manifest" "$start_at" "$complete_at" \
  21600 14400 true true >/dev/null
jq -e '
  .result == "verified-diagnostic-empty-secret-fixtures"
  and .productionRecoveryEvidence == false
  and .checks.offSiteRecoveryPoint == true
  and .checks.offSiteReceiptSignature == true
  and .checks.keyRecovery == false
  and .checks.diagnosticKeyRecovery == true
' "$diagnostic_key_dir/restore-reports/restore-rehearsal_20260831T120200Z_bcbcbcbcbcbc.json" >/dev/null

database_tampered_dir="$fixture_root/database-tampered"
IFS='|' read -r database_tampered_manifest database_tampered_evidence_id < <(
  write_fixture "$database_tampered_dir" "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" \
    "$recovery_at" "$start_at" "$complete_at" true
)
database_report="$database_tampered_dir/restore-reports/restore_fixture_eeeeeeeeeeee.json"
jq '.checks.transactionalRestore = false' "$database_report" >"$database_report.partial"
mv -- "$database_report.partial" "$database_report"
if run_recorder "$database_tampered_dir" "$database_tampered_manifest" "$start_at" "$complete_at" \
  >/dev/null 2>&1; then
  printf '%s\n' "Restore evidence recorder accepted a failed database-restore check" >&2
  exit 1
fi
[[ ! -e "$database_tampered_dir/restore-reports/restore-rehearsal_20260831T120200Z_eeeeeeeeeeee.json" ]]

receipt_tampered_dir="$fixture_root/receipt-tampered"
IFS='|' read -r receipt_tampered_manifest receipt_tampered_evidence_id < <(
  write_fixture "$receipt_tampered_dir" "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" \
    "$recovery_at" "$start_at" "$complete_at" true
)
receipt_report="$receipt_tampered_dir/business_finlynq_20260831T110000Z_business_finlynq.receiver-receipt.json"
jq '.sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' \
  "$receipt_report" >"$receipt_report.partial"
mv -- "$receipt_report.partial" "$receipt_report"
if run_recorder "$receipt_tampered_dir" "$receipt_tampered_manifest" "$start_at" "$complete_at" \
  >/dev/null 2>&1; then
  printf '%s\n' "Restore evidence recorder accepted a mismatched receiver receipt" >&2
  exit 1
fi
[[ ! -e "$receipt_tampered_dir/restore-reports/restore-rehearsal_20260831T120200Z_ffffffffffff.json" ]]

printf '%s\n' "Restore evidence recorder fixture checks passed"
