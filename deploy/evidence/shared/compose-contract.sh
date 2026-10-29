# shellcheck shell=bash
# Caller has already validated the protected environment and exact source tree.
# These arrays are the only additional Compose inputs; no eval/source of env data.
scanner_compose_contract() {
  local scanner_environment="$1" scanner_project="$2" scanner_root="$3"
  local scanner_count
  scanner_files=()
  scanner_environment_values=()
  scanner_count="$(awk -F= '$1 == "BUSINESS_FINLYNQ_SCANNER_MODE" { n++ } END { print n+0 }' "$scanner_environment")" || return 1
  [[ "$scanner_count" == 0 || "$scanner_count" == 1 ]] || return 1
  scanner_mode="$(awk -F= '$1 == "BUSINESS_FINLYNQ_SCANNER_MODE" { sub(/^[^=]*=/, ""); print }' "$scanner_environment")" || return 1
  scanner_mode="${scanner_mode:-local}"
  case "$scanner_mode" in
    local) return 0 ;;
    shared) ;;
    *) return 1 ;;
  esac
  case "$scanner_project" in
    business-finlynq) scanner_channel=business_prod ;;
    business-finlynq-development) scanner_channel=business_stage ;;
    business-finlynq-dev) scanner_channel=business_dev ;;
    business-finlynq-rehearsal-*) scanner_channel=business_stage ;;
    business-finlynq-build-*) scanner_channel=business_stage ;;
    *) return 1 ;;
  esac
  scanner_files=(-f "$scanner_root/deploy/evidence/shared/business-relay.yml")
  scanner_environment_values=("FINLYNQ_SCANNER_CHANNEL=$scanner_channel")
}

# Rehearsal cleanup owns every resource except the exact read-only staging
# scanner socket. Never accept another external volume or network, even when
# its name happens to use this run's prefix.
scanner_rehearsal_resources() {
  local rendered="$1" project="$2"
  [[ "$project" =~ ^business-finlynq-rehearsal-[a-z0-9-]+$ ]] || return 1
  jq -er --arg project "$project" '
    if .volumes | has("shared_scanner_channel") then
      if .services.evidence_scanner.image ==
          "node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf" and
        .volumes.shared_scanner_channel.external == true and
        .volumes.shared_scanner_channel.name == "finlynq_scanner_business_stage_v1" and
        (.services.evidence_scanner.volumes | length) == 1 and
        .services.evidence_scanner.volumes[0].type == "volume" and
        .services.evidence_scanner.volumes[0].source == "shared_scanner_channel" and
        .services.evidence_scanner.volumes[0].target == "/run/finlynq-scanner" and
        .services.evidence_scanner.volumes[0].read_only == true and
        .services.evidence_scanner.volumes[0].volume.nocopy == true and
        all(.services | to_entries[]; .key == "evidence_scanner" or
          all(.value.volumes[]?; .source != "shared_scanner_channel"))
      then del(.volumes.shared_scanner_channel)
      else error("invalid rehearsal scanner channel") end
    else . end |
    [.volumes[], .networks[]] |
    if length > 0 and all(.[];
      (.external // false) == false and (.name | startswith($project + "-")))
    then .[].name else error("rehearsal resources are not run-isolated") end
  ' <<<"$rendered"
}
