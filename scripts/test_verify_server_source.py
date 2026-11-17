import unittest
from verify_server_source import unchanged_product

class ServerSourceGuard(unittest.TestCase):
    def test_only_exact_desktop_fixture_and_documentation_can_change(self):
        self.assertTrue(unchanged_product(['scripts/test_windows_audio.mjs','docs/releases/0.4.14.md','.github/workflows/desktop-proof.yml']))
        for path in ['apps/desktop/src/lib/useCallShortcuts.ts','Cargo.toml','package-lock.json','.github/workflows/verify.yml','crates/server/src/main.rs','scripts/test_call_screen_sfu.mjs']:
            self.assertFalse(unchanged_product([path]), path)
