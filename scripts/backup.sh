#!/bin/sh
# Consistent, encrypted backup on the dedicated Linux Compose host.
set -eu
umask 077
cd "$(dirname "$0")/.."
: "${RESTIC_REPOSITORY:?Set an independent restic repository; never use the server data disk}"
: "${RESTIC_PASSWORD_FILE:?Set the path to the restic password outside this repository}"
command -v restic >/dev/null
command -v docker >/dev/null
test -r "$RESTIC_PASSWORD_FILE"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
stage=".local/backups/$stamp"
mkdir -p "$stage"
running=$(docker compose ps --status running --services)
restore_services() {
  for service in $running; do
    case "$service" in api|caddy|livekit|storage|media-worker) docker compose --profile public start "$service" >/dev/null || true ;; esac
  done
}
trap restore_services EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
# Freeze every public writer, including outstanding presigned PUTs, before dumping.
docker compose --profile public stop caddy api media-worker livekit storage
docker compose exec -T postgres pg_dump -U harmony -d harmony --format=custom > "$stage/postgres.dump"
docker compose run --rm --no-deps -T --entrypoint tar storage -C /data -czf - . > "$stage/storage.tar.gz"
cp .env "$stage/environment"
cp -R .local/deploy "$stage/deploy"
git rev-parse HEAD > "$stage/commit.txt"
restic backup "$stage" --tag harmony --tag "$stamp"
restic check
printf 'Backup criptografado concluído: %s. Ensaie a restauração antes de confiar no destino.\n' "$stamp"
printf 'Staging privado mantido em %s; remova após conferir o snapshot e sua política de retenção.\n' "$stage"
