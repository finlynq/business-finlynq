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
