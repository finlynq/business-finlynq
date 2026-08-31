#!/usr/bin/env bash

# This library only evaluates timestamps. Callers must first authenticate the
# receipt that supplied recovery_point_at with the pinned receiver public key.
business_finlynq_recovery_point_age_seconds() {
  local recovery_point_at="${1:-}"
  local current_epoch="${2:-}"
  local recovery_point_epoch

  [[ "$recovery_point_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || return 1
  [[ "$current_epoch" =~ ^[0-9]+$ ]] || return 1
  recovery_point_epoch="$(date -u --date="$recovery_point_at" +%s 2>/dev/null)" \
    || return 1
  (( recovery_point_epoch <= current_epoch )) || return 1
  printf '%s' "$((current_epoch - recovery_point_epoch))"
}

business_finlynq_recovery_point_is_fresh() {
  local recovery_point_age_seconds="${1:-}"
  local maximum_age_hours="${2:-}"

  [[ "$recovery_point_age_seconds" =~ ^[0-9]+$ ]] || return 1
  [[ "$maximum_age_hours" =~ ^[1-9][0-9]*$ ]] || return 1
  (( recovery_point_age_seconds < maximum_age_hours * 3600 ))
}
