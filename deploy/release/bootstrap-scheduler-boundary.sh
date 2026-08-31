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

if ! source_revision="$(git -c safe.directory="$repository_root" -C "$repository_root" \
  rev-parse HEAD 2>/dev/null)"; then
  fail "the deployed source revision could not be inspected"
fi
[[ "$source_revision" =~ ^[a-f0-9]{40}$ && ! "$source_revision" =~ ^0+$ ]] \
  || fail "the deployed source revision is invalid"
[[ "$source_revision" != "$candidate_revision" ]] \
  || fail "the one-time bootstrap must run before the candidate is checked out"
if ! checkout_status="$(git -c safe.directory="$repository_root" -C "$repository_root" \
  status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
  fail "the deployed source checkout status could not be inspected"
fi
[[ -z "$checkout_status" ]] || fail "the deployed source checkout is not clean"
git -c safe.directory="$repository_root" -C "$repository_root" \
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
  git -c safe.directory="$repository_root" -C "$repository_root" \
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
[[ ! -e "$installed_boundary_file" && ! -L "$installed_boundary_file" ]] \
  || fail "the one-time scheduler boundary is already recorded as installed"

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

[[ "${SCHEDULER_BOUNDARY_BOOTSTRAP_ACK:-}" \
  == "pause-before-checkout:$source_revision:$candidate_revision:$scheduler_mode" ]] \
  || fail "SCHEDULER_BOUNDARY_BOOTSTRAP_ACK must acknowledge source, candidate, and scheduler"

readonly deployed_schedule="$repository_root/deploy/cron/managed-crontab"
[[ -f "$deployed_schedule" && ! -L "$deployed_schedule" ]] \
  || fail "the deployed cron schedule is missing or symbolic"
if [[ "$scheduler_mode" == "cron" ]]; then
  bash "$candidate_source_root/deploy/release/pause-schedulers.sh" cron \
    --expected-cron-schedule "$deployed_schedule"
else
  bash "$candidate_source_root/deploy/release/pause-schedulers.sh" systemd \
    --expected-cron-schedule "$deployed_schedule"
fi

temporary_receipt="$(mktemp "$state_directory/.scheduler-boundary-bootstrap.XXXXXX")"
cleanup() {
  rm -f -- "${temporary_receipt:-}"
}
trap cleanup EXIT INT TERM
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
sync -f -- "$state_directory"
trap - EXIT INT TERM

printf 'Schedulers are durably paused before checkout transition from %s to %s (%s).\n' \
  "$source_revision" "$candidate_revision" "$scheduler_mode"
printf '%s\n' 'Keep the maintenance marker in place, check out the candidate, and run the reviewed release command.'
