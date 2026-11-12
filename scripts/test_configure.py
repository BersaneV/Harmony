import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("configure", Path(__file__).with_name("configure.py"))
configure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure)


class ConfigurationSecurity(unittest.TestCase):
    def test_secrets_are_unique_between_instances(self):
        one, two = configure.configuration()[0], configure.configuration()[0]
        for key in ("POSTGRES_PASSWORD", "HARMONY_JWT_SECRET", "HARMONY_BOOTSTRAP_PASSWORD", "LIVEKIT_API_SECRET", "S3_SECRET_KEY"):
            self.assertNotEqual(one[key], two[key])
            self.assertGreaterEqual(len(one[key]), 32)

    def test_domain_cannot_inject_routes_or_secrets(self):
        for invalid in ("https://example.org", "a\nkeys: bad", "example.org/other", "example..org", "example.org:443", "$(command).org"):
            with self.assertRaises(ValueError):
                configure.configuration(invalid)

    def test_existing_secrets_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            configure.write_private(path, "original")
            with self.assertRaises(FileExistsError):
                configure.write_private(path, "replacement")
            self.assertEqual(path.read_text(), "original")
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_storage_has_no_anonymous_identity(self):
        env, storage, _, _ = configure.configuration("example.org")
        for identity in storage["identities"]:
            self.assertTrue(identity["credentials"])
            self.assertNotEqual(identity["name"], "anonymous")
        self.assertTrue(env["S3_PUBLIC_ENDPOINT"].startswith("https://"))

    def test_livekit_control_api_is_never_public_plaintext(self):
        _, _, livekit, _ = configure.configuration("example.org")
        self.assertEqual(livekit["bind_addresses"], ["127.0.0.1"])
        self.assertTrue(livekit["turn"]["external_tls"])
        self.assertTrue(livekit["turn"]["proxy_protocol"])


if __name__ == "__main__":
    unittest.main()
