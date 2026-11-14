#!/usr/bin/env python3
"""Pinned single-provider Linux deployment; never relax the parser sandbox."""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

BASE = Path('/home/container/data')
VERSION = '0.4.1'
VERIFIED_PRODUCT = '2ea5c8cfa6eb003d732dbcbe0c4a76ae73bc1f7d'
ASSET_URL = 'https://github.com/BersaneV/Harmony/releases/download/v0.4.1/harmony-server-0.4.1-linux-x86_64.tar.gz'
MAX_DOWNLOAD = 128 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
PHASE = 'configuration'


def sha(path):
    with path.open('rb') as source:
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def relative(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name or '\x00' in name:
        raise RuntimeError('Unsafe bundle path')
    return Path(*path.parts)


class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, url):
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != 'https' or parsed.hostname not in
                ('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')
                or parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.fragment):
            raise RuntimeError('Bundle redirect rejected')
        return super().redirect_request(request, file, code, message, headers, url)


def verify(root, archive_digest=None):
    manifest_path = root / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if archive_digest is not None:
        archive = root / '.archive.tar.gz'
        if sha(archive) != archive_digest:
            raise RuntimeError('Cached archive hash mismatch')
        with tarfile.open(archive, 'r:gz') as source:
            member = next(m for m in source if str(relative(m.name)) == 'manifest.json')
            with source.extractfile(member) as stream:
                if json.load(stream) != manifest:
                    raise RuntimeError('Cached manifest differs from the verified archive')
    if (manifest.get('version') != VERSION or manifest.get('platform') != 'linux-x86_64'
            or manifest.get('verified_product_commit') != VERIFIED_PRODUCT):
        raise RuntimeError('Bundle source or version mismatch')
    files = manifest['files']
    if not isinstance(files, dict) or len(files) > 2048:
        raise RuntimeError('Invalid bundle manifest')
    actual = set()
    for path in root.rglob('*'):
        if path.is_symlink():
            raise RuntimeError('Bundle symlink rejected')
        if path.is_file() and path not in (manifest_path, root / '.archive.tar.gz'):
            actual.add(str(path.relative_to(root)))
    if actual != set(files):
        raise RuntimeError('Bundle inventory mismatch')
    for name, digest in files.items():
        path = root / relative(name)
        if not stat.S_ISREG(path.lstat().st_mode) or sha(path) != digest:
            raise RuntimeError('Bundle file hash mismatch')
    required = ('bin/harmony-server', 'bin/harmony-media-worker', 'bin/harmony-db',
                'bin/ffmpeg', 'bin/ffprobe', 'scripts/supervise.py', 'web/index.html')
    if any(name not in files for name in required):
        raise RuntimeError('Incomplete server bundle')
    return manifest


def bundle(expected):
    if not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise RuntimeError('An operator-verified bundle SHA-256 is required')
    cache = BASE / '.harmony-runtime'
    cache.mkdir(mode=0o700, exist_ok=True)
    cache.chmod(0o700)
    target = cache / expected
    if target.exists():
        verify(target, expected)
        return target
    # A new directory prevents partial extraction from replacing a working version.
    with tempfile.TemporaryDirectory(prefix='.install-', dir=cache) as temporary:
        temporary = Path(temporary)
        archive = temporary / 'bundle.tar.gz'
        request = urllib.request.Request(ASSET_URL, headers={'User-Agent': 'Harmony-Deployment/0.4.1'})
        opener = urllib.request.build_opener(Redirects())
        deadline = time.monotonic() + 120
        with opener.open(request, timeout=15) as response, archive.open('xb') as destination:
            length = response.headers.get('Content-Length')
            if length and int(length) > MAX_DOWNLOAD:
                raise RuntimeError('Bundle download too large')
            size = 0
            while True:
                if time.monotonic() > deadline:
                    raise RuntimeError('Bundle download deadline exceeded')
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_DOWNLOAD:
                    raise RuntimeError('Bundle download too large')
                destination.write(chunk)
        if sha(archive) != expected:
            raise RuntimeError('Bundle archive hash mismatch')
        unpacked = temporary / 'unpacked'
        unpacked.mkdir(mode=0o700)
        expanded = 0
        names = set()
        with tarfile.open(archive, 'r:gz') as source:
            for member in source:
                rel = relative(member.name)
                if rel == Path('.'):
                    if not member.isdir():
                        raise RuntimeError('Invalid bundle root')
                    continue
                name = str(rel)
                if name == '.archive.tar.gz':
                    raise RuntimeError('Reserved bundle member')
                if name in names or len(names) >= 2048:
                    raise RuntimeError('Duplicate or excessive bundle members')
                names.add(name)
                if not (member.isdir() or member.isfile()):
                    raise RuntimeError('Bundle links and special files rejected')
                expanded += member.size
                if member.size < 0 or expanded > MAX_EXPANDED:
                    raise RuntimeError('Expanded bundle too large')
                output = unpacked / rel
                if member.isdir():
                    output.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with source.extractfile(member) as payload, output.open('xb') as destination:
                    shutil.copyfileobj(payload, destination, length=64 * 1024)
                output.chmod(0o555 if member.mode & 0o111 else 0o444)
        verify(unpacked)
        shutil.copyfile(archive, unpacked / '.archive.tar.gz')
        (unpacked / '.archive.tar.gz').chmod(0o400)
        unpacked.rename(target)
    return target


def private_directory(path):
    if path.is_symlink():
        raise RuntimeError('Private directory cannot be a symlink')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    if path.stat().st_uid != os.geteuid() or path.stat().st_gid != os.getegid():
        raise RuntimeError('Private directory has an unexpected owner')


def unprivileged_identity(observation):
    """Check the kernel identity as well as the image's mapped identity."""
    try:
        kernel = observation['kernel']
        uids = [int(v) for v in kernel['Uid'].split()]
        gids = [int(v) for v in kernel['Gid'].split()]
        groups = [int(v) for v in kernel['Groups'].split()]
        return (observation['uid'] > 0 and observation['gid'] > 0
                and 0 not in observation['groups']
                and uids == [observation['uid']] * 4
                and gids == [observation['gid']] * 4
                and all(v > 0 for v in groups)
                and int(kernel['CapPrm'], 16) == 0 and int(kernel['CapEff'], 16) == 0
                and kernel['NoNewPrivs'] == '1')
    except (KeyError, TypeError, ValueError):
        return False


def identity_and_paths(runtime, state, worker_temp, sqlite_temp):
    for path in (state, state / 'files', worker_temp, sqlite_temp):
        private_directory(path)
    # Import must already be owned by the unprivileged service account.
    marker = state / '.ownership-v1'
    if not marker.exists():
        for path in state.rglob('*'):
            if path.is_symlink():
                raise RuntimeError('Imported state symlink rejected')
            if path.stat().st_uid != os.geteuid():
                raise RuntimeError('Imported state has an unexpected owner')
        marker.write_text(str(os.geteuid()) + ':' + str(os.getegid()) + '\n')
        os.chmod(marker, 0o600)
    for path in [runtime.parent, runtime] + list(runtime.rglob('*')):
        if path.is_symlink():
            raise RuntimeError('Runtime symlink rejected')
        if path.stat().st_uid != os.geteuid():
            raise RuntimeError('Runtime has an unexpected owner')
        if path.is_dir():
            os.chmod(path, 0o500)
    if os.geteuid() == 0 or os.getegid() == 0:
        raise RuntimeError('The native deployment requires a non-root service account')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'no_new_privs failed')
    status = {}
    for line in Path('/proc/self/status').read_text().splitlines():
        key, _, value = line.partition(':')
        if key in ('Uid', 'Gid', 'Groups', 'CapEff', 'CapPrm', 'NoNewPrivs'):
            status[key] = value.strip()
    observation = {'uid': os.geteuid(), 'gid': os.getegid(), 'groups': os.getgroups(), 'kernel': status}
    (state / 'identity-observed.json').write_text(json.dumps(observation, indent=2) + '\n')
    if not unprivileged_identity(observation):
        raise RuntimeError('Unprivileged service identity not established')


def read_only_policy(runtime, writable):
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('This deployment profile requires Linux x86_64')
    libc = ctypes.CDLL(None, use_errno=True)
    abi = libc.syscall(444, 0, 0, 1)
    if abi < 3:
        raise RuntimeError('Landlock ABI 3 or newer is required')
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'no_new_privs failed')
    class Ruleset(ctypes.Structure):
        _fields_ = [('handled_access_fs', ctypes.c_uint64)]
    class Beneath(ctypes.Structure):
        _pack_ = 1
        _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int)]
    all_fs = (1 << 15) - 1
    read = (1 << 2) | (1 << 3)
    write = ((1 << 1) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 8)
             | (1 << 13) | (1 << 14))
    attr = Ruleset(all_fs)
    ruleset = libc.syscall(444, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    if ruleset < 0:
        raise OSError(ctypes.get_errno(), 'Landlock ruleset failed')
    try:
        paths = [(Path('/'), read), (runtime, read),
                 (Path(sys.executable).resolve(), (1 << 0) | (1 << 2))]
        paths.extend((path, read) for path in (Path('/proc'), Path('/dev')) if path.exists())
        paths.extend((path, (1 << 2) | ((1 << 1) if str(path) == '/dev/null' else 0))
                     for path in (Path('/dev/null'), Path('/etc/resolv.conf'),
                                  Path('/etc/hosts'), Path('/etc/nsswitch.conf')) if path.exists())
        paths.extend((path.resolve(), read | 1) for path in
                     (Path('/usr'), Path('/lib'), Path('/lib64'), Path('/bin'), runtime / 'bin')
                     if path.exists())
        paths.extend((path, read | write) for path in writable)
        for path, rights in paths:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = Beneath(rights, fd)
                if libc.syscall(445, ruleset, 1, ctypes.byref(rule), 0) != 0:
                    raise OSError(ctypes.get_errno(), 'Landlock rule failed')
            finally:
                os.close(fd)
        if libc.syscall(446, ruleset, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Landlock restriction failed')
    finally:
        os.close(ruleset)
    return abi


def check_policy(worker_temp):
    outside = Path('/tmp/harmony-write-check-' + secrets.token_hex(8))
    try:
        with outside.open('xb'):
            pass
    except OSError as error:
        if error.errno not in (errno.EACCES, errno.EPERM, errno.EROFS):
            raise
    else:
        outside.unlink()
        raise RuntimeError('Write outside private directories was permitted')
    executable = worker_temp / ('.noexec-check-' + secrets.token_hex(8))
    try:
        shutil.copyfile('/bin/true', executable)
        executable.chmod(0o700)
        try:
            subprocess.run([str(executable)], check=True, timeout=5)
        except PermissionError:
            return
        raise RuntimeError('Execution from a writable directory was permitted')
    finally:
        executable.unlink(missing_ok=True)


def load_configuration():
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise RuntimeError('Duplicate configuration key')
            result[key] = value
        return result
    path = BASE / 'harmony-config.json'
    if path.is_symlink() or not stat.S_ISREG(path.lstat().st_mode):
        raise RuntimeError('Private configuration must be a regular file')
    if path.stat().st_mode & 0o077:
        raise RuntimeError('Private configuration permissions must be 0600')
    config = json.loads(path.read_text(), object_pairs_hook=unique)
    prefixes = ('HARMONY_', 'BOOTSTRAP_', 'LIVEKIT_', 'WORKER_')
    for name, value in config.items():
        if (not isinstance(name, str) or not isinstance(value, str)
                or not re.fullmatch(r'[A-Z][A-Z0-9_]*', name)
                or not (name.startswith(prefixes) or name == 'DATABASE_URL')):
            raise RuntimeError('Unsupported deployment configuration field')
    os.environ.update(config)


def main():
    global PHASE
    os.umask(0o077)
    load_configuration()
    PHASE = 'bundle_verification'
    runtime = bundle(os.environ.get('HARMONY_BUNDLE_SHA256', ''))
    slot = os.environ.get('HARMONY_DEPLOYMENT_SLOT', 'state')
    if slot not in ('state', 'acceptance'):
        raise RuntimeError('Unsupported deployment slot')
    state = BASE / ('harmony-' + slot)
    worker_temp = BASE / ('worker-temp-' + slot)
    sqlite_temp = BASE / ('sqlite-temp-' + slot)
    port = int(os.environ.get('PORT', os.environ.get('SERVER_PORT', '8080')))
    if not 1024 <= port <= 65535:
        raise RuntimeError('Invalid app port')
    os.environ.update({
        'DATABASE_URL': 'sqlite:' + str(state / 'harmony.db'),
        'HARMONY_STORAGE_BACKEND': 'local', 'HARMONY_STORAGE_DIR': str(state / 'files'),
        'HARMONY_WEB_DIR': str(runtime / 'web'), 'HARMONY_BIND': '0.0.0.0:' + str(port),
        'HARMONY_HEALTH_URL': 'http://127.0.0.1:' + str(port) + '/health',
        'HARMONY_SERVER_BIN': str(runtime / 'bin/harmony-server'),
        'HARMONY_WORKER_BIN': str(runtime / 'bin/harmony-media-worker'),
        'FFMPEG_PATH': str(runtime / 'bin/ffmpeg'), 'FFPROBE_PATH': str(runtime / 'bin/ffprobe'),
        'WORKER_TEMP_DIR': str(worker_temp), 'SQLITE_TMPDIR': str(sqlite_temp),
        'TMPDIR': str(sqlite_temp), 'PYTHONDONTWRITEBYTECODE': '1',
    })
    PHASE = 'private_paths_and_identity'
    identity_and_paths(runtime, state, worker_temp, sqlite_temp)
    PHASE = 'kernel_filesystem_policy'
    abi = read_only_policy(runtime, (state, worker_temp, sqlite_temp))
    PHASE = 'filesystem_policy_negative_checks'
    check_policy(worker_temp)
    report = {'profile': 'altare-single-provider', 'version': VERSION, 'landlock_abi': abi,
              'uid': os.geteuid(), 'write_outside_private_directories': 'DENIED',
              'execute_from_writable_directory': 'DENIED',
              'parser_sandbox': 'REQUIRED_BY_SUPERVISOR', 'slot': slot}
    (state / 'deployment-guard.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    PHASE = 'supervisor_exec'
    os.execv(sys.executable, [sys.executable, str(runtime / 'scripts/supervise.py')])


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print request errors, environment, keys or temporary CDN URLs.
        report = {'code': 'external_startup_refused', 'phase': PHASE,
                  'error_type': type(error).__name__, 'errno': getattr(error, 'errno', None)}
        print(json.dumps(report), file=sys.stderr)
        sys.exit(1)
