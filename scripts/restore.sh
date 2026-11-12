#!/bin/sh
# Restore only into an empty, explicitly selected local Compose project.
set -eu
umask 077
cd "$(dirname "$0")/.."
backup=${1:?Usage: scripts/restore.sh /absolute/path/to/restored-backup}
project=${2:?Use a NEW Compose project name as the second argument}
case "$project" in *[!a-z0-9_-]*|"") printf 'Nome de projeto inválido.\n' >&2; exit 1 ;; esac
if test -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" || test -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"; then
  printf 'Projeto Compose já existe; escolha um destino novo.\n' >&2
  exit 1
fi
if docker ps --format '{{.Ports}}' | grep -q '15432'; then
  printf 'Porta15432 em uso. Restaure em outro host ou pare a instância conscientemente antes.\n' >&2
  exit 1
fi
export COMPOSE_PROJECT_NAME="$project"
case "$backup" in /*) ;; *) printf 'Use um caminho absoluto.\n' >&2; exit 1 ;; esac
test -s "$backup/postgres.dump"
test -s "$backup/storage.tar.gz"
test -s "$backup/environment"
if test -e .env || test -d .local/deploy; then
  printf 'Destino já configurado. Restaure em checkout novo para não sobrescrever dados/chaves.\n' >&2
  exit 1
fi
cp "$backup/environment" .env
python3 - <<'PY'
import os
from pathlib import Path
p = Path('.env')
lines = [line for line in p.read_text().splitlines() if not line.startswith('COMPOSE_PROJECT_NAME=')]
lines.append('COMPOSE_PROJECT_NAME=' + os.environ['COMPOSE_PROJECT_NAME'])
p.write_text('\n'.join(lines) + '\n')
PY
mkdir -p .local
cp -R "$backup/deploy" .local/deploy
docker compose up -d postgres
attempt=0
until docker compose exec -T postgres pg_isready -U harmony -d harmony >/dev/null; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 60 || exit 1
  sleep 1
done
count=$(docker compose exec -T postgres psql -U harmony -d harmony -Atc "select count(*) from information_schema.tables where table_schema='public'")
test "$count" = 0 || { printf 'Banco não está vazio; restauração recusada.\n' >&2; exit 1; }
docker compose run --rm --no-deps -T --entrypoint sh storage -c 'test -z "$(ls -A /data)"' || { printf 'Storage não está vazio.\n' >&2; exit 1; }
docker compose exec -T postgres pg_restore -U harmony -d harmony --exit-on-error --no-owner < "$backup/postgres.dump"
docker compose run --rm --no-deps -T --entrypoint tar storage -C /data -xzf - < "$backup/storage.tar.gz"
printf 'Banco e objetos restaurados. Serviços públicos continuam parados.\n'
printf 'Confira DNS, firewall e integridade; depois inicie com docker compose --profile public up -d.\n'
