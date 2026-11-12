#!/bin/sh
# Restore into a new local directory only. Never starts or replaces a deployment.
set -eu
umask 077
cd "$(dirname "$0")/.."
backup=${1:?Usage: scripts/restore.sh /absolute/backup /absolute/new-instance}
destination=${2:?Choose a NEW local instance directory}
case "$backup:$destination" in /*:/*) ;; *) printf 'Use caminhos absolutos.\n' >&2; exit 1 ;; esac
python3 scripts/data-backup.py restore --backup "$backup" --output "$destination"
printf 'Dados, objetos e configuração restaurados em %s. Nenhum serviço foi iniciado.\n' "$destination"
printf 'Para Compose, importe data/ em um volume NOVO conforme docs/OPERATIONS.md; preserve a instância anterior.\n'
