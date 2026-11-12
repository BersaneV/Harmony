import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("data-backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

class EmbeddedBackup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / "data"
        (self.data / "files").mkdir(parents=True)
        with sqlite3.connect(self.data / "harmony.db") as db:
            db.execute("CREATE TABLE sample(id BLOB PRIMARY KEY, value TEXT)")
            db.execute("INSERT INTO sample VALUES(?,?)", (b"1234567890123456", "preferências/ç/😀"))
        self.key = hashlib.sha256(b"object").hexdigest()
        (self.data / "files" / self.key).write_bytes(b"immutable original")
        (self.data / "files" / ".stage-abandoned").write_bytes(b"uncommitted")
        self.env = self.root / ".env"
        self.env.write_text("HARMONY_JWT_SECRET=fixture-only\n")
        self.archive = self.root / "backup"
    def tearDown(self):
        self.tmp.cleanup()
    def create(self):
        return backup.create(self.data, self.archive, self.env)
    def test_roundtrip_preserves_database_bytes_and_credentials(self):
        self.create()
        restored = self.root / "restored"
        backup.restore(self.archive, restored)
        with sqlite3.connect(restored / "data/harmony.db") as db:
            self.assertEqual(db.execute("SELECT id,value FROM sample").fetchone(), (b"1234567890123456", "preferências/ç/😀"))
        self.assertEqual((restored / "data/files" / self.key).read_bytes(), b"immutable original")
        self.assertEqual((restored / ".env").read_bytes(), self.env.read_bytes())
        self.assertFalse((restored / "data/files/.stage-abandoned").exists())
        self.assertEqual((restored / ".env").stat().st_mode & 0o777, 0o600)
    def test_refuses_active_runtime_lease(self):
        with Path(str(self.data / "harmony.db") + ".lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            with self.assertRaises(RuntimeError): self.create()
        self.assertFalse(self.archive.exists())
    def test_refuses_overwrite_backup_and_restore(self):
        self.create()
        with self.assertRaises(FileExistsError): self.create()
        restored = self.root / "restored"
        backup.restore(self.archive, restored)
        with self.assertRaises(FileExistsError): backup.restore(self.archive, restored)
    def test_corruption_prevents_any_restore(self):
        self.create()
        (self.archive / "files" / self.key).write_bytes(b"tampered")
        restored = self.root / "restored"
        with self.assertRaises(ValueError): backup.restore(self.archive, restored)
        self.assertFalse(restored.exists())
    def test_manifest_traversal_is_rejected(self):
        self.create()
        p = self.archive / "manifest.json"
        manifest = json.loads(p.read_text())
        manifest["files"]["../outside"] = {"sha256": "x", "bytes": 1}
        p.write_text(json.dumps(manifest))
        with self.assertRaises(ValueError): backup.verify(self.archive)
    def test_symlink_source_is_rejected(self):
        p = self.data / "files" / self.key
        p.unlink()
        p.symlink_to(self.env)
        with self.assertRaises(ValueError): self.create()
    def test_backup_inside_data_is_rejected(self):
        with self.assertRaises(ValueError): backup.create(self.data, self.data / "nested")

if __name__ == "__main__": unittest.main()
