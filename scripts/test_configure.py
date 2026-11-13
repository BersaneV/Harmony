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
        for key in ("HARMONY_JWT_SECRET", "HARMONY_BOOTSTRAP_PASSWORD", "LIVEKIT_API_SECRET"):
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

    def test_embedded_profile_has_no_database_or_storage_credentials(self):
        env, storage, _, caddy = configure.configuration("example.org")
        self.assertTrue(env["DATABASE_URL"].startswith("sqlite:"))
        self.assertEqual(env["HARMONY_STORAGE_BACKEND"], "local")
        self.assertEqual(storage["backend"], "local")
        self.assertFalse(any(k.startswith("S3_") or k == "POSTGRES_PASSWORD" for k in env))
        self.assertEqual(env["HARMONY_PUBLIC_API_URL"], "https://app.example.org")
        self.assertIn("http://127.0.0.1:8080", configure.configuration()[0]["HARMONY_PUBLIC_ORIGIN"].split(","))
        self.assertEqual(env["HARMONY_MEDIA_TRANSPORT"], "p2p")
        self.assertEqual(env["HARMONY_CALL_STUN_URLS"], "stun:stun.l.google.com:19302")
        self.assertEqual(set(caddy["apps"]["http"]["servers"]), {"web"})
        self.assertEqual(caddy["apps"]["tls"]["certificates"]["automate"],
                         ["app.example.org"])
        self.assertEqual(len(caddy["apps"]["layer4"]["servers"]["main"]["routes"]), 1)

    def test_optional_livekit_keeps_all_routes(self):
        env, _, _, caddy = configure.configuration("example.org", media_transport="livekit")
        self.assertEqual(env["HARMONY_MEDIA_TRANSPORT"], "livekit")
        self.assertEqual(set(caddy["apps"]["http"]["servers"]), {"web", "media"})
        self.assertEqual(caddy["apps"]["tls"]["certificates"]["automate"],
                         ["app.example.org", "media.example.org", "turn.example.org"])

    def test_invalid_transport_is_rejected(self):
        with self.assertRaises(ValueError):
            configure.configuration(media_transport="automatic-paid-relay")

    def test_livekit_control_api_is_never_public_plaintext(self):
        _, _, livekit, _ = configure.configuration("example.org", media_transport="livekit")
        self.assertEqual(livekit["bind_addresses"], ["127.0.0.1"])
        self.assertTrue(livekit["turn"]["external_tls"])
        self.assertTrue(livekit["turn"]["proxy_protocol"])


if __name__ == "__main__":
    unittest.main()
