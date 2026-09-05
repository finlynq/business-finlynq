#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository="/home/deploy/business-finlynq-development"
readonly expected_origin="https://github.com/finlynq/business-finlynq.git"
readonly configuration_directory="/etc/business-finlynq-development"
readonly secret_directory="$configuration_directory/secrets"
readonly compose_environment="$configuration_directory/compose.env"
readonly state_directory="/var/lib/business-finlynq-development"
readonly development_edge_network="business_finlynq_development_edge"
readonly deploy_target="/usr/local/sbin/business-finlynq-deploy-development"
readonly service_target="/etc/systemd/system/business-finlynq-development-deployment.service"
readonly timer_target="/etc/systemd/system/business-finlynq-development-deployment.timer"
readonly sudoers_target="/etc/sudoers.d/business-finlynq-development-deployment"

fail() {
  printf 'Business Finlynq development installation failed: %s\n' "$*" >&2
  exit 1
}

enable_timer=false
enable_all_features=false
yahoo_fx_mode=""
auth_email_from=""
auth_email_reply_to=""
turnstile_site_key=""
while (( $# > 0 )); do
  case "$1" in
    --enable)
      enable_timer=true
      shift
      ;;
    --enable-all-features)
      enable_all_features=true
      shift
      ;;
    --enable-yahoo-fx-experimental)
      yahoo_fx_mode="true"
      shift
      ;;
    --disable-yahoo-fx)
      yahoo_fx_mode="false"
      shift
      ;;
    --auth-email-from)
      [[ "$#" -ge 2 ]] || fail "--auth-email-from requires a mailbox"
      auth_email_from="$2"
      shift 2
      ;;
    --auth-email-reply-to)
      [[ "$#" -ge 2 ]] || fail "--auth-email-reply-to requires a mailbox"
      auth_email_reply_to="$2"
      shift 2
      ;;
    --turnstile-site-key)
      [[ "$#" -ge 2 ]] || fail "--turnstile-site-key requires a public site key"
      turnstile_site_key="$2"
      shift 2
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

if [[ "$enable_all_features" != true ]] \
  && [[ -n "$auth_email_from" || -n "$auth_email_reply_to" || -n "$turnstile_site_key" ]]; then
  fail "provider metadata requires --enable-all-features"
fi

[[ "$(id -u)" == 0 ]] || fail "run this installer as root"
for command_name in awk chmod chown docker getent git id install mktemp mv openssl rm runuser \
  stat sync systemctl visudo; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
for source_file in deploy-development.sh business-finlynq-development-deployment.service \
  business-finlynq-development-deployment.timer; do
  [[ -f "$script_directory/$source_file" && ! -L "$script_directory/$source_file" ]] \
    || fail "installer source is unavailable: $source_file"
done
getent passwd deploy >/dev/null || fail "the deploy account is unavailable"
getent group business-finlynq-secrets >/dev/null \
  || fail "the business-finlynq-secrets group is unavailable"
secret_gid="$(getent group business-finlynq-secrets | awk -F: '{print $3}')"
[[ "$secret_gid" =~ ^[0-9]+$ ]] || fail "the deployment secret-group GID is invalid"

if [[ ! -e "$repository" ]]; then
  [[ -d /home/deploy && ! -L /home/deploy \
    && "$(stat -c '%U:%G' -- /home/deploy)" == deploy:deploy ]] \
    || fail "the deploy home is unavailable or unsafe"
  runuser -u deploy -- /usr/bin/env -i \
    HOME=/home/deploy USER=deploy LOGNAME=deploy SHELL=/bin/bash \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git clone --branch dev --single-branch --no-tags "$expected_origin" "$repository"
fi
[[ -d "$repository/.git" && ! -L "$repository" \
  && "$(stat -c '%U:%G' -- "$repository")" == deploy:deploy ]] \
  || fail "the development checkout is unavailable or unsafe"
development_origin="$(runuser -u deploy -- git -C "$repository" remote get-url origin)"
development_branch="$(runuser -u deploy -- git -C "$repository" symbolic-ref --short HEAD)"
[[ "$development_origin" == "$expected_origin" && "$development_branch" == dev ]] \
  || fail "the development checkout is not the reviewed dev branch"

install -d -o root -g deploy -m 0750 -- "$configuration_directory"
install -d -o root -g business-finlynq-secrets -m 0750 -- "$secret_directory"
install -d -o root -g root -m 0700 -- "$state_directory"

if [[ ! -e "$compose_environment" ]]; then
  owner_password="$(openssl rand -hex 32)"
  app_password="$(openssl rand -hex 32)"
  auth_worker_password="$(openssl rand -hex 32)"
  backup_password="$(openssl rand -hex 32)"
  initial_revision="$(runuser -u deploy -- git -C "$repository" rev-parse HEAD)"
  [[ "$initial_revision" =~ ^[a-f0-9]{40}$ && ! "$initial_revision" =~ ^0+$ ]] \
    || fail "the initial development revision is invalid"

  environment_temporary="$(mktemp "$configuration_directory/.compose.env.XXXXXX")"
  {
    printf 'POSTGRES_PASSWORD=%s\n' "$owner_password"
    printf 'APP_DATABASE_PASSWORD_FILE=%s/app-db-password\n' "$secret_directory"
    printf 'AUTH_WORKER_DATABASE_PASSWORD_FILE=%s/auth-worker-db-password\n' "$secret_directory"
    printf 'BACKUP_DATABASE_PASSWORD_FILE=%s/backup-db-password\n' "$secret_directory"
    printf 'ORGANIZATION_ROOT_KEK_FILE=%s/organization-root-kek\n' "$secret_directory"
    printf 'IDENTITY_SECRET_FILE=%s/identity-secret\n' "$secret_directory"
    printf 'BUSINESS_FINLYNQ_SECRET_GID=%s\n' "$secret_gid"
    printf 'BUSINESS_FINLYNQ_HOSTNAME=dev.business.finlynq.com\n'
    printf 'BUSINESS_FINLYNQ_DEVELOPMENT_HOSTNAME=dev.business.finlynq.com\n'
    printf 'BUSINESS_FINLYNQ_APP_ORIGIN=https://dev.business.finlynq.com\n'
    printf 'BUSINESS_FINLYNQ_APP_PORT=3200\n'
    printf 'BUSINESS_FINLYNQ_APP_NETWORK_ALIAS=development-app\n'
    printf 'BUSINESS_FINLYNQ_PGDATA_VOLUME=business_finlynq_development_pgdata\n'
    printf 'BUSINESS_FINLYNQ_CADDY_DATA_VOLUME=business_finlynq_development_caddy_data\n'
    printf 'BUSINESS_FINLYNQ_CADDY_CONFIG_VOLUME=business_finlynq_development_caddy_config\n'
    printf 'BUSINESS_FINLYNQ_PRIVATE_NETWORK=business_finlynq_development_private\n'
    printf 'BUSINESS_FINLYNQ_EGRESS_NETWORK=business_finlynq_development_egress\n'
    printf 'BUSINESS_FINLYNQ_EDGE_NETWORK=business_finlynq_development_edge\n'
    printf 'BUSINESS_FINLYNQ_RESTORE_DRILL_NETWORK=business_finlynq_development_restore_drill\n'
    printf 'TRUSTED_PROXY_HOPS=1\n'
    printf 'SESSION_COOKIE_NAME=__Host-business_finlynq_development_session\n'
    printf 'DEMO_LOGIN_ENABLED=true\n'
    printf 'DEMO_WRITES_ENABLED=true\n'
    printf 'ACCOUNT_LOGIN_ENABLED=false\n'
    printf 'ACCOUNT_SIGNUP_ENABLED=false\n'
    printf 'AUTH_EMAIL_DELIVERY_ENABLED=false\n'
    printf 'SIGNUP_TURNSTILE_ENABLED=false\n'
    printf 'BUSINESS_WRITES_ENABLED=true\n'
    printf 'BANK_FEEDS_ENABLED=false\n'
    printf 'YAHOO_FX_ENABLED=false\n'
    printf 'DOCUMENT_INBOX_MAX_DEPTH=8\n'
    printf 'DOCUMENT_INBOX_MAX_PROVIDER_CALLS=10\n'
    printf 'DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE=false\n'
    printf 'BUSINESS_FINLYNQ_IMAGE_REVISION=%s\n' "$initial_revision"
  } >"$environment_temporary"
  install -o root -g deploy -m 0600 -- "$environment_temporary" "$compose_environment"
  rm -f -- "$environment_temporary"

  root_key_temporary="$(mktemp "$secret_directory/.organization-root-kek.XXXXXX")"
  identity_temporary="$(mktemp "$secret_directory/.identity-secret.XXXXXX")"
  printf '%s\n' "$(openssl rand -base64 32)" >"$root_key_temporary"
  openssl rand 64 | openssl base64 -A >"$identity_temporary"
  printf '\n' >>"$identity_temporary"
  printf '%s\n' "$app_password" >"$secret_directory/app-db-password"
  printf '%s\n' "$auth_worker_password" >"$secret_directory/auth-worker-db-password"
  printf '%s\n' "$backup_password" >"$secret_directory/backup-db-password"
  mv -f -- "$root_key_temporary" "$secret_directory/organization-root-kek"
  mv -f -- "$identity_temporary" "$secret_directory/identity-secret"
  chown root:business-finlynq-secrets "$secret_directory"/*
  chmod 0440 "$secret_directory"/*
  unset owner_password app_password auth_worker_password backup_password
fi

[[ -f "$compose_environment" && ! -L "$compose_environment" \
  && "$(stat -c '%U:%G:%a' -- "$compose_environment")" == root:deploy:600 ]] \
  || fail "the development Compose environment is unavailable or unsafe"
for secret_file in organization-root-kek identity-secret app-db-password \
  auth-worker-db-password backup-db-password; do
  [[ -f "$secret_directory/$secret_file" && ! -L "$secret_directory/$secret_file" \
    && "$(stat -c '%U:%G:%a' -- "$secret_directory/$secret_file")" \
      == root:business-finlynq-secrets:440 ]] \
    || fail "a development secret is unavailable or unsafe: $secret_file"
done

if [[ "$enable_all_features" == true ]]; then
  [[ -n "$auth_email_from" && "${#auth_email_from}" -le 320 \
    && "$auth_email_from" == *@* && "$auth_email_from" != *"="* \
    && "$auth_email_from" != *$'\n'* && "$auth_email_from" != *$'\r'* ]] \
    || fail "--auth-email-from must be a valid single-line mailbox"
  if [[ -n "$auth_email_reply_to" ]]; then
    [[ "${#auth_email_reply_to}" -le 320 && "$auth_email_reply_to" == *@* \
      && "$auth_email_reply_to" != *"="* && "$auth_email_reply_to" != *$'\n'* \
      && "$auth_email_reply_to" != *$'\r'* ]] \
      || fail "--auth-email-reply-to must be a valid single-line mailbox"
  fi
  [[ "$turnstile_site_key" =~ ^[A-Za-z0-9_-]{10,200}$ ]] \
    || fail "--turnstile-site-key is invalid"

  for provider_secret in resend-api-key turnstile-secret-key; do
    [[ -f "$secret_directory/$provider_secret" \
      && -s "$secret_directory/$provider_secret" \
      && ! -L "$secret_directory/$provider_secret" \
      && "$(stat -c '%U:%G:%a' -- "$secret_directory/$provider_secret")" \
        == root:business-finlynq-secrets:440 ]] \
      || fail "a development provider secret is unavailable or unsafe: $provider_secret"
    awk 'NR != 1 || length($0) < 10 || length($0) > 4096 || index($0, "\r") { exit 1 }' \
      "$secret_directory/$provider_secret" \
      || fail "a development provider secret must contain exactly one value: $provider_secret"
  done

  feature_environment_temporary="$(mktemp "$configuration_directory/.compose.env.features.XXXXXX")"
  awk -F= \
    -v auth_email_from="$auth_email_from" \
    -v auth_email_reply_to="$auth_email_reply_to" \
    -v resend_key_file="$secret_directory/resend-api-key" \
    -v turnstile_site_key="$turnstile_site_key" \
    -v turnstile_key_file="$secret_directory/turnstile-secret-key" '
    BEGIN {
      keys[1] = "DEMO_LOGIN_ENABLED"
      keys[2] = "DEMO_WRITES_ENABLED"
      keys[3] = "ACCOUNT_LOGIN_ENABLED"
      keys[4] = "ACCOUNT_SIGNUP_ENABLED"
      keys[5] = "AUTH_EMAIL_DELIVERY_ENABLED"
      keys[6] = "AUTH_EMAIL_PROVIDER"
      keys[7] = "AUTH_EMAIL_FROM"
      keys[8] = "AUTH_EMAIL_REPLY_TO"
      keys[9] = "AUTH_RESEND_API_KEY_FILE"
      keys[10] = "SIGNUP_TURNSTILE_ENABLED"
      keys[11] = "SIGNUP_TURNSTILE_SITE_KEY"
      keys[12] = "TURNSTILE_SECRET_KEY_FILE"
      keys[13] = "BUSINESS_WRITES_ENABLED"
      keys[14] = "BANK_FEEDS_ENABLED"
      keys[15] = "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE"
      for (key_index = 1; key_index <= 15; key_index++) values[keys[key_index]] = "true"
      values["AUTH_EMAIL_PROVIDER"] = "resend"
      values["AUTH_EMAIL_FROM"] = auth_email_from
      values["AUTH_EMAIL_REPLY_TO"] = auth_email_reply_to
      values["AUTH_RESEND_API_KEY_FILE"] = resend_key_file
      values["SIGNUP_TURNSTILE_SITE_KEY"] = turnstile_site_key
      values["TURNSTILE_SECRET_KEY_FILE"] = turnstile_key_file
    }
    {
      key = $1
      if (key in values) {
        if (seen[key]++) exit 42
        print key "=" values[key]
        next
      }
      print
    }
    END {
      for (key_index = 1; key_index <= 15; key_index++) {
        key = keys[key_index]
        if (!seen[key]) print key "=" values[key]
      }
    }
  ' "$compose_environment" >"$feature_environment_temporary" \
    || {
      rm -f -- "$feature_environment_temporary"
      fail "could not enable the development feature gates"
    }
  chown root:deploy "$feature_environment_temporary"
  chmod 0600 "$feature_environment_temporary"
  mv -f -- "$feature_environment_temporary" "$compose_environment"
  sync -f -- "$compose_environment"
  printf 'Development account, write, bot-protection, and bank-feed gates enabled.\n'
fi

if [[ -n "$yahoo_fx_mode" ]]; then
  yahoo_environment_temporary="$(mktemp "$configuration_directory/.compose.env.yahoo-fx.XXXXXX")"
  awk -F= -v selected="$yahoo_fx_mode" '
    BEGIN { key = "YAHOO_FX_ENABLED" }
    {
      if ($1 == key) {
        if (seen++) exit 42
        print key "=" selected
        next
      }
      print
    }
    END { if (!seen) print key "=" selected }
  ' "$compose_environment" >"$yahoo_environment_temporary"     || {
      rm -f -- "$yahoo_environment_temporary"
      fail "could not update the development Yahoo FX gate"
    }
  chown root:deploy "$yahoo_environment_temporary"
  chmod 0600 "$yahoo_environment_temporary"
  mv -f -- "$yahoo_environment_temporary" "$compose_environment"
  sync -f -- "$compose_environment"
  printf 'Development Yahoo FX experimental gate set to %s.\n' "$yahoo_fx_mode"
fi

if ! docker network inspect "$development_edge_network" >/dev/null 2>&1; then
  docker network create --driver bridge --label com.business-finlynq.environment=development \
    "$development_edge_network" >/dev/null
fi
network_driver="$(docker network inspect --format '{{.Driver}}' "$development_edge_network")"
network_scope="$(docker network inspect --format '{{.Scope}}' "$development_edge_network")"
network_label="$(docker network inspect --format '{{ index .Labels "com.business-finlynq.environment" }}' \
  "$development_edge_network")"
[[ "$network_driver" == bridge && "$network_scope" == local && "$network_label" == development ]] \
  || fail "the development edge network has an unexpected driver, scope, or ownership label"

install -d -o root -g root -m 0755 -- /usr/local/sbin
install -o root -g root -m 0550 -- "$script_directory/deploy-development.sh" "$deploy_target"
install -o root -g root -m 0644 \
  -- "$script_directory/business-finlynq-development-deployment.service" "$service_target"
install -o root -g root -m 0644 \
  -- "$script_directory/business-finlynq-development-deployment.timer" "$timer_target"

sudoers_temporary="$(mktemp /etc/sudoers.d/.business-finlynq-development.XXXXXX)"
printf '%s\n' \
  'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl start business-finlynq-development-deployment.service, /usr/bin/systemctl status business-finlynq-development-deployment.service --no-pager, /usr/bin/journalctl -u business-finlynq-development-deployment.service --since today --no-pager' \
  >"$sudoers_temporary"
chmod 0440 "$sudoers_temporary"
visudo -cf "$sudoers_temporary" >/dev/null
install -o root -g root -m 0440 -- "$sudoers_temporary" "$sudoers_target"
rm -f -- "$sudoers_temporary"

systemctl daemon-reload
if [[ "$enable_timer" == true ]]; then
  systemctl enable --now business-finlynq-development-deployment.timer
  printf 'Development deployment timer enabled.\n'
else
  printf 'Development deployment installed but left disabled.\n'
fi
printf 'Development checkout, secrets, environment, network, service, and restricted deploy access are ready.\n'
