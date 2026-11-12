#!/usr/bin/env python3
"""Verified offline backup/restore of an embedded Harmony instance.

No service or cloud account is contacted. The API and worker hold a shared
database maintenance lease; this command refuses to run until they have exited.
Backups contain credentials: keep them private or encrypt with restic.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat


def regular(path):
    mode = path.lstat().st_mode
    if not stat.S_ISREG(mode) or path.stat().st_nlink != 1:
        raise ValueError(f"Expected an unlinked regular file: {path.name}")


def digest(path):
    regular(path)
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def copy_private(source, target):
    regular(source)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Source data lives in the private operator-controlled volume. O_NOFOLLOW
    # still prevents a replacement symlink from being followed during copy.
    src = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        dst = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(dst, 'wb') as output, os.fdopen(src, 'rb', closefd=False) as input_file:
            for block in iter(lambda: input_file.read(1024 * 1024), b''):
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
    finally:
        os.close(src)


@contextmanager
def offline(database):
    lock_path = Path(str(database) + '.lock')
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Stop Harmony API and media worker before maintenance') from None
        yield
    finally:
        os.close(fd)


def verify_database(path):
    regular(path)
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as conn:
        if conn.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('SQLite integrity check failed')
        if conn.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('SQLite foreign key check failed')


def allowed(name):
    return name in ('harmony.db', 'environment', 'deploy/livekit.yaml', 'deploy/caddy.json') or bool(re.fullmatch(r'files/[a-f0-9]{64}', name))


def create(data, output, environment=None, deploy=None):
    data, output = data.resolve(strict=True), output.resolve()
    if output == data or data in output.parents:
        raise ValueError('Backup must be outside the live data directory')
    database = data / 'harmony.db'
    regular(database)
    with offline(database):
        output.mkdir(mode=0o700)  # Existing backup is never overwritten.
        # No active Harmony writer is allowed here. Python's SQLite is used only
        # for an offline snapshot; application WAL uses the pinned Rust library.
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as source:
            with sqlite3.connect(output / 'harmony.db') as dest:
                source.backup(dest)
                dest.execute('PRAGMA journal_mode=DELETE')
        os.chmod(output / 'harmony.db', 0o600)
        verify_database(output / 'harmony.db')
        files = data / 'files'
        if files.is_symlink() or not files.is_dir():
            raise ValueError('Private object directory is missing or a symlink')
        (output / 'files').mkdir(mode=0o700)
        for path in files.iterdir():
            if path.name.startswith('.stage-'):
                continue  # Never a committed object; pending uploads can retry.
            if not re.fullmatch(r'[a-f0-9]{64}', path.name):
                raise ValueError('Unexpected object filename')
            copy_private(path, output / 'files' / path.name)
        if environment:
            copy_private(environment, output / 'environment')
        if deploy:
            for name in ('livekit.yaml', 'caddy.json'):
                copy_private(deploy / name, output / 'deploy' / name)
        paths = sorted(p for p in output.rglob('*') if p.is_file())
        manifest = {'format': 1, 'offline': True, 'files': {
            str(p.relative_to(output)): {'sha256': digest(p), 'bytes': p.stat().st_size}
            for p in paths}}
        with (output / 'manifest.json').open('x') as stream:
            json.dump(manifest, stream, indent=2)
            stream.write('\n')
        return {'status': 'PASS', 'files': len(paths), 'output': str(output)}


def verify(backup):
    backup = backup.resolve(strict=True)
    regular(backup / 'manifest.json')
    manifest = json.loads((backup / 'manifest.json').read_text())
    entries = manifest.get('files')
    if manifest.get('format') != 1 or manifest.get('offline') is not True or not isinstance(entries, dict) or 'harmony.db' not in entries:
        raise ValueError('Unsupported or incomplete backup manifest')
    for name, info in entries.items():
        if not allowed(name):
            raise ValueError('Invalid backup path')
        path = backup / name
        for parent in path.relative_to(backup).parents:
            if (backup / parent).is_symlink():
                raise ValueError('Symlink in backup path')
        if digest(path) != info['sha256'] or path.stat().st_size != info['bytes']:
            raise ValueError('Backup checksum mismatch')
    verify_database(backup / 'harmony.db')
    return entries


def restore(backup, output):
    backup, output = backup.resolve(strict=True), output.resolve()
    entries = verify(backup)
    output.mkdir(mode=0o700)  # Restore only to a NEW directory.
    (output / 'data' / 'files').mkdir(parents=True, mode=0o700)
    for name in entries:
        target = (output / '.env' if name == 'environment' else
                  output / '.local' / name if name.startswith('deploy/') else output / 'data' / name)
        copy_private(backup / name, target)
    verify_database(output / 'data' / 'harmony.db')
    return {'status': 'PASS', 'files': len(entries), 'output': str(output), 'services_started': False}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    c = sub.add_parser('create')
    c.add_argument('--data', type=Path, required=True)
    c.add_argument('--output', type=Path, required=True)
    c.add_argument('--environment', type=Path)
    c.add_argument('--deploy', type=Path)
    r = sub.add_parser('restore')
    r.add_argument('--backup', type=Path, required=True)
    r.add_argument('--output', type=Path, required=True)
    v = sub.add_parser('verify')
    v.add_argument('--backup', type=Path, required=True)
    args = parser.parse_args()
    if args.action == 'create':
        result = create(args.data, args.output, args.environment, args.deploy)
    elif args.action == 'restore':
        result = restore(args.backup, args.output)
    else:
        result = {'status': 'PASS', 'files': len(verify(args.backup))}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
