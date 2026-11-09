"""Tests for per-device identity, remote-stream protections and per-email profiles.
No real secrets: the registry is a mock server on a high local port, Jellyfin is a mock too.
Run: python3 -m unittest discover -s tests -v   (from the project root)"""
import http.server
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

FAKE_SECRET = "test-secret-not-real"


class Mock(http.server.ThreadingHTTPServer):
    daemon_threads = True


def start(handler_cls):
    srv = Mock(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]


class RegistryHandler(http.server.BaseHTTPRequestHandler):
    devices = {}
    mode = "ok"       # ok | down | garbage
    hits = 0
    last_token = None

    def log_message(self, *a):
        pass

    def do_GET(self):
        type(self).hits += 1
        type(self).last_token = self.headers.get("X-Internal-Token")
        if self.path != "/tv-devices" or self.headers.get("X-Internal-Token") != FAKE_SECRET:
            self.send_response(403); self.send_header("Content-Length", "0"); self.end_headers(); return
        if self.mode == "down":
            self.send_response(503); self.send_header("Content-Length", "0"); self.end_headers(); return
        body = b"nope" if self.mode == "garbage" else json.dumps({"devices": self.devices}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def dev(email, revoked=False):
    return {"email": email, "name": "N", "label": "TV", "revoked": revoked}


class RegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv, cls.url = start(RegistryHandler)

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        RegistryHandler.devices = {"abc.access": dev("sam@example.com"), "rev.access": dev("x@example.com", True)}
        RegistryHandler.mode = "ok"
        RegistryHandler.hits = 0
        self.clock = Clock()
        self.reg = server.DeviceRegistry(self.url + "/tv-devices", lambda: FAKE_SECRET, clock=self.clock)
        self._old = (server.TV_CLIENT_IDS, server.TV_EMAIL)
        server.TV_CLIENT_IDS, server.TV_EMAIL = frozenset({"legacy.access"}), "owner@example.com"

    def tearDown(self):
        server.TV_CLIENT_IDS, server.TV_EMAIL = self._old

    def ident(self, cn, ip=None):
        return server.resolve_service_identity({"common_name": cn}, ip, self.reg)

    def test_known_device_resolves_with_secret_header(self):
        email, d = self.ident("abc.access")
        self.assertEqual(email, "sam@example.com")
        self.assertEqual(d["path"], "registry")
        self.assertTrue(d["remote"])
        self.assertEqual(RegistryHandler.last_token, FAKE_SECRET)

    def test_suffix_tolerant(self):
        self.assertEqual(self.ident("abc")[0], "sam@example.com")

    def test_unknown_and_revoked_fail_closed(self):
        self.assertEqual(self.ident("nobody.access"), (None, None))
        self.assertEqual(self.ident("rev.access"), (None, None))
        self.assertEqual(server.resolve_service_identity({"common_name": ""}, None, self.reg), (None, None))
        self.assertEqual(server.resolve_service_identity({}, None, self.reg), (None, None))

    def test_legacy_first_and_never_touches_registry(self):
        RegistryHandler.mode = "down"
        email, d = self.ident("legacy.access")
        self.assertEqual((email, d["path"], d["remote"]), ("owner@example.com", "legacy", False))
        self.assertEqual(RegistryHandler.hits, 0)

    def test_legacy_wins_even_if_registry_lists_same_id(self):
        RegistryHandler.devices["legacy.access"] = dev("other@example.com")
        self.assertEqual(self.ident("legacy.access")[0], "owner@example.com")

    def test_cache_five_minutes(self):
        self.ident("abc.access"); self.ident("abc.access")
        self.assertEqual(RegistryHandler.hits, 1)
        self.clock.t += 301
        self.ident("abc.access")
        self.assertEqual(RegistryHandler.hits, 2)

    def test_stale_ok_within_hour_then_closed(self):
        self.assertEqual(self.ident("abc.access")[0], "sam@example.com")
        RegistryHandler.mode = "down"
        self.clock.t += 400
        self.assertEqual(self.ident("abc.access")[0], "sam@example.com")      # stale copy
        self.clock.t += 3000                                                   # 3400 s old
        self.assertEqual(self.ident("abc.access")[0], "sam@example.com")
        self.clock.t += 400                                                    # 3800 s old > 1 h
        self.assertEqual(self.ident("abc.access"), (None, None))

    def test_never_fetched_fails_closed(self):
        RegistryHandler.mode = "down"
        self.assertEqual(self.ident("abc.access"), (None, None))

    def test_garbage_payload_fails_closed(self):
        RegistryHandler.mode = "garbage"
        self.assertEqual(self.ident("abc.access"), (None, None))

    def test_wrong_secret_fails_closed(self):
        reg = server.DeviceRegistry(self.url + "/tv-devices", lambda: "wrong", clock=self.clock)
        self.assertEqual(server.resolve_service_identity({"common_name": "abc.access"}, None, reg), (None, None))
        reg = server.DeviceRegistry(self.url + "/tv-devices", lambda: None, clock=self.clock)   # keychain empty
        self.assertEqual(server.resolve_service_identity({"common_name": "abc.access"}, None, reg), (None, None))

    def test_new_device_found_by_early_refetch_and_revocation_picked_up(self):
        self.ident("abc.access")
        RegistryHandler.devices["new.access"] = dev("new@example.com")
        self.assertEqual(self.ident("new.access"), (None, None))   # within the 10 s miss cooldown
        self.clock.t += 11
        self.assertEqual(self.ident("new.access")[0], "new@example.com")
        RegistryHandler.devices["new.access"] = dev("new@example.com", True)
        self.clock.t += 301
        self.assertEqual(self.ident("new.access"), (None, None))

    def test_home_ip_is_not_remote(self):
        old = server.HOME_IPS
        server.HOME_IPS = frozenset({"203.0.113.9"})
        try:
            self.assertFalse(self.ident("abc.access", "203.0.113.9")[1]["remote"])
            self.assertTrue(self.ident("abc.access", "198.51.100.1")[1]["remote"])
        finally:
            server.HOME_IPS = old


class JellyfinMock(http.server.BaseHTTPRequestHandler):
    bitrate = 8_000_000
    users = {"sam": ("pw1", "a" * 32), "pat": ("pw2", "b" * 32)}

    def log_message(self, *a):
        pass

    def _out(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/Items?"):
            return self._out({"Items": [{"Id": "c" * 32, "Type": "Movie", "Name": "Film", "RunTimeTicks": 72_000_000_000,
                                         "UserData": {}}]})
        self._out({}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/Users/AuthenticateByName":
            pw, uid = self.users.get(body.get("Username"), (None, None))
            if body.get("Pw") != pw:
                return self._out({}, 401)
            return self._out({"AccessToken": "tok-" + body["Username"], "User": {"Id": uid, "Name": body["Username"]}})
        if "/PlaybackInfo" in self.path:
            return self._out({"PlaySessionId": "ps-1", "MediaSources": [{
                "Id": "ms1", "Container": "mkv", "Bitrate": self.bitrate, "MediaStreams": []}]})
        self._out({}, 404)


class EndToEnd(unittest.TestCase):
    """Real Handler in dev mode (X-MyFlix-Dev-Identity) against a mock Jellyfin and a temp sessions file."""

    @classmethod
    def setUpClass(cls):
        cls.jf, jurl = start(JellyfinMock)
        cls.tmp = tempfile.TemporaryDirectory()
        cls._saved = {k: getattr(server, k) for k in ("DEV", "JELLYFIN_URL", "SESSIONS_FILE", "DATA", "_sessions")}
        server.DEV = True
        server.JELLYFIN_URL = jurl
        server.DATA = Path(cls.tmp.name)
        server.SESSIONS_FILE = server.DATA / "sessions.json"
        server._sessions = None
        cls.app, cls.url = start(server.Handler)

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown(); cls.jf.shutdown(); cls.tmp.cleanup()
        for k, v in cls._saved.items():
            setattr(server, k, v)

    def setUp(self):
        JellyfinMock.bitrate = 8_000_000
        server._streams.clear()
        server._link_hits.clear()

    def call(self, method, path, who, body=None, profile=None):
        h = {"X-MyFlix-Dev-Identity": who}
        if profile:
            h["X-MyFlix-Profile"] = profile
        data = None
        if body is not None:
            data = json.dumps(body).encode(); h["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def link(self, who, user, pw):
        return self.call("POST", "/api/profiles/link", who, {"username": user, "password": pw})

    def test_profiles_are_per_email_and_first_link_flow(self):
        a, b = "remote:alice@example.com", "remote:bob@example.com"
        self.assertEqual(self.call("GET", "/api/me", a)[1]["profiles"], [])
        self.assertEqual(self.link(a, "sam", "bad")[0], 400)
        st, prof = self.link(a, "sam", "pw1")
        self.assertEqual(st, 200)
        self.assertNotIn("token", prof)
        self.assertEqual([p["name"] for p in self.call("GET", "/api/me", a)[1]["profiles"]], ["sam"])
        self.assertEqual(self.call("GET", "/api/me", b)[1]["profiles"], [])               # bob sees nothing of alice's
        self.assertEqual(self.call("GET", "/api/playinfo/" + "c" * 32, b, profile=prof["userId"])[0], 403)
        self.assertEqual(self.call("GET", "/api/home", b, profile=prof["userId"])[0], 403)

    def test_link_rate_limit_stays(self):
        who = "remote:rl@example.com"
        codes = [self.link(who, "sam", "bad")[0] for _ in range(6)]
        self.assertEqual(codes, [400] * 5 + [429])

    def test_playinfo_remote_fields_and_public_url(self):
        who = "remote:carol@example.com"
        uid = self.link(who, "sam", "pw1")[1]["userId"]
        st, d = self.call("GET", "/api/playinfo/" + "c" * 32, who, profile=uid)
        self.assertEqual(st, 200, d)
        self.assertEqual((d["lanBase"], d["publicBase"], d["serverId"]), (server.JELLYFIN_URL, server.JELLYFIN_PUBLIC, server.SERVER_ID))
        self.assertTrue(d["remote"])
        self.assertTrue(d["streamUrl"].startswith(server.JELLYFIN_PUBLIC))      # LAN url never handed to a remote device
        self.assertEqual(d["jellyfinBase"], server.JELLYFIN_PUBLIC)
        self.assertEqual(d["streamPath"], "/Videos/%s/stream?static=true&mediaSourceId=ms1&playSessionId=ps-1" % ("c" * 32))
        self.assertEqual(d["streamUrl"], d["publicBase"] + d["streamPath"] + "&api_key=" + d["token"])
        self.assertEqual((d["container"], d["mediaSourceId"], d["playSessionId"], d["itemId"]), ("mkv", "ms1", "ps-1", "c" * 32))

    def test_legacy_playinfo_unchanged(self):
        old = server.TV_EMAIL
        server.TV_EMAIL = "owner@example.com"
        try:
            uid = self.link("tv", "pat", "pw2")[1]["userId"]
            st, d = self.call("GET", "/api/playinfo/" + "c" * 32, "tv", profile=uid)
        finally:
            server.TV_EMAIL = old
        self.assertEqual(st, 200, d)
        self.assertFalse(d["remote"])
        self.assertEqual(d["jellyfinBase"], server.JELLYFIN_URL)
        self.assertEqual(d["streamUrl"], "%s/Videos/%s/stream?static=true&mediaSourceId=ms1&playSessionId=ps-1&api_key=tok-pat" % (server.JELLYFIN_URL, "c" * 32))

    def test_too_high_bitrate_remote_only(self):
        JellyfinMock.bitrate = server.REMOTE_MAX_BITRATE + 1_000_000
        who = "remote:dave@example.com"
        uid = self.link(who, "sam", "pw1")[1]["userId"]
        st, d = self.call("GET", "/api/playinfo/" + "c" * 32, who, profile=uid)
        self.assertEqual((st, d["error"]), (409, "too_high_bitrate"))
        self.assertNotIn("dev-remote", server._streams)                         # no lease taken on refusal
        JellyfinMock.bitrate = server.REMOTE_MAX_BITRATE                        # exactly the cap is allowed
        self.assertEqual(self.call("GET", "/api/playinfo/" + "c" * 32, who, profile=uid)[0], 200)
        JellyfinMock.bitrate = server.REMOTE_MAX_BITRATE * 2                    # legacy TV: no cap
        old = server.TV_EMAIL
        server.TV_EMAIL = "owner@example.com"
        try:
            uid2 = self.link("tv", "pat", "pw2")[1]["userId"]
            self.assertEqual(self.call("GET", "/api/playinfo/" + "c" * 32, "tv", profile=uid2)[0], 200)
        finally:
            server.TV_EMAIL = old

    def test_too_many_streams(self):
        who = "remote:erin@example.com"
        uid = self.link(who, "sam", "pw1")[1]["userId"]
        for i in range(3):
            server.remote_stream_take("other%d" % i, "p", 3600)
        st, d = self.call("GET", "/api/playinfo/" + "c" * 32, who, profile=uid)
        self.assertEqual((st, d["error"]), (429, "too_many_streams"))
        server.remote_stream_release("other0")                                  # a stream ended -> room again
        self.assertEqual(self.call("GET", "/api/playinfo/" + "c" * 32, who, profile=uid)[0], 200)
        # same device asking again replaces its own lease, never counts twice
        self.assertEqual(self.call("GET", "/api/playinfo/" + "c" * 32, who, profile=uid)[0], 200)
        self.assertEqual(len(server._streams), 3)
        # playstop frees it
        self.assertEqual(self.call("POST", "/api/playstop", who, {"playSessionId": "ps-1"})[0], 200)
        self.assertEqual(len(server._streams), 2)

    def test_lease_expiry(self):
        server.remote_stream_take("x", "p", 0)
        server._streams["x"]["exp"] -= 10_000
        server.remote_stream_check("y")
        self.assertNotIn("x", server._streams)

    def test_legacy_not_limited_by_streams(self):
        for i in range(3):
            server.remote_stream_take("other%d" % i, "p", 3600)
        old = server.TV_EMAIL
        server.TV_EMAIL = "owner@example.com"
        try:
            uid = self.link("tv", "pat", "pw2")[1]["userId"]
            self.assertEqual(self.call("GET", "/api/playinfo/" + "c" * 32, "tv", profile=uid)[0], 200)
        finally:
            server.TV_EMAIL = old

    def test_bitrate_from_size(self):
        self.assertEqual(server.source_bitrate({"Size": 1_500_000_000}, 600 * 10_000_000), 20_000_000)
        self.assertEqual(server.source_bitrate({}, 0), 0)


class HandlerIdentity(unittest.TestCase):
    """_identity with a fake verified-claims object (sso_guard patched), all three outcomes."""

    def setUp(self):
        self._s = (server.sso_guard.verified_claims, server.CF_ACCESS_AUD, server.TV_CLIENT_IDS, server.TV_EMAIL,
                   server.REGISTRY, server.DEV)
        server.DEV = False
        server.CF_ACCESS_AUD = "aud"
        server.TV_CLIENT_IDS, server.TV_EMAIL = frozenset({"legacy.access"}), "owner@example.com"
        reg = server.DeviceRegistry("http://127.0.0.1:1/x", lambda: None)
        reg._devices, reg._ok_at = {"abc.access": dev("sam@example.com")}, reg.clock()
        server.REGISTRY = reg

    def tearDown(self):
        (server.sso_guard.verified_claims, server.CF_ACCESS_AUD, server.TV_CLIENT_IDS, server.TV_EMAIL,
         server.REGISTRY, server.DEV) = self._s

    def ident(self, claims):
        server.sso_guard.verified_claims = lambda *a: claims
        h = server.Handler.__new__(server.Handler)
        h.headers = {"Cf-Connecting-Ip": "198.51.100.7"}
        return h._identity(), h._device

    def test_paths(self):
        self.assertEqual(self.ident({"email": "U@Example.com"})[0], ("u@example.com", False))
        (email, tv), d = self.ident({"common_name": "legacy.access"})
        self.assertEqual((email, tv, d["path"]), ("owner@example.com", True, "legacy"))
        (email, tv), d = self.ident({"common_name": "abc.access"})
        self.assertEqual((email, tv, d["path"], d["remote"]), ("sam@example.com", True, "registry", True))
        self.assertEqual(self.ident({"common_name": "zzz.access"})[0], (None, False))
        self.assertEqual(self.ident(None)[0], (None, False))


class HomeIpTests(unittest.TestCase):
    def setUp(self):
        self._saved = (dict(server._auto_home), server.HOME_IPS)
        server._auto_home.update({"v4": set(), "v6": set()})

    def tearDown(self):
        server._auto_home.update(self._saved[0])
        server.HOME_IPS = self._saved[1]

    def test_nothing_known_means_remote(self):
        self.assertFalse(server.is_home_ip("203.0.113.9"))
        self.assertFalse(server.is_home_ip(None))

    def test_detected_v4_and_v6_prefix(self):
        urls = {server.HOME_IP_PROBES[0]: "203.0.113.9", server.HOME_IP_PROBES[1]: "2001:db8:1:2:aaaa:bbbb:cccc:dddd"}
        server.refresh_home_ips(fetch=urls.get)
        self.assertTrue(server.is_home_ip("203.0.113.9"))
        self.assertFalse(server.is_home_ip("203.0.113.10"))
        self.assertTrue(server.is_home_ip("2001:db8:1:2:1:2:3:4"))       # same /64 (privacy addresses rotate)
        self.assertFalse(server.is_home_ip("2001:db8:1:3::1"))

    def test_failed_lookup_keeps_last_value(self):
        server.refresh_home_ips(fetch={server.HOME_IP_PROBES[0]: "203.0.113.9"}.get)
        server.refresh_home_ips(fetch=lambda u: None)
        self.assertTrue(server.is_home_ip("203.0.113.9"))

    def test_garbage_is_ignored_and_configured_ips_still_work(self):
        server.refresh_home_ips(fetch=lambda u: "not-an-ip")
        self.assertFalse(server.is_home_ip("not-an-ip"))
        server.HOME_IPS = frozenset({"198.51.100.7"})
        self.assertTrue(server.is_home_ip("198.51.100.7"))

    def test_identity_marks_home_device_local(self):
        server.refresh_home_ips(fetch={server.HOME_IP_PROBES[0]: "203.0.113.9"}.get)
        reg = server.DeviceRegistry("", lambda: None)
        reg._devices = {"cid1": {"email": "a@example.com", "name": "A", "label": "TV", "revoked": False}}
        reg._ok_at = time.time()
        _, dev_home = server.resolve_service_identity({"common_name": "cid1"}, "203.0.113.9", registry=reg)
        _, dev_away = server.resolve_service_identity({"common_name": "cid1"}, "198.51.100.1", registry=reg)
        self.assertFalse(dev_home["remote"])
        self.assertTrue(dev_away["remote"])


if __name__ == "__main__":
    unittest.main()
