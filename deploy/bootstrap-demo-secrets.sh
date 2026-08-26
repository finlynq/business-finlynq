#!/bin/sh
set -eu

project_dir=${1:-"$(pwd)"}
env_file="$project_dir/.env"
secret_dir=${BUSINESS_FINLYNQ_SECRET_DIR:-"$HOME/.config/business-finlynq"}
secret_file="$secret_dir/organization-root-kek"

if [ -e "$env_file" ] || [ -e "$secret_file" ]; then
  echo "Refusing to replace an existing Compose environment or organization root key." >&2
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
secret_gid=$(id -g)

{
  printf 'POSTGRES_PASSWORD=%s\n' "$owner_password"
  printf 'APP_DATABASE_PASSWORD=%s\n' "$app_password"
  printf 'BUSINESS_FINLYNQ_HOSTNAME=business.finlynq.com\n'
  printf 'BUSINESS_WRITES_ENABLED=false\n'
  printf 'ORGANIZATION_ROOT_KEK_FILE=%s\n' "$secret_file"
  printf 'BUSINESS_FINLYNQ_SECRET_GID=%s\n' "$secret_gid"
} > "$env_file"

openssl rand -base64 32 > "$secret_file"
chmod 0600 "$env_file"
chmod 0440 "$secret_file"

unset owner_password app_password

printf 'Created %s and %s without printing secret values.\n' "$env_file" "$secret_file"
