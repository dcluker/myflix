"""Fixes from the 2026-11-03 QA pass: registry survives a landing outage for LAN devices, sliding LAN cookie."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class RegistryCache(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "reg.json"
        self.now = [1000.0]
        self.up = [True]

    def tearDown(self):
        self.dir.cleanup()

    def reg(self):
        r = server.DeviceRegistry("http://x", lambda: "t", clock=lambda: self.now[0], ttl=300, stale_max=3600,
                                  miss_refresh=0, retry_after_fail=0, cache_path=self.path)
        r._fetch = lambda: ({"dev": {"email": "a@b", "revoked": False}}, "") if self.up[0] else (None, "down")
        return r

    def test_saved_and_loaded_after_restart_while_landing_down(self):
        self.assertEqual(self.reg().lookup("dev")["email"], "a@b")
        self.assertTrue(self.path.exists())
        self.assertEqual(oct(self.path.stat().st_mode & 0o777), "0o600")
        self.up[0] = False
        self.now[0] += 2 * 3600          # T14 restarted two hours later, landing still down
        r = self.reg()
        self.assertIsNone(r.lookup("dev"))                                         # public path: fail closed
        self.assertEqual(r.lookup("dev", server.REGISTRY_LAN_STALE_MAX)["email"], "a@b")   # LAN path: still works

    def test_lan_window_also_expires(self):
        self.reg().lookup("dev")
        self.up[0] = False
        self.now[0] += server.REGISTRY_LAN_STALE_MAX + 1
        self.assertIsNone(self.reg().lookup("dev", server.REGISTRY_LAN_STALE_MAX))

    def test_corrupt_cache_ignored(self):
        self.path.write_text("{nope")
        self.up[0] = False
        self.assertIsNone(self.reg().lookup("dev", server.REGISTRY_LAN_STALE_MAX))

    def test_revoked_in_cached_copy_still_denied(self):
        self.path.write_text(json.dumps({"at": self.now[0], "devices": {"dev": {"email": "a@b", "revoked": True}}}))
        self.up[0] = False
        email, _ = server.resolve_service_identity({"common_name": "dev"}, None, registry=self.reg(),
                                                   stale_max=server.REGISTRY_LAN_STALE_MAX)
        self.assertIsNone(email)


class SlidingCookie(unittest.TestCase):
    def test_left(self):
        c = server.lan_cookie_make("dev", now=1000)
        self.assertEqual(server.lan_cookie_left(c, now=1000), server.LAN_COOKIE_TTL)
        self.assertEqual(server.lan_cookie_left(c, now=1000 + server.LAN_COOKIE_TTL + 5), 0)
        self.assertEqual(server.lan_cookie_left("junk"), 0)
        self.assertEqual(server.lan_cookie_left(None), 0)


class PickNext(unittest.TestCase):
    def e(self, i, s, n, **kw):
        return dict({"Id": i, "ParentIndexNumber": s, "IndexNumber": n}, **kw)

    def test_skips_virtual_and_duplicates(self):
        cur = self.e("a", 1, 3)
        self.assertEqual(server._pick_next(cur, [self.e("v", 1, 4, LocationType="Virtual"), self.e("d", 1, 3), self.e("b", 1, 5)]), "b")

    def test_unknown_season_series_still_advances(self):
        cur = self.e("a", None, None)
        self.assertEqual(server._pick_next(cur, [self.e("b", None, None)]), "b")


if __name__ == "__main__":
    unittest.main()
