#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly candidate_source_root="$(cd -- "$script_dir/../.." && pwd -P)"
readonly repository_root="/home/deploy/business-finlynq"
readonly state_directory="/home/deploy/.local/state/business-finlynq/release-locks"
readonly coordination_lock="$state_directory/production-release-rollback.lock"
readonly receipt_file="$state_directory/scheduler-boundary-bootstrap.json"
readonly installed_boundary_file="$state_directory/scheduler-boundary.json"

fail() {
  printf 'Business Finlynq scheduler-boundary bootstrap failed: %s\n' "$1" >&2
  exit 1
}

candidate_revision=""
scheduler_mode=""
while (( $# > 0 )); do
  case "$1" in
    --candidate-revision)
      (( $# >= 2 )) || fail "--candidate-revision requires a value"
      candidate_revision="$2"
      shift 2
      ;;
    --scheduler)
      (( $# >= 2 )) || fail "--scheduler requires a value"
      scheduler_mode="$2"
      shift 2
      ;;
    *) fail "unknown bootstrap option: $1" ;;
  esac
done

[[ "$candidate_revision" =~ ^[a-f0-9]{40}$ && ! "$candidate_revision" =~ ^0+$ ]] \
  || fail "--candidate-revision must be a non-zero full 40-character Git SHA"
[[ "$scheduler_mode" == "systemd" || "$scheduler_mode" == "cron" ]] \
  || fail "--scheduler must be systemd or cron"

for command_name in bash chmod chown cmp date flock git id jq mktemp mv readlink rm stat sync; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required bootstrap command is unavailable: $command_name"
done

case "$candidate_source_root" in
  /tmp/business-finlynq-release-bootstrap.*/repository) ;;
  *) fail "run the bootstrap only from a private candidate Git-archive tree" ;;
esac
[[ -d "$candidate_source_root" && ! -L "$candidate_source_root" \
  && "$(readlink -f -- "$candidate_source_root")" == "$candidate_source_root" ]] \
  || fail "candidate bootstrap tree is missing, symbolic, or resolved unexpectedly"
[[ -d "$repository_root/.git" && ! -L "$repository_root" ]] \
  || fail "the canonical deployed checkout is missing or symbolic"

if ! source_revision="$(git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
  rev-parse HEAD 2>/dev/null)"; then
  fail "the deployed source revision could not be inspected"
fi
[[ "$source_revision" =~ ^[a-f0-9]{40}$ && ! "$source_revision" =~ ^0+$ ]] \
  || fail "the deployed source revision is invalid"
[[ "$source_revision" != "$candidate_revision" ]] \
  || fail "the one-time bootstrap must run before the candidate is checked out"
if ! checkout_status="$(git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
  status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
  fail "the deployed source checkout status could not be inspected"
fi
[[ -z "$checkout_status" ]] || fail "the deployed source checkout is not clean"
git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
  cat-file -e "$candidate_revision^{commit}" 2>/dev/null \
  || fail "the candidate revision is not a local Git commit"

# Bind the executable bootstrap boundary to the exact candidate Git objects,
# even though it is intentionally invoked from an archive outside the live
# checkout before that checkout changes.
for relative_path in \
  deploy/release/bootstrap-scheduler-boundary.sh \
  deploy/release/pause-schedulers.sh \
  deploy/cron/remove.sh; do
  [[ -f "$candidate_source_root/$relative_path" && ! -L "$candidate_source_root/$relative_path" ]] \
    || fail "candidate bootstrap asset is missing or symbolic: $relative_path"
  git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
    show "$candidate_revision:$relative_path" \
    | cmp -s -- - "$candidate_source_root/$relative_path" \
    || fail "candidate bootstrap asset differs from the reviewed Git object: $relative_path"
done

deploy_uid="$(id -u deploy 2>/dev/null)" || fail "the deploy account is required"
if [[ "$scheduler_mode" == "systemd" ]]; then
  [[ "$(id -u)" == "0" ]] || fail "systemd bootstrap must run as root"
else
  [[ "$(id -un)" == "deploy" && "$(id -u)" == "$deploy_uid" ]] \
    || fail "cron bootstrap must run as the exact deploy account"
fi
[[ -d "$state_directory" && ! -L "$state_directory" \
  && "$(readlink -f -- "$state_directory")" == "$state_directory" \
  && "$(stat -c '%u:%a' -- "$state_directory")" == "$deploy_uid:700" ]] \
  || fail "release lock directory must be deploy-owned mode 0700"

[[ ! -L "$coordination_lock" ]] || fail "production coordination lock cannot be symbolic"
if [[ ! -e "$coordination_lock" ]]; then
  (umask 077; : >"$coordination_lock")
  if [[ "$(id -u)" == "0" ]]; then
    chown -- "$deploy_uid" "$coordination_lock"
  fi
fi
[[ -f "$coordination_lock" && ! -L "$coordination_lock" \
  && "$(stat -c '%u:%a' -- "$coordination_lock")" == "$deploy_uid:600" ]] \
  || fail "production coordination lock must be deploy-owned mode 0600"
exec 9>"$coordination_lock"
flock --exclusive --nonblock 9 \
  || fail "another production release, rollback, or boundary bootstrap is active"

[[ ! -e "$installed_boundary_file" && ! -L "$installed_boundary_file" ]] \
  || fail "the one-time scheduler boundary is already recorded as installed"

[[ "${SCHEDULER_BOUNDARY_BOOTSTRAP_ACK:-}" \
  == "pause-before-checkout:$source_revision:$candidate_revision:$scheduler_mode" ]] \
  || fail "SCHEDULER_BOUNDARY_BOOTSTRAP_ACK must acknowledge source, candidate, and scheduler"

readonly deployed_schedule="$repository_root/deploy/cron/managed-crontab"
[[ -f "$deployed_schedule" && ! -L "$deployed_schedule" ]] \
  || fail "the deployed cron schedule is missing or symbolic"

validate_protected_state_file() {
  local selected_file="$1" description="$2"
  [[ -f "$selected_file" && ! -L "$selected_file" \
    && "$(readlink -f -- "$selected_file")" == "$selected_file" \
    && "$(stat -c '%u:%a' -- "$selected_file")" == "$deploy_uid:600" ]] \
    || fail "$description must be a deploy-owned non-symbolic file with mode 0600"
}

retarget_existing_receipt="false"
existing_receipt_present="false"
existing_marker_present="false"
[[ -e "$receipt_file" || -L "$receipt_file" ]] && existing_receipt_present="true"
[[ -e "$state_directory/scheduler-maintenance" \
  || -L "$state_directory/scheduler-maintenance" ]] && existing_marker_present="true"

# A reviewed candidate can be superseded after the first pre-checkout pause.
# Reusing that pause is safe only when both protected artifacts still describe
# this unchanged source checkout and scheduler. Any partial or altered state is
# rejected instead of weakening the strict first-bootstrap drain.
if [[ "$existing_receipt_present" == "true" \
  || "$existing_marker_present" == "true" ]]; then
  [[ "$existing_receipt_present" == "true" \
    && "$existing_marker_present" == "true" ]] \
    || fail "a superseded-candidate retarget requires both the protected receipt and maintenance marker"

  readonly marker_file="$state_directory/scheduler-maintenance"
  validate_protected_state_file "$receipt_file" "existing bootstrap receipt"
  validate_protected_state_file "$marker_file" "existing scheduler maintenance marker"

  existing_candidate_revision="$(jq -e -r -s \
    --arg sourceRevision "$source_revision" \
    --arg candidateRevision "$candidate_revision" \
    --arg scheduler "$scheduler_mode" '
      if length == 1 and
        (.[0] |
          type == "object" and
          keys == [
            "candidateRevision",
            "pausedAt",
            "product",
            "scheduler",
            "schemaVersion",
            "sourceRevision"
          ] and
          .schemaVersion == 1 and
          .product == "business-finlynq" and
          .sourceRevision == $sourceRevision and
          .scheduler == $scheduler and
          (.candidateRevision | type == "string" and test("^[a-f0-9]{40}$")) and
          .candidateRevision != $sourceRevision and
          .candidateRevision != $candidateRevision and
          (.pausedAt | type == "string" and
            test("^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$")))
      then .[0].candidateRevision
      else empty
      end
    ' "$receipt_file")" \
    || fail "existing bootstrap receipt is invalid for a safe candidate retarget"
  [[ "$existing_candidate_revision" =~ ^[a-f0-9]{40}$ ]] \
    || fail "existing bootstrap receipt is invalid for a safe candidate retarget"
  git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
    cat-file -e "$existing_candidate_revision^{commit}" 2>/dev/null \
    || fail "the superseded bootstrap candidate is not a local Git commit"
  git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
    merge-base --is-ancestor "$existing_candidate_revision" "$candidate_revision" \
    || fail "the requested candidate does not descend from the superseded bootstrap candidate"

  marker_lines=()
  mapfile -t marker_lines <"$marker_file"
  [[ "${#marker_lines[@]}" -eq 2 \
    && "${marker_lines[0]}" =~ ^pausedAt=[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$ \
    && "${marker_lines[1]}" == "mode=$scheduler_mode" ]] \
    || fail "existing scheduler maintenance marker is invalid for a safe candidate retarget"
  retarget_existing_receipt="true"
fi

pause_arguments=("$scheduler_mode" --expected-cron-schedule "$deployed_schedule")
if [[ "$retarget_existing_receipt" == "true" ]]; then
  pause_arguments+=(--allow-already-paused)
fi
bash "$candidate_source_root/deploy/release/pause-schedulers.sh" "${pause_arguments[@]}"

[[ "$(git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" rev-parse HEAD)" \
  == "$source_revision" ]] \
  || fail "the deployed source checkout changed while establishing the scheduler boundary"

temporary_receipt="$(mktemp "$state_directory/.scheduler-boundary-bootstrap.XXXXXX")"
cleanup() {
  rm -f -- "${temporary_receipt:-}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
jq -n \
  --arg product business-finlynq \
  --arg sourceRevision "$source_revision" \
  --arg candidateRevision "$candidate_revision" \
  --arg scheduler "$scheduler_mode" \
  --arg pausedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{schemaVersion: 1, product: $product, sourceRevision: $sourceRevision, candidateRevision: $candidateRevision, scheduler: $scheduler, pausedAt: $pausedAt}' \
  >"$temporary_receipt"
chmod 0600 -- "$temporary_receipt"
if [[ "$(id -u)" == "0" ]]; then
  chown -- "$deploy_uid" "$temporary_receipt"
fi
[[ "$(stat -c '%u:%a' -- "$temporary_receipt")" == "$deploy_uid:600" ]] \
  || fail "bootstrap receipt temporary file has unsafe ownership or mode"
sync -f -- "$temporary_receipt"
mv -f -- "$temporary_receipt" "$receipt_file"
temporary_receipt=""
sync -f -- "$state_directory"
trap - EXIT INT TERM

if [[ "$retarget_existing_receipt" == "true" ]]; then
  printf 'Superseded scheduler-boundary candidate %s while schedulers remained paused.\n' \
    "$existing_candidate_revision"
fi
printf 'Schedulers are durably paused before checkout transition from %s to %s (%s).\n' \
  "$source_revision" "$candidate_revision" "$scheduler_mode"
printf '%s\n' 'Keep the maintenance marker in place, check out the candidate, and run the reviewed release command.'
