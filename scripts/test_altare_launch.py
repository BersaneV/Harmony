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


class OptionalScreenSfu(unittest.TestCase):
    def test_audio_release_requires_source_pin(self):
        original = (launch.VERSION, launch.VERIFIED_PRODUCT, launch.ASSET_URL)
        try:
            with patch.dict(os.environ, {'HARMONY_DEPLOYMENT_VERSION':'0.4.13'}, clear=True), self.assertRaises(RuntimeError):
                launch.select_release()
            with patch.dict(os.environ, {'HARMONY_DEPLOYMENT_VERSION':'0.4.13','HARMONY_BUNDLE_SOURCE_COMMIT':'b'*40}, clear=True):
                launch.select_release()
                self.assertEqual(launch.VERSION, '0.4.13')
                self.assertEqual(launch.VERIFIED_PRODUCT, 'b'*40)
                self.assertTrue(launch.ASSET_URL.endswith('/v0.4.13/harmony-server-0.4.13-linux-x86_64.tar.gz'))
        finally:
            launch.VERSION, launch.VERIFIED_PRODUCT, launch.ASSET_URL = original

    def test_invite_release_requires_source_pin_and_preserves_rollback(self):
        original = (launch.VERSION, launch.VERIFIED_PRODUCT, launch.ASSET_URL)
        try:
            for pin in ('', 'bad'):
                with patch.dict(os.environ, {'HARMONY_DEPLOYMENT_VERSION':'0.4.12','HARMONY_BUNDLE_SOURCE_COMMIT':pin}, clear=True), self.assertRaises(RuntimeError):
                    launch.select_release()
            with patch.dict(os.environ, {'HARMONY_DEPLOYMENT_VERSION':'0.4.12','HARMONY_BUNDLE_SOURCE_COMMIT':'a'*40}, clear=True):
                launch.select_release()
                self.assertEqual(launch.VERSION, '0.4.12')
                self.assertEqual(launch.VERIFIED_PRODUCT, 'a'*40)
                self.assertTrue(launch.ASSET_URL.endswith('/v0.4.12/harmony-server-0.4.12-linux-x86_64.tar.gz'))
            with patch.dict(os.environ, {}, clear=True):
                launch.select_release()
                self.assertEqual(launch.VERSION, '0.4.1')
        finally:
            launch.VERSION, launch.VERIFIED_PRODUCT, launch.ASSET_URL = original

    def test_invite_release_keeps_optional_screen_sfu_on_existing_port(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); runtime, state = root / 'runtime', root / 'state'
            (runtime / 'bin').mkdir(parents=True); state.mkdir()
            (runtime / 'bin/livekit-server').write_bytes(b'fixture')
            environment = {'LIVEKIT_API_KEY':'fixture-key', 'LIVEKIT_API_SECRET':'x'*40,
                'HARMONY_MEDIA_TRANSPORT':'p2p','LIVEKIT_API_URL':'http://127.0.0.1:7880',
                'HARMONY_PUBLIC_API_URL':'https://example.invalid','LIVEKIT_URL':'wss://example.invalid'}
            with patch.object(launch, 'VERSION', '0.4.12'), patch.dict(os.environ, environment, clear=True):
                launch.configure_screen_sfu(runtime, state, 25094)
                self.assertEqual(json.loads((state/'livekit.json').read_text())['rtc']['udp_port'], 25094)

    def test_candidate_requires_operator_source_pin_and_rollback_restores_original(self):
        original = (launch.VERSION, launch.VERIFIED_PRODUCT, launch.ASSET_URL)
        try:
            for configuration in ({'HARMONY_DEPLOYMENT_VERSION': 'latest'}, {'HARMONY_DEPLOYMENT_VERSION':'0.4.3'}, {'HARMONY_DEPLOYMENT_VERSION':'0.4.3','HARMONY_BUNDLE_SOURCE_COMMIT':'bad'}):
                with patch.dict(os.environ, configuration, clear=True), self.assertRaises(RuntimeError): launch.select_release()
            with patch.dict(os.environ, {'HARMONY_DEPLOYMENT_VERSION':'0.4.3','HARMONY_BUNDLE_SOURCE_COMMIT':'a'*40}, clear=True):
                launch.select_release()
                self.assertEqual(launch.VERSION, '0.4.3')
                self.assertEqual(launch.VERIFIED_PRODUCT, 'a'*40)
                self.assertTrue(launch.ASSET_URL.endswith('/v0.4.3/harmony-server-0.4.3-linux-x86_64.tar.gz'))
            with patch.dict(os.environ, {}, clear=True):
                launch.select_release()
                self.assertEqual(launch.VERSION, '0.4.1')
                self.assertEqual(launch.VERIFIED_PRODUCT, '2ea5c8cfa6eb003d732dbcbe0c4a76ae73bc1f7d')
        finally: launch.VERSION, launch.VERIFIED_PRODUCT, launch.ASSET_URL = original

    def test_private_configuration_uses_only_loopback_signaling_and_existing_udp_port(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); runtime, state = root / 'runtime', root / 'state'
            (runtime / 'bin').mkdir(parents=True); state.mkdir()
            (runtime / 'bin/livekit-server').write_bytes(b'verified-runtime-fixture')
            secret = 'random-fixture-"\\\n' + 'x'*40
            environment = {'LIVEKIT_API_KEY':'fixture-key', 'LIVEKIT_API_SECRET':secret,
                           'HARMONY_MEDIA_TRANSPORT':'p2p','LIVEKIT_API_URL':'http://127.0.0.1:7880',
                           'HARMONY_PUBLIC_API_URL':'https://example.invalid','LIVEKIT_URL':'wss://example.invalid'}
            with patch.object(launch, 'VERSION', '0.4.3'), patch.dict(os.environ, environment, clear=True):
                launch.configure_screen_sfu(runtime, state, 25094)
                path = state / 'livekit.json'; config = json.loads(path.read_text())
                self.assertEqual(path.stat().st_mode & 0o777, 0o400)
                self.assertEqual(config['keys']['fixture-key'], secret)
                self.assertEqual(config['bind_addresses'], ['127.0.0.1'])
                self.assertEqual(config['rtc']['udp_port'], 25094)
                self.assertEqual(config['rtc']['tcp_port'], 0)
                self.assertFalse(config['turn']['enabled'])
                self.assertEqual(os.environ['HARMONY_LIVEKIT_BIN'], str(runtime / 'bin/livekit-server'))
                self.assertEqual(os.environ['HARMONY_LIVEKIT_CONFIG'], str(path))
                for invalid_port in (0, 7880, 65536):
                    with self.assertRaises(RuntimeError): launch.configure_screen_sfu(runtime, state, invalid_port)
                for name, value in [('LIVEKIT_API_URL','http://169.254.169.254'), ('LIVEKIT_URL','wss://attacker.invalid'), ('HARMONY_MEDIA_TRANSPORT','livekit'), ('LIVEKIT_API_SECRET','short')]:
                    with patch.dict(os.environ, {name:value}), self.assertRaises(RuntimeError): launch.configure_screen_sfu(runtime, state, 25094)
                (runtime / 'bin/livekit-server').unlink()
                (runtime / 'bin/livekit-server').symlink_to('/bin/false')
                with self.assertRaises(RuntimeError): launch.configure_screen_sfu(runtime, state, 25094)

if __name__ == '__main__':
    unittest.main()
