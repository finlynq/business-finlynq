#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly repository="/home/deploy/business-finlynq"
readonly configuration_directory="/etc/business-finlynq/rehearsals"
readonly evidence_root="/var/lib/business-finlynq/rehearsal-evidence"
readonly host_lock="/var/lib/business-finlynq/deployment-host.lock"
readonly pair_verifier="$repository/scripts/operations/verify-release-rehearsals.mjs"
readonly clean_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

fail() {
  printf 'Business Finlynq initial rehearsals failed: %s\n' "$*" >&2
  exit 1
}

checked_utc_timestamp() {
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 1
  [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || return 1
  printf '%s' "$timestamp"
}

checked_file_sha256() {
  local selected_file="$1" checksum_output digest remainder
  checksum_output="$(sha256sum -- "$selected_file")" || return 1
  read -r digest remainder <<<"$checksum_output" || return 1
  [[ "$digest" =~ ^[a-f0-9]{64}$ && -n "$remainder" ]] || return 1
  printf '%s' "$digest"
}

docker() {
  env -i PATH="$clean_path" docker "$@"
}

revision=""
host_lock_fd=""
batch_id=""
verify_report=""
while (( $# > 0 )); do
  case "$1" in
    --revision|--host-lock-fd|--batch-id|--verify-report)
      (( $# >= 2 )) || fail "$1 requires a value"
      case "$1" in
        --revision) revision="$2" ;;
        --host-lock-fd) host_lock_fd="$2" ;;
        --batch-id) batch_id="$2" ;;
        --verify-report) verify_report="$2" ;;
      esac
      shift 2
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ "$(id -u)" == 0 ]] || fail "run this helper as root"
[[ "$revision" =~ ^[a-f0-9]{40}$ && ! "$revision" =~ ^0+$ ]] \
  || fail "--revision must be a non-zero full 40-character Git SHA"
[[ ( "$batch_id" =~ ^[0-9]{16}$ && -z "$verify_report" ) \
  || ( -z "$batch_id" && -n "$verify_report" ) ]] \
  || fail "select exactly one new --batch-id or existing --verify-report"
[[ "$host_lock_fd" =~ ^[3-9]$ && -e "/proc/self/fd/$host_lock_fd" \
  && "$(readlink -f -- "/proc/self/fd/$host_lock_fd")" == "$host_lock" ]] \
  || fail "--host-lock-fd must identify the inherited shared deployment lock"
flock --exclusive --nonblock "$host_lock_fd" \
  || fail "the inherited shared deployment lock is not held"

for command_name in awk bash chmod chown date docker env flock git id install jq mktemp \
  readlink rm sha256sum stat sync; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
repository_revision="$(git --no-optional-locks -c safe.directory="$repository" \
  -c core.hooksPath=/dev/null -C "$repository" rev-parse HEAD)" \
  || fail "canonical production checkout revision could not be inspected"
repository_status="$(git --no-optional-locks -c safe.directory="$repository" \
  -c core.hooksPath=/dev/null -C "$repository" \
  status --porcelain=v1 --untracked-files=all)" \
  || fail "canonical production checkout status could not be inspected"
[[ "$repository_revision" == "$revision" && -z "$repository_status" ]] \
  || fail "canonical production checkout is not the clean rehearsal revision"
[[ -f "$pair_verifier" && ! -L "$pair_verifier" ]] \
  || fail "the reviewed rehearsal pair verifier is unavailable"
pair_verifier_sha256="$(checked_file_sha256 "$pair_verifier")" \
  || fail "the reviewed rehearsal pair verifier checksum could not be read"
[[ "$pair_verifier_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "the reviewed rehearsal pair verifier hash is invalid"
[[ -d "$configuration_directory" && ! -L "$configuration_directory" \
  && "$(stat -c '%U:%G:%a' -- "$configuration_directory")" == root:deploy:750 ]] \
  || fail "protected rehearsal configuration directory is unavailable"
[[ -d "$evidence_root" && ! -L "$evidence_root" \
  && "$(stat -c '%U:%G:%a' -- "$evidence_root")" == root:root:700 ]] \
  || fail "rehearsal evidence root is unavailable"

declare -a run_ids=()
declare -a environments=(
  "$configuration_directory/first.env"
  "$configuration_directory/second.env"
)
declare -a evidence_directories=()

if [[ -n "$verify_report" ]]; then
  [[ "$verify_report" == "$configuration_directory"/accepted-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].json \
    && -f "$verify_report" && ! -L "$verify_report" \
    && "$(readlink -f -- "$verify_report")" == "$verify_report" \
    && "$(stat -c '%U:%G:%a' -- "$verify_report")" == root:root:600 ]] \
    || fail "existing rehearsal acceptance report is unavailable or unsafe"
  batch_id="$(jq -er '.batchId' "$verify_report")" \
    || fail "existing rehearsal acceptance report has no batch ID"
  [[ "$batch_id" =~ ^[0-9]{16}$ ]] || fail "existing rehearsal batch ID is invalid"
  jq -e --arg revision "$revision" --arg batchId "$batch_id" '
    type == "object" and
    keys == ["acceptedAt", "batchId", "product", "rehearsals", "revision",
      "schemaVersion", "verifier"] and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .revision == $revision and .batchId == $batchId and
    (.acceptedAt | type == "string") and
    (.verifier | type == "object" and
      keys == ["imageId", "sourceSha256"] and
      (.imageId | test("^sha256:[a-f0-9]{64}$")) and
      (.sourceSha256 | test("^[a-f0-9]{64}$"))) and
    (.rehearsals | type == "array" and length == 2 and
      all(.[]; type == "object" and
        keys == ["checksumInventorySha256", "evidenceDirectory", "runId"] and
        (.checksumInventorySha256 | test("^[a-f0-9]{64}$"))))
  ' "$verify_report" >/dev/null \
    || fail "existing rehearsal acceptance report has an invalid identity"
  run_ids=(
    "$(jq -er '.rehearsals[0].runId' "$verify_report")"
    "$(jq -er '.rehearsals[1].runId' "$verify_report")"
  )
  [[ "${run_ids[0]}" == "rehearsal-a-$batch_id" \
    && "${run_ids[1]}" == "rehearsal-b-$batch_id" ]] \
    || fail "existing rehearsal acceptance report has unexpected run IDs"
  for index in 0 1; do
    evidence_directory="$evidence_root/$revision/${run_ids[$index]}"
    evidence_inventory_sha="$(checked_file_sha256 "$evidence_directory/SHA256SUMS")" \
      || fail "existing rehearsal checksum inventory could not be read"
    recorded_inventory_sha="$(jq -er --argjson index "$index" \
      '.rehearsals[$index].checksumInventorySha256' "$verify_report")" \
      || fail "existing rehearsal report has no checksum inventory identity"
    [[ "$(jq -er --argjson index "$index" '.rehearsals[$index].evidenceDirectory' \
      "$verify_report")" == "$evidence_directory" \
      && -d "$evidence_directory" && ! -L "$evidence_directory" \
      && "$(stat -c '%u:%a' -- "$evidence_directory")" == 0:700 \
      && "$evidence_inventory_sha" == "$recorded_inventory_sha" ]] \
      || fail "existing rehearsal evidence differs from its acceptance report"
    evidence_directories+=("$evidence_directory")
  done
else
  run_ids=("rehearsal-a-$batch_id" "rehearsal-b-$batch_id")
  for index in 0 1; do
    environment_file="${environments[$index]}"
    run_id="${run_ids[$index]}"
    [[ -f "$environment_file" && ! -L "$environment_file" \
      && "$(stat -c '%U:%G:%a' -- "$environment_file")" == root:deploy:600 ]] \
      || fail "rehearsal environment is unavailable or unsafe: $environment_file"
    evidence_directory="$evidence_root/$revision/$run_id"
    [[ ! -e "$evidence_directory" && ! -L "$evidence_directory" ]] \
      || fail "immutable rehearsal evidence already exists: $run_id"
    export RELEASE_EXECUTION_ACK="rehearsal:$revision:$run_id"
    bash "$repository/deploy/release/run-release.sh" \
      --mode rehearsal \
      --revision "$revision" \
      --environment "$environment_file" \
      --evidence-root "$evidence_root" \
      --run-id "$run_id" \
      --host-lock-fd "$host_lock_fd"
    unset RELEASE_EXECUTION_ACK
    evidence_directories+=("$evidence_directory")
  done
fi

first_acceptance_image="$(jq -er \
  '.images[] | select(.name == "acceptance") | .imageId' \
  "${evidence_directories[0]}/11-images.json")" \
  || fail "the first rehearsal lacks an acceptance image ID"
second_acceptance_image="$(jq -er \
  '.images[] | select(.name == "acceptance") | .imageId' \
  "${evidence_directories[1]}/11-images.json")" \
  || fail "the second rehearsal lacks an acceptance image ID"
[[ "$first_acceptance_image" =~ ^sha256:[a-f0-9]{64}$ \
  && "$first_acceptance_image" == "$second_acceptance_image" ]] \
  || fail "the two rehearsals did not use one immutable acceptance image"
if [[ -n "$verify_report" ]]; then
  jq -e --arg imageId "$first_acceptance_image" \
    --arg sourceSha256 "$pair_verifier_sha256" '
      .verifier.imageId == $imageId and .verifier.sourceSha256 == $sourceSha256
    ' "$verify_report" >/dev/null \
    || fail "existing rehearsal report is not bound to the current reviewed verifier"
fi
[[ "$(docker image inspect --format \
  '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "$first_acceptance_image")" == "$revision" ]] \
  || fail "the rehearsal verifier image does not carry the reviewed revision"

# The immutable Playwright acceptance image supplies Node; the host deliberately
# does not. Only the verifier and two protected evidence trees are mounted, all
# read-only, with networking and capabilities disabled.
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 256m --cpus 0.50 \
  --user 0:0 --tmpfs /tmp:size=16m,mode=1777,noexec,nosuid,nodev \
  --mount "type=bind,src=$pair_verifier,dst=/verification/verify-release-rehearsals.mjs,readonly" \
  --mount "type=bind,src=${evidence_directories[0]},dst=/verification/first,readonly" \
  --mount "type=bind,src=${evidence_directories[1]},dst=/verification/second,readonly" \
  --entrypoint node \
  "$first_acceptance_image" /verification/verify-release-rehearsals.mjs \
  /verification/first /verification/second \
  || fail "the contained rehearsal pair verifier rejected the evidence"
current_pair_verifier_sha256="$(checked_file_sha256 "$pair_verifier")" \
  || fail "the reviewed rehearsal verifier checksum could not be reread"
repository_revision="$(git --no-optional-locks -c safe.directory="$repository" \
  -c core.hooksPath=/dev/null -C "$repository" rev-parse HEAD)" \
  || fail "canonical production checkout revision could not be reinspected"
repository_status="$(git --no-optional-locks -c safe.directory="$repository" \
  -c core.hooksPath=/dev/null -C "$repository" \
  status --porcelain=v1 --untracked-files=all)" \
  || fail "canonical production checkout status could not be reinspected"
[[ "$current_pair_verifier_sha256" == "$pair_verifier_sha256" \
  && "$repository_revision" == "$revision" && -z "$repository_status" ]] \
  || fail "the reviewed checkout or pair verifier changed during evidence verification"

if [[ -n "$verify_report" ]]; then
  printf 'Existing isolated rehearsal acceptance reverified: %s\n' "$verify_report"
  exit 0
fi

report="$configuration_directory/accepted-$batch_id.json"
[[ ! -e "$report" && ! -L "$report" ]] \
  || fail "immutable rehearsal acceptance report already exists"
report_temporary="$(mktemp "$configuration_directory/.accepted-$batch_id.XXXXXX")"
accepted_at="$(checked_utc_timestamp)" \
  || fail "rehearsal report timestamp could not be generated"
first_inventory_sha="$(checked_file_sha256 "${evidence_directories[0]}/SHA256SUMS")" \
  || fail "first rehearsal checksum inventory could not be read"
second_inventory_sha="$(checked_file_sha256 "${evidence_directories[1]}/SHA256SUMS")" \
  || fail "second rehearsal checksum inventory could not be read"
jq -n \
  --arg acceptedAt "$accepted_at" \
  --arg revision "$revision" \
  --arg batchId "$batch_id" \
  --arg verifierImageId "$first_acceptance_image" \
  --arg verifierSha256 "$pair_verifier_sha256" \
  --arg firstRunId "${run_ids[0]}" \
  --arg secondRunId "${run_ids[1]}" \
  --arg firstEvidence "${evidence_directories[0]}" \
  --arg secondEvidence "${evidence_directories[1]}" \
  --arg firstSha256 "$first_inventory_sha" \
  --arg secondSha256 "$second_inventory_sha" \
  '{schemaVersion: 1, product: "business-finlynq", acceptedAt: $acceptedAt,
    revision: $revision, batchId: $batchId,
    verifier: {imageId: $verifierImageId, sourceSha256: $verifierSha256},
    rehearsals: [
      {runId: $firstRunId, evidenceDirectory: $firstEvidence, checksumInventorySha256: $firstSha256},
      {runId: $secondRunId, evidenceDirectory: $secondEvidence, checksumInventorySha256: $secondSha256}
    ]}' >"$report_temporary"
chown root:root "$report_temporary"
chmod 0600 "$report_temporary"
mv -- "$report_temporary" "$report"
sync -f -- "$report"
sync -f -- "$configuration_directory"
printf 'Two isolated initial rehearsals accepted. Report: %s\n' "$report"
