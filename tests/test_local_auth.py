"""Password sign-in (MYFLIX_AUTH=password): cookie signing, throttling, and the HTTP flow.
Run: python3 -m unittest discover -s tests -v   (from the project root)"""
import http.client
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import local_auth  # noqa: E402
import server  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


class LocalAuthTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.key = Path(self.dir.name) / "session.key"
        self.clock = Clock()
        self.auth = local_auth.LocalAuth("correct horse", self.key, clock=self.clock)

    def tearDown(self):
        self.dir.cleanup()

    def test_short_password_refused(self):
        with self.assertRaises(ValueError):
            local_auth.LocalAuth("short", self.key)

    def test_password_check(self):
        self.assertTrue(self.auth.check_password("correct horse"))
        self.assertFalse(self.auth.check_password("correct horse "))
        self.assertFalse(self.auth.check_password(""))

    def test_key_file_is_private_and_reused(self):
        self.assertEqual(self.key.stat().st_mode & 0o777, 0o600)
        again = local_auth.LocalAuth("correct horse", self.key, clock=self.clock)
        self.assertTrue(again.valid_cookie(self.auth.make_cookie()))

    def test_cookie_valid_then_expires(self):
        c = self.auth.make_cookie()
        self.assertTrue(self.auth.valid_cookie(c))
        self.clock.t += self.auth.ttl + 1
        self.assertFalse(self.auth.valid_cookie(c))

    def test_tampered_or_garbage_cookie_rejected(self):
        exp, sig = self.auth.make_cookie().split(".")
        for bad in ("", "x", exp + ".", "." + sig, str(int(exp) + 999) + "." + sig, exp + "." + sig[:-1] + "0"):
            self.assertFalse(self.auth.valid_cookie(bad), bad)

    def test_changing_password_signs_everyone_out(self):
        c = self.auth.make_cookie()
        other = local_auth.LocalAuth("a different one", self.key, clock=self.clock)
        self.assertFalse(other.valid_cookie(c))

    def test_throttle_after_five_failures_then_recovers(self):
        for _ in range(local_auth.MAX_FAILS):
            self.assertEqual(self.auth.retry_after("1.2.3.4"), 0)
            self.auth.record_fail("1.2.3.4")
        self.assertGreater(self.auth.retry_after("1.2.3.4"), 0)
        self.assertEqual(self.auth.retry_after("5.6.7.8"), 0)   # other clients are unaffected
        self.clock.t += local_auth.WINDOW + 1
        self.assertEqual(self.auth.retry_after("1.2.3.4"), 0)

    def test_success_clears_failures(self):
        self.auth.record_fail("1.2.3.4")
        self.auth.clear("1.2.3.4")
        self.assertEqual(self.auth.retry_after("1.2.3.4"), 0)

    def test_set_password_persists_and_signs_others_out(self):
        store = Path(self.dir.name) / "auth.json"
        a = local_auth.LocalAuth("correct horse", self.key, clock=self.clock, store_path=store)
        old_cookie = a.make_cookie()
        a.set_password("brand new pass")
        self.assertFalse(a.check_password("correct horse"))
        self.assertTrue(a.check_password("brand new pass"))
        self.assertFalse(a.valid_cookie(old_cookie))
        self.assertTrue(a.valid_cookie(a.make_cookie()))
        self.assertEqual(store.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("brand new pass", store.read_text())
        again = local_auth.LocalAuth("correct horse", self.key, clock=self.clock, store_path=store)   # restart
        self.assertTrue(again.check_password("brand new pass"))
        self.assertFalse(again.check_password("correct horse"))

    def test_editing_the_env_password_overrides_the_stored_one(self):
        store = Path(self.dir.name) / "auth.json"
        a = local_auth.LocalAuth("correct horse", self.key, clock=self.clock, store_path=store)
        a.set_password("brand new pass")
        b = local_auth.LocalAuth("edited in env file", self.key, clock=self.clock, store_path=store)
        self.assertTrue(b.check_password("edited in env file"))
        self.assertFalse(b.check_password("brand new pass"))

    def test_set_password_rules(self):
        store = Path(self.dir.name) / "auth.json"
        a = local_auth.LocalAuth("correct horse", self.key, clock=self.clock, store_path=store)
        with self.assertRaises(ValueError):
            a.set_password("short")
        with self.assertRaises(ValueError):   # no store configured
            self.auth.set_password("long enough pass")

    def test_password_from_file(self):
        f = Path(self.dir.name) / "pw"
        f.write_text("from-a-file\n")
        self.assertEqual(local_auth.load_password({"MYFLIX_PASSWORD_FILE": str(f)}), "from-a-file")
        self.assertEqual(local_auth.load_password({"MYFLIX_PASSWORD": "env-wins", "MYFLIX_PASSWORD_FILE": str(f)}), "env-wins")


class HttpFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls._saved = (server.LOCAL_AUTH, server.DEV, server.INTRUDERS_FILE, server.DATA, server.SETTINGS_FILE,
                      server.SESSIONS_FILE, server._sessions, server.jf)
        server.DATA = Path(cls.dir.name)
        server.SETTINGS_FILE = Path(cls.dir.name) / "settings.json"
        server.SESSIONS_FILE, server._sessions = Path(cls.dir.name) / "sessions.json", None
        server.upsert_profile("owner@local", {"userId": "c" * 32, "name": "admin", "token": "t"})
        cls.admin = {"v": True}   # what the fake Jellyfin says about the signed-in profile
        server.jf = lambda profile, method, path, *a, **k: {"Policy": {"IsAdministrator": cls.admin["v"]}}
        server.INTRUDERS_FILE = Path(cls.dir.name) / "intruders.jsonl"
        server.DEV = False
        server.LOCAL_AUTH = local_auth.LocalAuth("correct horse", Path(cls.dir.name) / "session.key",
                                                  store_path=Path(cls.dir.name) / "auth.json")
        server.OWNER_EMAILS.add("owner@local")
        cls.srv = server.Server(("127.0.0.1", 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        (server.LOCAL_AUTH, server.DEV, server.INTRUDERS_FILE, server.DATA, server.SETTINGS_FILE,
         server.SESSIONS_FILE, server._sessions, server.jf) = cls._saved
        cls.dir.cleanup()

    def setUp(self):
        self.admin["v"] = True
        server._admin_cache.clear()
        server.LOCAL_AUTH.clear("127.0.0.1")   # all tests share one client address; keep the lockout from leaking across them
        server.LOCAL_AUTH.set_password("correct horse")   # and the password change test must not leak either

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = dict(headers or {})
        if body is not None:
            h["Content-Type"] = "application/x-www-form-urlencoded"
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def test_unauthenticated_page_shows_login_and_api_is_401(self):
        r, body = self.req("GET", "/")
        self.assertEqual(r.status, 401)
        self.assertIn(b'name="password"', body)
        r, _ = self.req("GET", "/api/me")
        self.assertEqual(r.status, 401)

    def test_healthz_needs_no_login(self):
        r, _ = self.req("GET", "/healthz")
        self.assertEqual(r.status, 200)

    def test_wrong_password_is_rejected_without_cookie(self):
        r, body = self.req("POST", "/login", "password=nope")
        self.assertEqual(r.status, 401)
        self.assertIsNone(r.getheader("Set-Cookie"))
        self.assertIn(b"Wrong password", body)

    def test_right_password_sets_cookie_that_opens_the_api(self):
        r, _ = self.req("POST", "/login", "password=correct+horse")
        self.assertEqual(r.status, 303)
        cookie = r.getheader("Set-Cookie")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)
        pair = cookie.split(";")[0]
        r, body = self.req("GET", "/api/me", headers={"Cookie": pair})
        self.assertEqual(r.status, 200)
        self.assertIn(b"owner@local", body)
        r, _ = self.req("GET", "/api/me", headers={"Cookie": pair[:-3] + "abc"})
        self.assertEqual(r.status, 401)

    def test_cross_site_login_post_is_refused(self):
        r, _ = self.req("POST", "/login", "password=correct+horse", {"Origin": "https://evil.example"})
        self.assertEqual(r.status, 403)

    def test_login_page_lets_the_browser_send_a_real_origin(self):
        # Under "no-referrer" browsers send "Origin: null" on the form POST and the login is refused.
        for path in ("/", "/login"):
            r, _ = self.req("GET", path)
            self.assertEqual(r.getheader("Referrer-Policy"), "same-origin", path)
        r, body = self.req("POST", "/login", "password=wrong-one")
        self.assertEqual(r.getheader("Referrer-Policy"), "same-origin")

    def test_null_origin_login_post_is_refused(self):
        r, _ = self.req("POST", "/login", "password=correct+horse", {"Origin": "null"})
        self.assertEqual(r.status, 403)

    def login(self):
        r, _ = self.req("POST", "/login", "password=correct+horse")
        return r.getheader("Set-Cookie").split(";")[0]

    def post_json(self, path, obj, cookie):
        import json as _j
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", path, body=_j.dumps(obj), headers={"Content-Type": "application/json", "Cookie": cookie,
                                                              "X-MyFlix-Profile": "c" * 32})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def test_settings_need_login(self):
        r, _ = self.req("GET", "/api/settings")
        self.assertEqual(r.status, 401)

    def test_theme_roundtrip_and_validation(self):
        ck = self.login()
        r, body = self.post_json("/api/settings/theme", {"accent": "#800000"}, ck)
        self.assertEqual(r.status, 200)
        r, body = self.req("GET", "/api/me", headers={"Cookie": ck})
        self.assertIn(b'"accent":"#800000"', body)
        for bad in ("red", "#12", "#gggggg", "javascript:alert(1)", 5):
            r, _ = self.post_json("/api/settings/theme", {"accent": bad}, ck)
            self.assertEqual(r.status, 400, bad)
        r, _ = self.post_json("/api/settings/theme", {"accent": None}, ck)
        self.assertEqual(r.status, 200)
        r, body = self.req("GET", "/api/settings", headers={"Cookie": ck})
        self.assertIn(b'"accent":null', body)

    def test_only_a_jellyfin_administrator_can_set_the_theme_for_everyone(self):
        ck = self.login()
        self.admin["v"] = False
        server._admin_cache.clear()
        r, _ = self.post_json("/api/settings/theme", {"accent": "#800000"}, ck)
        self.assertEqual(r.status, 403)                      # even though owner@local is an owner email
        r, body = self.req("GET", "/api/settings", headers={"Cookie": ck, "X-MyFlix-Profile": "c" * 32})
        self.assertIn(b'"canSetGlobalTheme":false', body)
        r, body = self.req("GET", "/api/me", headers={"Cookie": ck})
        self.assertNotIn(b'"accent":"#800000"', body)         # nothing was saved
        self.admin["v"] = True
        server._admin_cache.clear()
        r, _ = self.post_json("/api/settings/theme", {"accent": "#800000"}, ck)
        self.assertEqual(r.status, 200)
        r, body = self.req("GET", "/api/settings", headers={"Cookie": ck, "X-MyFlix-Profile": "c" * 32})
        self.assertIn(b'"canSetGlobalTheme":true', body)
        self.post_json("/api/settings/theme", {"accent": None}, ck)

    def test_a_jellyfin_failure_means_no(self):
        ck = self.login()
        server.jf = lambda *a, **k: (_ for _ in ()).throw(server.UpstreamError(502, "down"))
        server._admin_cache.clear()
        try:
            r, _ = self.post_json("/api/settings/theme", {"accent": "#800000"}, ck)
        finally:
            server.jf = lambda profile, method, path, *a, **k: {"Policy": {"IsAdministrator": self.admin["v"]}}
        self.assertEqual(r.status, 403)

    def test_secondary_colour_is_saved_independently(self):
        ck = self.login()
        self.post_json("/api/settings/theme", {"accent": "#64212f"}, ck)
        r, _ = self.post_json("/api/settings/theme", {"secondary": "#14213d"}, ck)
        self.assertEqual(r.status, 200)
        r, body = self.req("GET", "/api/me", headers={"Cookie": ck})
        self.assertIn(b'"accent":"#64212f"', body)       # setting one leaves the other alone
        self.assertIn(b'"secondary":"#14213d"', body)
        r, _ = self.post_json("/api/settings/theme", {"secondary": "navy"}, ck)
        self.assertEqual(r.status, 400)
        r, _ = self.post_json("/api/settings/theme", {"accent": "#800000", "secondary": "bad"}, ck)
        self.assertEqual(r.status, 400)
        r, body = self.req("GET", "/api/me", headers={"Cookie": ck})
        self.assertIn(b'"accent":"#64212f"', body)       # a rejected request saved nothing
        r, _ = self.post_json("/api/settings/theme", {}, ck)
        self.assertEqual(r.status, 400)
        self.post_json("/api/settings/theme", {"accent": None, "secondary": None}, ck)

    def test_change_password_flow(self):
        ck = self.login()
        r, _ = self.post_json("/api/settings/password", {"current": "wrong", "new": "another good one"}, ck)
        self.assertEqual(r.status, 403)
        r, _ = self.post_json("/api/settings/password", {"current": "correct horse", "new": "short"}, ck)
        self.assertEqual(r.status, 400)
        r, _ = self.post_json("/api/settings/password", {"current": "correct horse", "new": "another good one"}, ck)
        self.assertEqual(r.status, 200)
        new_ck = r.getheader("Set-Cookie").split(";")[0]
        r, _ = self.req("GET", "/api/settings", headers={"Cookie": ck})
        self.assertEqual(r.status, 401)        # old session is signed out
        r, _ = self.req("GET", "/api/settings", headers={"Cookie": new_ck})
        self.assertEqual(r.status, 200)
        r, _ = self.req("POST", "/login", "password=correct+horse")
        self.assertEqual(r.status, 401)
        r, _ = self.req("POST", "/login", "password=another+good+one")
        self.assertEqual(r.status, 303)

    def test_logout_clears_cookie(self):
        r, _ = self.req("POST", "/logout", "")
        self.assertEqual(r.status, 303)
        self.assertIn("Max-Age=0", r.getheader("Set-Cookie"))


if __name__ == "__main__":
    unittest.main()
