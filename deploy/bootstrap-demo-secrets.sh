#!/bin/sh
set -eu

project_dir=${1:-"$(pwd)"}
env_file="$project_dir/.env"
secret_dir=${BUSINESS_FINLYNQ_SECRET_DIR:-"$HOME/.config/business-finlynq"}
organization_secret_file="$secret_dir/organization-root-kek"
identity_secret_file="$secret_dir/identity-secret"
app_password_file="$secret_dir/app-db-password"
auth_worker_password_file="$secret_dir/auth-worker-db-password"

if [ -e "$env_file" ] || [ -e "$organization_secret_file" ] || [ -e "$identity_secret_file" ] || [ -e "$app_password_file" ] || [ -e "$auth_worker_password_file" ]; then
  echo "Refusing to replace an existing Compose environment or deployment secret." >&2
  exit 1
fi

command -v openssl >/dev/null 2>&1 || {
  echo "openssl is required to generate deployment secrets." >&2
  exit 1
}

umask 077
mkdir -p "$secret_dir"

owner_password=$(openssl rand -hex 32)
app_password=$(openssl rand -hex 32)
auth_worker_password=$(openssl rand -hex 32)
secret_gid=$(id -g)

{
  printf 'POSTGRES_PASSWORD=%s\n' "$owner_password"
  printf 'APP_DATABASE_PASSWORD_FILE=%s\n' "$app_password_file"
  printf 'BUSINESS_FINLYNQ_HOSTNAME=business.finlynq.com\n'
  printf 'DEMO_LOGIN_ENABLED=true\n'
  printf 'ACCOUNT_LOGIN_ENABLED=false\n'
  printf 'BUSINESS_WRITES_ENABLED=false\n'
  printf 'SESSION_COOKIE_NAME=__Host-business_finlynq_session\n'
  printf 'ORGANIZATION_ROOT_KEK_FILE=%s\n' "$organization_secret_file"
  printf 'IDENTITY_SECRET_FILE=%s\n' "$identity_secret_file"
  printf 'AUTH_WORKER_DATABASE_PASSWORD_FILE=%s\n' "$auth_worker_password_file"
  printf 'BUSINESS_FINLYNQ_SECRET_GID=%s\n' "$secret_gid"
} > "$env_file"

openssl rand -base64 32 > "$organization_secret_file"
openssl rand 64 | openssl base64 -A > "$identity_secret_file"
printf '\n' >> "$identity_secret_file"
printf '%s\n' "$app_password" > "$app_password_file"
printf '%s\n' "$auth_worker_password" > "$auth_worker_password_file"
chmod 0600 "$env_file"
chmod 0440 "$organization_secret_file" "$identity_secret_file" "$app_password_file" "$auth_worker_password_file"

unset owner_password app_password auth_worker_password

printf 'Created %s, two encryption secrets, and independent app/auth-worker database credentials without printing secret values.\n' "$env_file"
