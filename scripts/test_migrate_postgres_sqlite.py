#!/usr/bin/env python3
"""Failure/atomicity checks for the offline importer; real PG parity is separate."""
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="harmony-import-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.output = self.directory / "target.db"
        self.source = self.directory / "source.jsonl"
        self.captured = self.directory / "read-only.sql"
        self.psql = self.directory / "psql"
        self.psql.write_text("#!" + sys.executable + "\nimport os,sys,pathlib\n"
                             "pathlib.Path(os.environ['CAPTURE']).write_text(sys.stdin.read())\n"
                             "sys.stdout.write(pathlib.Path(os.environ['FIXTURE']).read_text())\n")
        self.psql.chmod(0o700)
        self.user_id = str(uuid.uuid4())
        self.user = {"id": self.user_id, "username": "fixture", "display_name": "Árvore",
                     "password_hash": "test-only-hash", "is_admin": True, "disabled": False,
                     "auth_version": 7, "preferences": '{"large":9007199254740993,"accent":"#123456"}',
                     "created_at": "2026-01-01T00:00:00+00:00"}
        self.write_source()

    def write_source(self, schema=4, extra=()):
        records = [{"schema_version": schema, "clean": True}, {"table": "users", "row": self.user}, *extra]
        self.source.write_text("\n".join(json.dumps(row) for row in records) + "\n")

    def run_import(self):
        return subprocess.run([sys.executable, str(ROOT / "scripts/migrate-postgres-to-sqlite.py"),
                               "--output", str(self.output), "--psql", str(self.psql), "--snapshot-only"],
                              env=dict(os.environ, DATABASE_URL="postgres://fixture:unused@127.0.0.1/fixture",
                                       CAPTURE=str(self.captured), FIXTURE=str(self.source)),
                              capture_output=True, text=True)

    def test_snapshot_preserves_binary_uuid_hash_and_json_text(self):
        result = self.run_import()
        self.assertEqual(result.returncode, 0, result.stderr)
        with sqlite3.connect(self.output) as conn:
            row = conn.execute("SELECT id,password_hash,auth_version,preferences FROM users").fetchone()
            self.assertEqual(row, (uuid.UUID(self.user_id).bytes, "test-only-hash", 7, self.user["preferences"]))
            self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        report = json.loads(Path(str(self.output) + ".migration.json").read_text())
        self.assertFalse(report["cutover_ready"])
        self.assertTrue(report["source_read_only"])
        self.assertEqual(report["tables"]["users"]["rows"], 1)
        statements = self.captured.read_text().splitlines()
        self.assertEqual(statements[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;")
        self.assertTrue(all(s.startswith(("BEGIN ", "SET LOCAL ", "SELECT ", "COMMIT;")) for s in statements))

    def test_existing_destination_never_overwritten(self):
        self.output.write_bytes(b"keep-existing-database")
        self.assertNotEqual(self.run_import().returncode, 0)
        self.assertEqual(self.output.read_bytes(), b"keep-existing-database")
        self.assertFalse(self.captured.exists())

    def test_wrong_source_version_rolls_back_new_destination(self):
        self.write_source(schema=3)
        self.assertNotEqual(self.run_import().returncode, 0)
        self.assertFalse(self.output.exists())
        self.assertFalse(Path(str(self.output) + ".migration.json").exists())

    def test_foreign_key_failure_removes_only_incomplete_copy(self):
        self.write_source(extra=[{"table": "guilds", "row": {
            "id": str(uuid.uuid4()), "name": "Broken", "owner_id": str(uuid.uuid4()),
            "created_at": "2026-01-01T00:00:00+00:00"}}])
        source_before = self.source.read_bytes()
        self.assertNotEqual(self.run_import().returncode, 0)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.source.read_bytes(), source_before)

    def test_destination_maintenance_lease_prevents_import(self):
        with open(str(self.output) + ".lock", "a+b") as lease:
            fcntl.flock(lease, fcntl.LOCK_SH | fcntl.LOCK_NB)
            result = self.run_import()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("destination is in use", result.stderr)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.captured.exists())


if __name__ == "__main__":
    unittest.main()
