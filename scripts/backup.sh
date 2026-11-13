#!/bin/sh
# Offline snapshot, including optional services already running. No paid service is required.
set -eu
umask 077
cd "$(dirname "$0")/.."
command -v docker >/dev/null
command -v python3 >/dev/null
stamp=$(date -u +%Y%m%dT%H%M%SZ)
output=${1:-"$PWD/.local/backups/$stamp"}
case "$output" in /*) ;; *) printf 'Use um destino absoluto.\n' >&2; exit 1 ;; esac
test ! -e "$output" || { printf 'Backup já existe; nada foi substituído.\n' >&2; exit 1; }
container=$(docker compose ps -a -q harmony)
test -n "$container" || { printf 'Instância Harmony não encontrada.\n' >&2; exit 1; }
running=$(docker compose --profile public --profile sfu ps --status running --services)
mkdir -p .local/backups
raw=$(mktemp -d "$PWD/.local/backups/staging-XXXXXX")
resume() {
  for service in $running; do
    case "$service" in harmony|livekit|caddy) docker compose --profile public --profile sfu start "$service" >/dev/null || true ;; esac
  done
}
trap resume EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
docker compose --profile public --profile sfu stop caddy harmony livekit
# docker cp works on a stopped container and gives the local user the copy.
docker cp "$container:/data/." "$raw/"
mkdir -p "$(dirname "$output")"
python3 scripts/data-backup.py create --data "$raw" --output "$output" --environment .env --deploy .local/deploy
python3 scripts/data-backup.py verify --backup "$output"
python3 - "$raw" <<'PY'
from pathlib import Path
import shutil,sys
path=Path(sys.argv[1]).resolve()
assert path.parent == (Path.cwd()/'.local/backups').resolve() and path.name.startswith('staging-')
shutil.rmtree(path)
PY
if test -n "${RESTIC_REPOSITORY:-}"; then
  : "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE for the configured repository}"
  restic backup "$output" --tag harmony --tag "$stamp"
  restic check
fi
printf 'Backup verificado em %s. Contém credenciais; mantenha privado ou criptografado.\n' "$output"
