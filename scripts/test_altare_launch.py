"""Extraction and configuration boundary checks; Linux isolation is tested on the host."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('altare_launch', ROOT / 'infra/altare/launch.py')
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


def archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as target:
        for name, kind, payload in entries:
            member = tarfile.TarInfo(name)
            if kind == 'symlink':
                member.type = tarfile.SYMTYPE
                member.linkname = payload
                target.addfile(member)
            elif kind == 'hardlink':
                member.type = tarfile.LNKTYPE
                member.linkname = payload
                target.addfile(member)
            else:
                member.size = len(payload)
                target.addfile(member, io.BytesIO(payload))
    return output.getvalue()


def valid_bundle():
    names = ('bin/harmony-server', 'bin/harmony-media-worker', 'bin/harmony-db',
             'bin/ffmpeg', 'bin/ffprobe', 'scripts/supervise.py', 'web/index.html')
    files = {name: b'test-only-payload' for name in names}
    manifest = {'version': launch.VERSION, 'platform': 'linux-x86_64',
                'verified_product_commit': launch.VERIFIED_PRODUCT,
                'files': {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}}
    return archive([(name, 'file', value) for name, value in files.items()]
                   + [('manifest.json', 'file', json.dumps(manifest).encode())])


class Response(io.BytesIO):
    def __init__(self, body, announced=True):
        super().__init__(body)
        self.headers = {'Content-Length': str(len(body))} if announced else {}


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.base = patch.object(launch, 'BASE', self.root)
        self.base.start()

    def tearDown(self):
        self.base.stop()
        self.temp.cleanup()

    def install(self, body, expected=None, announced=True):
        class Opener:
            def open(self, *args, **kwargs):
                return Response(body, announced)
        with patch.object(launch.urllib.request, 'build_opener', return_value=Opener()):
            return launch.bundle(expected or hashlib.sha256(body).hexdigest())

    def test_verified_archive_and_cached_files(self):
        body = valid_bundle()
        result = self.install(body)
        self.assertTrue((result / 'bin/harmony-server').is_file())
        self.assertEqual(result, self.install(body))

    def test_parent_traversal_cannot_write_outside_staging(self):
        body = archive([('../escaped', 'file', b'forbidden')])
        with self.assertRaises(RuntimeError):
            self.install(body)
        self.assertFalse((self.root / 'escaped').exists())

    def test_absolute_path_is_rejected(self):
        with self.assertRaises(RuntimeError):
            self.install(archive([('/outside', 'file', b'forbidden')]))

    def test_symbolic_and_hard_links_are_rejected(self):
        for kind in ('symlink', 'hardlink'):
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                self.install(archive([('outside-link', kind, '/etc/passwd')]))

    def test_duplicate_archive_member_is_rejected(self):
        with self.assertRaises(RuntimeError):
            self.install(archive([('a', 'file', b'1'), ('a', 'file', b'2')]))

    def test_expansion_limit_is_enforced_before_write(self):
        with patch.object(launch, 'MAX_EXPANDED', 2), self.assertRaises(RuntimeError):
            self.install(archive([('large', 'file', b'123')]))

    def test_download_limit_with_and_without_content_length(self):
        body = valid_bundle()
        for announced in (True, False):
            with self.subTest(announced=announced), patch.object(launch, 'MAX_DOWNLOAD', 5):
                with self.assertRaises(RuntimeError):
                    self.install(body, announced=announced)

    def test_operator_digest_is_required_and_checked(self):
        for expected in ('not-a-digest', '0' * 64):
            with self.subTest(expected=expected), self.assertRaises(RuntimeError):
                self.install(valid_bundle(), expected=expected)

    def test_rewriting_cached_manifest_does_not_authorize_new_payload(self):
        body = valid_bundle()
        root = self.install(body)
        payload = root / 'bin/harmony-server'
        payload.chmod(0o600)
        payload.write_bytes(b'changed')
        manifest = root / 'manifest.json'
        manifest.chmod(0o600)
        record = json.loads(manifest.read_text())
        record['files']['bin/harmony-server'] = hashlib.sha256(b'changed').hexdigest()
        manifest.write_text(json.dumps(record))
        with self.assertRaises(RuntimeError):
            self.install(body)

    def test_config_rejects_duplicates_and_loader_injection(self):
        target = self.root / 'harmony-config.json'
        for body in ('{"HARMONY_JWT_SECRET":"a","HARMONY_JWT_SECRET":"b"}',
                     '{"LD_PRELOAD":"/untrusted"}'):
            target.write_text(body)
            target.chmod(0o600)
            with self.subTest(body=body), self.assertRaises(RuntimeError):
                launch.load_configuration()

    def test_image_mapping_does_not_hide_a_privileged_kernel_identity(self):
        import copy
        observed = {'uid': 987, 'gid': 987, 'groups': [987], 'kernel': {
            'Uid': '987 987 987 987', 'Gid': '987 987 987 987', 'Groups': '987',
            'CapPrm': '0000000000000000', 'CapEff': '0000000000000000', 'NoNewPrivs': '1'}}
        self.assertTrue(launch.unprivileged_identity(observed))
        changes = [('Uid', '0 0 0 0'), ('Gid', '0 0 0 0'), ('Groups', '0 987'),
                   ('CapEff', '0000000000000001'), ('CapPrm', '0000000000000001'),
                   ('NoNewPrivs', '0')]
        for key, value in changes:
            unsafe = copy.deepcopy(observed)
            unsafe['kernel'][key] = value
            with self.subTest(key=key):
                self.assertFalse(launch.unprivileged_identity(unsafe))
        mapped = copy.deepcopy(observed)
        mapped['uid'] = 10001
        self.assertFalse(launch.unprivileged_identity(mapped))
        del observed['kernel']['Uid']
        self.assertFalse(launch.unprivileged_identity(observed))

    def test_config_cannot_be_world_readable(self):
        target = self.root / 'harmony-config.json'
        target.write_text('{}')
        target.chmod(0o644)
        with self.assertRaises(RuntimeError):
            launch.load_configuration()


if __name__ == '__main__':
    unittest.main()
