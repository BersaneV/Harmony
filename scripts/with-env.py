#!/usr/bin/env python3
"""Run a command with the generated local .env, without logging its secrets."""
import os
from pathlib import Path
import sys

if len(sys.argv) < 2:
    raise SystemExit("Uso: python3 scripts/with-env.py comando [argumentos]")
env = dict(os.environ)
path = Path(os.environ.get("HARMONY_ENV_FILE", Path(__file__).resolve().parents[1] / ".env"))
if path.exists():
    for line in path.read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            key, value = line.split("=", 1)
            env.setdefault(key, value)
os.execvpe(sys.argv[1], sys.argv[1:], env)
