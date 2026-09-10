#!/bin/sh
set -eu

readonly state_directory=/state
readonly state_file="$state_directory/mode"

fail() {
	printf 'Business Finlynq release router refused to start: %s\n' "$1" >&2
	exit 1
}

[ "$#" -eq 1 ] && [ "$1" = serve ] \
	|| fail "the immutable entrypoint contract was changed"
[ -d "$state_directory" ] && [ ! -L "$state_directory" ] \
	|| fail "the durable state volume is missing or unsafe"
[ "$(stat -c '%u:%g:%a' "$state_directory")" = 10001:10001:700 ] \
	|| fail "the durable state volume has unsafe ownership or mode"

mode=maintenance
state_valid=false
if [ -f "$state_file" ] && [ ! -L "$state_file" ] \
	&& [ "$(stat -c '%u:%g:%a' "$state_file")" = 10001:10001:600 ]; then
	mode="$(cat "$state_file")"
	case "$mode" in
		active|maintenance) state_valid=true ;;
	esac
fi

if [ "$state_valid" != true ]; then
	# Missing, malformed, or unexpected state always fails closed. Repair the
	# sentinel atomically so every later restart makes the same safe choice.
	mode=maintenance
	temporary="$state_directory/.mode.$$"
	trap 'rm -f -- "$temporary"' EXIT INT TERM
	rm -f -- "$state_file"
	printf '%s\n' "$mode" >"$temporary"
	chmod 0600 "$temporary"
	mv -f "$temporary" "$state_file"
	sync "$state_file" 2>/dev/null || sync
	sync -f "$state_directory" 2>/dev/null || sync
	trap - EXIT INT TERM
fi

case "$mode" in
	active)
		config=/etc/caddy/Caddyfile
		;;
	maintenance)
		config=/etc/caddy/Caddyfile.maintenance
		# A maintenance restart must never reuse or guess the deployer's preview
		# credential. Give the locked startup configuration a fresh process-local
		# value; the release runner supplies a different ephemeral value only when
		# it deliberately reloads maintenance for acceptance.
		lock_token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
		[ "${#lock_token}" -eq 64 ] \
			|| fail "a locked maintenance credential could not be generated"
		case "$lock_token" in
			*[!0-9a-f]*) fail "the locked maintenance credential is invalid" ;;
		esac
		export BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN="$lock_token"
		;;
esac

exec caddy run --config "$config" --adapter caddyfile
