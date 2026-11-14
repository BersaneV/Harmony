#!/bin/bash
# Native Altare startup; one verified Python runtime, no system installation.
set -eu
umask 077
cd /home/container
mkdir -p data
chmod 600 /home/container/harmony-config.json
install -m 600 /home/container/harmony-config.json /home/container/data/harmony-config.json
runtime=/home/container/.harmony-python-20261110
archive=/home/container/.harmony-python-20261110.tar.gz
expected=50c774f6674740739f791c05a9177ed03e2fe02abebda9bca3512eb7309b37cc
if [ ! -f "$archive" ]; then
  curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --max-filesize 104857600 --silent --show-error 'https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.13.18%2B20261110-x86_64-unknown-linux-gnu-install_only.tar.gz' -o "$archive.part"
  printf '%s  %s\n' "$expected" "$archive.part" | sha256sum -c -
  mv "$archive.part" "$archive"
fi
printf '%s  %s\n' "$expected" "$archive" | sha256sum -c -
if [ ! -x "$runtime/python/bin/python3" ]; then
  stage=$(mktemp -d /home/container/.harmony-python-install.XXXXXX)
  trap 'rm -rf "$stage"' EXIT
  # The archive is from the pinned official distribution and verified above.
  tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$stage"
  test -x "$stage/python/bin/python3"
  test ! -e "$runtime"
  mv "$stage" "$runtime"
  trap - EXIT
fi
hostname -I > data/native-addresses.txt 2>/dev/null || true
ip -j address > data/native-interfaces.json 2>/dev/null || true
export PYTHONDONTWRITEBYTECODE=1
exec "$runtime/python/bin/python3" -u /home/container/harmony-launch.py
