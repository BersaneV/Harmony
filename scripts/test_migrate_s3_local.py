#!/usr/bin/env python3
"""Boundary tests with a local S3-shaped HTTP fixture; real S3 proof is separate."""
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from threading import Thread
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]


class ObjectHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self.respond(False)

    def do_GET(self):
        self.respond(True)

    def respond(self, send_body):
        self.server.calls.append(self.command)
        if self.path != "/harmony/objects/id/original" or self.server.missing:
            self.send_error(404)
            return
        if send_body and self.server.redirect:
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/never-forward-credentials")
            self.end_headers()
            return
        body = self.server.payload
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", '"changed"' if self.server.changed else '"initial"')
        self.end_headers()
        if send_body:
            self.wfile.write(body)
            if self.server.mutate:
                self.server.changed = True


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / "harmony.db"
        with sqlite3.connect(self.db) as conn:
            conn.executescript("CREATE TABLE uploads(id BLOB,user_id BLOB,object_key TEXT,size INTEGER,status TEXT,temporary_cleaned INTEGER);CREATE TABLE media_derivatives(object_key TEXT,size INTEGER,ready INTEGER);")
            conn.execute("INSERT INTO uploads VALUES(?,?,?,?,?,?)", (uuid.uuid4().bytes, uuid.uuid4().bytes, "objects/id/original", 3, "ready", 0))
        self.before = hashlib.sha256(self.db.read_bytes()).hexdigest()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), ObjectHandler)
        self.server.missing = self.server.redirect = self.server.mutate = self.server.changed = False
        self.server.calls, self.server.payload = [], b"abc"
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.env = self.root / ".env"
        self.env.write_text(f"S3_ENDPOINT=http://127.0.0.1:{self.server.server_port}\nS3_BUCKET=harmony\nS3_ACCESS_KEY=fixture-only\nS3_SECRET_KEY=fixture-only\n")
        self.output = self.root / "files"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def run_migration(self):
        return subprocess.run([sys.executable, str(ROOT / "scripts/migrate-s3-to-local.py"), "--database", str(self.db), "--source-env", str(self.env), "--output", str(self.output), "--snapshot-only"], capture_output=True, text=True, timeout=10)

    def report(self):
        return json.loads(self.output.with_name("files.migration.json").read_text())

    def test_verified_copy_is_read_only_and_private(self):
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = self.report()
        self.assertEqual(report["status"], "PASS")
        self.assertFalse(report["cutover_ready"])
        self.assertEqual([o["status"] for o in report["objects"]].count("not_present"), 1)
        name = hashlib.sha256(b"objects/id/original").hexdigest()
        self.assertEqual((self.output / name).read_bytes(), b"abc")
        self.assertEqual(os.stat(self.output / name).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(self.output).st_mode & 0o777, 0o700)
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), self.before)
        self.assertEqual(set(self.server.calls), {"HEAD", "GET"})

    def test_missing_ready_object_fails(self):
        self.server.missing = True
        self.assertEqual(self.run_migration().returncode, 1)
        self.assertEqual(self.report()["error_code"], "required_object_missing")

    def test_size_mismatch_fails(self):
        self.server.payload = b"too big"
        self.assertEqual(self.run_migration().returncode, 1)
        self.assertEqual(self.report()["error_code"], "object_size_differs_from_database")

    def test_redirect_never_forwards_credentials(self):
        self.server.redirect = True
        self.assertEqual(self.run_migration().returncode, 1)
        self.assertEqual(self.report()["error_code"], "source_redirect_denied")

    def test_source_change_during_copy_fails(self):
        self.server.mutate = True
        self.assertEqual(self.run_migration().returncode, 1)
        self.assertEqual(self.report()["error_code"], "source_changed_during_copy")

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        (self.output / "sentinel").write_text("keep")
        self.assertEqual(self.run_migration().returncode, 1)
        self.assertEqual((self.output / "sentinel").read_text(), "keep")
        self.assertFalse(self.output.with_name("files.migration.json").exists())

    def test_running_database_blocks_migration(self):
        with Path(str(self.db) + ".lock").open("a+b") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
            result = self.run_migration()
        self.assertEqual(result.returncode, 1)
        self.assertIn("database_is_running", result.stderr)
        self.assertFalse(self.output.exists())

    def test_invalid_key_blocks_before_copy(self):
        with sqlite3.connect(self.db) as conn:
            conn.execute("UPDATE uploads SET object_key='../secrets'")
        result = self.run_migration()
        self.assertEqual(result.returncode, 1)
        self.assertIn("invalid_object_key", result.stderr)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
