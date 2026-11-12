#!/usr/bin/env python3
"""Copy the object keys referenced by an OFFLINE migrated SQLite database.

The source S3 bucket is read-only (HEAD/GET). A new destination is required.
Originals and ready derivatives are mandatory; planned/pending keys may not yet
exist. Retain the old database and bucket together for rollback. The report is
private and contains hashes/counts, never credentials or signed URLs.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("harmony_s3", ROOT / "scripts/storage-init.py")
s3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s3)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("source_redirect_denied")


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(64 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def object_filename(key):
    if not isinstance(key, str) or not key or len(key.encode()) > 512:
        raise RuntimeError("invalid_object_key")
    if any(part in ("", ".", "..") or not re.fullmatch(r"[a-zA-Z0-9_.-]+", part) for part in key.split("/")):
        raise RuntimeError("invalid_object_key")
    return hashlib.sha256(key.encode()).hexdigest()


def inventory(conn):
    result = {}
    def add(key, required, expected=None):
        name = object_filename(key)
        if key in result:
            result[key]["required"] |= required
            if expected is not None:
                previous = result[key]["expected_bytes"]
                if previous is not None and previous != expected:
                    raise RuntimeError("conflicting_object_size")
                result[key]["expected_bytes"] = expected
        else:
            result[key] = {"file": name, "required": required, "expected_bytes": expected}
    for row in conn.execute("SELECT id,user_id,object_key,size,status,temporary_cleaned FROM uploads"):
        ident, user, key, size, status, cleaned = row
        if status == "ready":
            add(key, True, size)
        else:
            add(key, False)
        if not cleaned:
            add(f"pending/{uuid.UUID(bytes=user)}/{uuid.UUID(bytes=ident)}", False)
    for key, size, ready in conn.execute("SELECT object_key,size,ready FROM media_derivatives"):
        add(key, bool(ready), size if ready else None)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True, help="new, offline SQLite import")
    parser.add_argument("--source-env", type=Path, required=True, help="private old deployment .env; no credentials in argv")
    parser.add_argument("--output", type=Path, required=True, help="new HARMONY_STORAGE_DIR")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--writers-stopped", action="store_true", help="old API and worker stopped; source retained")
    mode.add_argument("--snapshot-only", action="store_true", help="read-only rehearsal; not ready for cutover")
    args = parser.parse_args()
    os.umask(0o077)
    config = {}
    for line in args.source_env.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            config[key.strip()] = value.strip()
    for key in ("S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"):
        if not config.get(key):
            raise RuntimeError("source_configuration_missing")
    endpoint = urllib.parse.urlsplit(config["S3_ENDPOINT"])
    if endpoint.scheme not in ("http", "https") or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or endpoint.path not in ("", "/"):
        raise RuntimeError("source_endpoint_invalid")
    database = args.database.resolve(strict=True)
    output = args.output.resolve()
    report_path = output.with_name(output.name + ".migration.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"status": "RUNNING", "source_read_only": True, "cutover_ready": False,
              "created_at": datetime.now(timezone.utc).isoformat(), "objects": []}
    # Match the runtime database advisory lock. Never inspect a running WAL DB
    # through the host Python SQLite version.
    lock_path = Path(str(database) + ".lock")
    with lock_path.open("a+b") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("database_is_running") from None
        if Path(str(database) + "-wal").exists():
            raise RuntimeError("database_requires_clean_shutdown")
        db_hash = file_hash(database)
        with sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True) as conn:
            if conn.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RuntimeError("database_integrity_failed")
            keys = inventory(conn)
        # Reserve both outputs before writing, never overwriting another result.
        output.mkdir(mode=0o700)
        try:
            report_fd = os.open(report_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except Exception:
            output.rmdir()
            raise
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with os.fdopen(report_fd, "w") as file:
                json.dump(report, file)
            largest_required = max((entry["expected_bytes"] or 0 for entry in keys.values()), default=0)
            ceiling = max(int(config.get("HARMONY_MAX_UPLOAD_BYTES", 25 * 1024 * 1024)), largest_required, 128 * 1024 * 1024)
            for key, item in keys.items():
                try:
                    with s3.request(config, "HEAD", key, opener=opener) as head:
                        length = int(head.headers["Content-Length"])
                        etag = head.headers.get("ETag")
                except urllib.error.HTTPError as error:
                    if error.code == 404 and not item["required"]:
                        report["objects"].append(dict(item, status="not_present"))
                        continue
                    raise RuntimeError("required_object_missing" if error.code == 404 else "source_request_failed") from None
                if length < 0 or length > ceiling:
                    raise RuntimeError("object_size_outside_limits")
                if item["expected_bytes"] is not None and length != item["expected_bytes"]:
                    raise RuntimeError("object_size_differs_from_database")
                path = output / item["file"]
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                digest, size = hashlib.sha256(), 0
                with os.fdopen(fd, "wb") as file, s3.request(config, "GET", key, headers={"If-Match": etag} if etag else {}, opener=opener) as source:
                    if source.status != 200 or int(source.headers["Content-Length"]) != length:
                        raise RuntimeError("source_length_changed")
                    while True:
                        block = source.read(64 * 1024)
                        if not block:
                            break
                        size += len(block)
                        if size > length:
                            raise RuntimeError("source_exceeded_declared_size")
                        digest.update(block)
                        file.write(block)
                    file.flush()
                    os.fsync(file.fileno())
                if size != length or file_hash(path) != digest.hexdigest():
                    raise RuntimeError("copied_bytes_verification_failed")
                with s3.request(config, "HEAD", key, opener=opener) as after:
                    if int(after.headers["Content-Length"]) != length or after.headers.get("ETag") != etag:
                        raise RuntimeError("source_changed_during_copy")
                report["objects"].append(dict(item, status="verified", bytes=size, sha256=digest.hexdigest()))
            if file_hash(database) != db_hash:
                raise RuntimeError("database_changed_during_copy")
            report.update(status="PASS", database_sha256=db_hash, cutover_ready=bool(args.writers_stopped))
        except Exception as error:
            report.update(status="FAIL", error_code=str(error) if isinstance(error, RuntimeError) else type(error).__name__)
            raise
        finally:
            # The report path was created exclusively by this invocation.
            with report_path.open("w") as file:
                json.dump(report, file, indent=2)
                file.write("\n")
                file.flush()
                os.fsync(file.fileno())
        print(json.dumps({"status": "PASS", "copied": sum(o["status"] == "verified" for o in report["objects"]),
                          "not_present": sum(o["status"] == "not_present" for o in report["objects"]),
                          "cutover_ready": report["cutover_ready"], "report": str(report_path)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "FAIL", "error_code": str(error) if isinstance(error, RuntimeError) else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
