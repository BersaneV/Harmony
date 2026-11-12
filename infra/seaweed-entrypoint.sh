#!/bin/sh
# Keep the host secret private while the upstream image drops to UID 1000.
set -eu
umask 077
test "$(id -u)" = 0 || { printf 'Secret initialization requires container root.\n' >&2; exit 1; }
mkdir -p /run/harmony
cp /etc/harmony/s3-source.json /run/harmony/s3.json
chown 1000:1000 /run/harmony /run/harmony/s3.json
chmod 700 /run/harmony
chmod 400 /run/harmony/s3.json
exec /entrypoint.sh "$@"
