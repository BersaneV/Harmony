#!/usr/bin/env python3
"""Copy a read-only, consistent PostgreSQL snapshot into a NEW SQLite database.

Stop the old API/worker first and keep the PostgreSQL database/objects as rollback.
This script copies every application table, including authentication/preferences,
checks foreign keys and independent row digests, and never modifies the source.
Object bytes are migrated separately; do not start the new deployment before both
steps are verified. Credentials are read from an environment variable, never argv.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import uuid
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
TABLES = (
    "users", "sessions", "used_refresh_tokens", "password_resets", "guilds",
    "guild_members", "channels", "channel_members", "friends", "invites",
    "messages", "reactions", "channel_reads", "uploads", "outbox", "audit",
    "media_members", "media_bans", "media_mutes", "guild_roles",
    "guild_member_roles", "channel_permissions", "media_jobs", "media_attempts",
    "media_derivatives",
)
JSON_COLUMNS = {("users", "preferences"), ("outbox", "event"), ("media_jobs", "metadata")}


def add_digest(state, values):
    # Order-independent multiset digest: SQL table iteration order is not data.
    canonical = [v.hex() if isinstance(v, bytes) else int(v) if isinstance(v, bool) else v for v in values]
    digest = int.from_bytes(hashlib.sha256(json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode()).digest(), "big")
    state[0] += 1
    state[1] = (state[1] + digest) % (1 << 256)
    state[2] ^= digest


def fingerprint(state):
    return {"rows": state[0], "sha256_sum": f"{state[1]:064x}", "sha256_xor": f"{state[2]:064x}"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-url-env", default="DATABASE_URL")
    parser.add_argument("--psql", default=os.environ.get("PSQL_PATH", "psql"))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--writers-stopped", action="store_true",
                      help="acknowledge old API/worker stopped; retain source for rollback")
    mode.add_argument("--snapshot-only", action="store_true",
                      help="validate a read-only snapshot while old services may run; not ready for cutover")
    args = parser.parse_args()
    os.umask(0o077)
    source = urlsplit(os.environ[args.source_url_env])
    if source.scheme not in ("postgres", "postgresql") or not source.hostname or not source.path.strip("/"):
        parser.error("source URL must identify the old PostgreSQL application database")
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    # Cooperate with API/worker and offline backup on the exact canonical path.
    # The new destination is not visible as usable while the import is running.
    lease = open(str(output) + ".lock", "a+b")
    try:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lease.close()
        parser.error("destination is in use; stop services before importing")
    # Reserve final path exclusively: existing databases are never overwritten.
    fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    report_path = output.with_suffix(output.suffix + ".migration.json")
    error_path = output.with_suffix(output.suffix + ".migration-errors.log")
    if report_path.exists() or error_path.exists():
        output.unlink()
        parser.error("migration evidence path already exists")
    conn = None
    process = None
    verified = False
    try:
        conn = sqlite3.connect(output)
        conn.execute("PRAGMA foreign_keys=ON")
        # Offline import uses rollback journal, not the host Python's WAL engine.
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("PRAGMA synchronous=FULL")
        schema = ROOT / "migrations-sqlite/0001_embedded.sql"
        conn.executescript(schema.read_text())
        columns = {t: [(r[1], r[2]) for r in conn.execute(f'PRAGMA table_info("{t}")')] for t in TABLES}
        source_hashes = {t: [0, 0, 0] for t in TABLES}
        target_hashes = {t: [0, 0, 0] for t in TABLES}
        commands = ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;", "SET LOCAL timezone='UTC';",
                    "SELECT json_build_object('schema_version',max(version),'clean',bool_and(success)) FROM _sqlx_migrations;"]
        for table in TABLES:
            fields = []
            for column, _ in columns[table]:
                expression = f't."{column}"'
                if (table, column) in JSON_COLUMNS:
                    expression += "::text"  # preserve JSON number precision/text
                fields.extend([f"'{column}'", expression])
            commands.append(f"SELECT json_build_object('table','{table}','row',json_build_object({','.join(fields)})) FROM \"{table}\" t;")
        commands.append("COMMIT;")
        env = dict(os.environ, PGHOST=source.hostname, PGPORT=str(source.port or 5432),
                   PGDATABASE=unquote(source.path[1:]), PGUSER=unquote(source.username or ""),
                   PGPASSWORD=unquote(source.password or ""), PGCONNECT_TIMEOUT="10")
        # Preserve explicitly configured TLS options without putting credentials in argv.
        from urllib.parse import parse_qs
        for key, variable in (("sslmode", "PGSSLMODE"), ("sslrootcert", "PGSSLROOTCERT"), ("sslcert", "PGSSLCERT"), ("sslkey", "PGSSLKEY")):
            option = parse_qs(source.query).get(key)
            if option:
                env[variable] = option[-1]
        with error_path.open("x") as errors:
            process = subprocess.Popen([args.psql, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
                                       env=env, text=True, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=errors)
            process.stdin.write("\n".join(commands))
            process.stdin.close()
            first = process.stdout.readline()
            metadata = json.loads(first)
            if metadata != {"schema_version": 4, "clean": True}:
                raise RuntimeError("source must be a clean Harmony PostgreSQL schema version 4")
            conn.execute("BEGIN IMMEDIATE")
            for line in process.stdout:
                record = json.loads(line)
                table, row = record["table"], record["row"]
                if table not in columns:
                    raise RuntimeError("unexpected table in export")
                names, values = [], []
                for name, sql_type in columns[table]:
                    value = row[name]
                    if value is not None and sql_type.upper() == "BLOB":
                        value = uuid.UUID(value).bytes
                    elif isinstance(value, bool):
                        value = int(value)
                    names.append(f'"{name}"')
                    values.append(value)
                conn.execute(f'INSERT INTO "{table}" ({",".join(names)}) VALUES({",".join("?" for _ in values)})', values)
                add_digest(source_hashes[table], values)
            if process.wait(timeout=30) != 0:
                raise RuntimeError("PostgreSQL export failed; inspect the private error log")
        if conn.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("referential integrity check failed")
        for table in TABLES:
            names = ",".join(f'"{n}"' for n, _ in columns[table])
            for row in conn.execute(f'SELECT {names} FROM "{table}"'):
                add_digest(target_hashes[table], row)
            if source_hashes[table] != target_hashes[table]:
                raise RuntimeError(f"data digest mismatch for {table}")
        conn.execute("CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,success BOOLEAN NOT NULL,checksum BLOB NOT NULL,execution_time BIGINT NOT NULL)")
        conn.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(1,'embedded',1,?,0)",
                     (hashlib.sha384(schema.read_bytes()).digest(),))
        conn.commit()
        if conn.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise RuntimeError("SQLite integrity check failed")
        conn.close()
        conn = None
        report = {"status": "PASS", "created_at": datetime.now(timezone.utc).isoformat(),
                  "source_read_only": True, "cutover_ready": bool(args.writers_stopped), "tables": {t: fingerprint(source_hashes[t]) for t in TABLES},
                  "database_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                  "source_schema": 4, "target_schema": 1,
                  "objects_copied": False, "next": "Migrate/verify object bytes before starting Harmony. Keep source for rollback."}
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        verified = True
        print(json.dumps({"status": "PASS", "tables": len(TABLES), "rows": sum(s[0] for s in source_hashes.values()), "report": str(report_path)}))
    finally:
        if process and process.poll() is None:
            process.kill()
            process.wait()
        if conn:
            conn.close()
        if not verified:
            # Only the exclusively created, incomplete destination is removed.
            output.unlink(missing_ok=True)
            for suffix in ("-journal", "-wal", "-shm"):
                Path(str(output) + suffix).unlink(missing_ok=True)
        lease.close()


if __name__ == "__main__":
    main()
