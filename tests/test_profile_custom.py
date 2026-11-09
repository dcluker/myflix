"""Profile customisation: display name, avatar (emoji / uploaded photo), per-profile theme.
Run: python3 -m unittest discover -s tests -v   (from the project root)"""
import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import local_auth  # noqa: E402
import server  # noqa: E402

UID = "a" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


class ProfileCustomTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        d = Path(cls.dir.name)
        cls._saved = (server.LOCAL_AUTH, server.DEV, server.INTRUDERS_FILE, server.DATA, server.SESSIONS_FILE,
                      server._sessions, server.AVATAR_DIR, server.SETTINGS_FILE)
        server.DATA, server.SESSIONS_FILE, server._sessions = d, d / "sessions.json", None
        server.AVATAR_DIR, server.INTRUDERS_FILE, server.SETTINGS_FILE = d / "avatars", d / "i.jsonl", d / "settings.json"
        server.DEV = False
        server.LOCAL_AUTH = local_auth.LocalAuth("correct horse", d / "session.key", store_path=d / "auth.json")
        server.OWNER_EMAILS.add("owner@local")
        server.upsert_profile("owner@local", {"userId": UID, "name": "admin", "token": "t"})
        cls.srv = server.Server(("127.0.0.1", 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        r = cls.raw("POST", "/login", b"password=correct+horse", {"Content-Type": "application/x-www-form-urlencoded"})
        cls.cookie = r[0].getheader("Set-Cookie").split(";")[0]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        (server.LOCAL_AUTH, server.DEV, server.INTRUDERS_FILE, server.DATA, server.SESSIONS_FILE,
         server._sessions, server.AVATAR_DIR, server.SETTINGS_FILE) = cls._saved
        cls.dir.cleanup()

    @classmethod
    def raw(cls, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=10)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def call(self, method, path, body=None, ctype="application/json", cookie=True):
        h = {"Content-Type": ctype}
        if cookie:
            h["Cookie"] = self.cookie
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        return self.raw(method, path, body, h)

    def custom(self, **fields):
        r, data = self.call("POST", "/api/profiles/customize", {"userId": UID, **fields})
        return r.status, (json.loads(data) if data else None)

    def setUp(self):
        self.custom(display=None, avatar=None, theme=None)
        server.LOCAL_AUTH.clear("127.0.0.1")

    def test_display_name_is_cleaned_and_clearable(self):
        st, p = self.custom(display="  Dad \u0007 the  Great  ")
        self.assertEqual(st, 200)
        self.assertEqual(p["display"], "Dad  the  Great")
        self.assertEqual(p["name"], "admin")            # the sign-in name never changes
        st, p = self.custom(display="x" * 100)
        self.assertEqual(len(p["display"]), 24)
        st, p = self.custom(display="")
        self.assertNotIn("display", p)
        self.assertEqual(self.custom(display=5)[0], 400)

    def test_emoji_avatar_validation(self):
        st, p = self.custom(avatar={"kind": "emoji", "emoji": "\U0001F98A", "color": "#64212F"})
        self.assertEqual(st, 200)
        self.assertEqual(p["avatar"], {"kind": "emoji", "emoji": "\U0001F98A", "color": "#64212f"})
        st, p = self.custom(avatar={"kind": "emoji", "emoji": "\U0001F468\u200D\U0001F680", "color": "#112233"})   # a joined emoji survives
        self.assertEqual(p["avatar"]["emoji"], "\U0001F468\u200D\U0001F680")
        for bad in ({"kind": "emoji", "emoji": "hello", "color": "#112233"}, {"kind": "emoji", "emoji": "", "color": "#112233"}, {"kind": "emoji", "emoji": "x", "color": "red"},
                    {"kind": "photo"}, {"kind": "url", "url": "http://x"}, "emoji"):
            self.assertEqual(self.custom(avatar=bad)[0], 400, bad)
        st, p = self.custom(avatar={"kind": "letter"})
        self.assertNotIn("avatar", p)

    def test_profile_theme(self):
        st, p = self.custom(theme={"accent": "#64212f", "secondary": "#14213d"})
        self.assertEqual(p["theme"], {"accent": "#64212f", "secondary": "#14213d"})
        r, body = self.call("GET", "/api/me")
        me = json.loads(body)
        self.assertEqual(me["profiles"][0]["theme"]["accent"], "#64212f")
        for bad in ({"accent": "maroon"}, {"nope": "#112233"}, "dark"):
            self.assertEqual(self.custom(theme=bad)[0], 400, bad)
        self.assertNotIn("theme", self.custom(theme=None)[1])

    def test_unknown_profile_and_empty_requests(self):
        r, _ = self.call("POST", "/api/profiles/customize", {"userId": "b" * 32, "display": "x"})
        self.assertEqual(r.status, 404)
        self.assertEqual(self.custom()[0], 400)
        r, _ = self.call("POST", "/api/profiles/customize", {"display": "x"})
        self.assertEqual(r.status, 400)
        r, _ = self.call("POST", "/api/profiles/customize", {"userId": UID, "display": "x"}, cookie=False)
        self.assertEqual(r.status, 401)

    def test_photo_upload_serve_and_remove(self):
        r, data = self.call("POST", "/api/profiles/photo?userId=" + UID, JPEG, ctype="image/jpeg")
        self.assertEqual(r.status, 200)
        p = json.loads(data)
        self.assertEqual(p["avatar"]["kind"], "photo")
        self.assertTrue(p["avatar"]["url"].startswith("/api/avatar/" + UID))
        r, body = self.call("GET", p["avatar"]["url"])
        self.assertEqual((r.status, body), (200, JPEG))
        self.assertEqual(r.getheader("Content-Type"), "image/jpeg")
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        self.assertIn("default-src 'none'", r.getheader("Content-Security-Policy"))
        r, _ = self.call("GET", p["avatar"]["url"], cookie=False)
        self.assertEqual(r.status, 401)
        st, p = self.custom(avatar={"kind": "letter"})     # removing the avatar deletes the file
        self.assertFalse((server.AVATAR_DIR / (UID + ".bin")).exists())
        r, _ = self.call("GET", "/api/avatar/" + UID)
        self.assertEqual(r.status, 404)

    def test_photo_rejections(self):
        up = lambda body, ct, uid=UID: self.call("POST", "/api/profiles/photo?userId=" + uid, body, ctype=ct)[0].status
        self.assertEqual(up(b"GIF89a" + b"\x00" * 40, "image/gif"), 415)             # type not allowed
        self.assertEqual(up(b"<svg onload=alert(1)>", "image/jpeg"), 415)             # lying content type
        self.assertEqual(up(JPEG, "text/html"), 415)
        self.assertEqual(up(b"RIFF\x00\x00\x00\x00WAVE" + b"\x00" * 20, "image/webp"), 415)
        self.assertEqual(up(b"\xff\xd8\xff" + b"\x00" * server.AVATAR_MAX, "image/jpeg"), 413)   # too big
        self.assertEqual(up(JPEG, "image/jpeg", "b" * 32), 404)                       # not your profile
        self.assertEqual(up(JPEG, "image/jpeg", "nope"), 400)
        self.assertFalse((server.AVATAR_DIR / (UID + ".bin")).exists())


if __name__ == "__main__":
    unittest.main()
