"""Live relay (browser fallback): signing, playlist rewriting, and the refusal of anything MyFlix did not sign
or that points at a private address.
Run: python3 -m unittest discover -s tests -v   (from the project root)"""
import http.client
import sys
import threading
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class RelayHelpersTest(unittest.TestCase):
    def test_signature_is_stable_and_url_specific(self):
        a = server._relay_sig("https://cdn.example/a.m3u8")
        self.assertEqual(a, server._relay_sig("https://cdn.example/a.m3u8"))
        self.assertNotEqual(a, server._relay_sig("https://cdn.example/b.m3u8"))

    def test_private_and_odd_hosts_are_refused(self):
        for u in ("http://127.0.0.1/x.m3u8", "http://localhost/x.m3u8", "http://10.0.0.5/x", "http://192.168.1.10:8096/x",
                  "http://169.254.169.254/latest/meta-data", "http://[::1]/x", "file:///etc/passwd", "ftp://example.com/x", "https:///nohost"):
            self.assertFalse(server._relay_public_host(u), u)

    def test_rewrite_signs_segments_and_uri_attributes(self):
        text = ('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\nseg1.ts\n'
                '#EXTINF:6.0,\nhttps://other.example/seg2.ts\n#EXT-X-ENDLIST\n')
        out = server._relay_rewrite(text, "https://cdn.example/live/master.m3u8")
        links = [l for l in out.splitlines() if "/api/livetv/relay" in l]
        self.assertEqual(len(links), 4)
        for l in out.splitlines():
            self.assertNotIn("seg1.ts", l.replace("%2F", "/").split("/api/livetv/relay")[0])   # no bare segment names left
        # every link is signed for exactly the absolute URL it carries
        import re
        for m in re.finditer(r"/api/livetv/relay\?u=([^&\"]+)&s=([0-9a-f]+)", out):
            u = urllib.parse.unquote(m.group(1))
            self.assertTrue(u.startswith("https://"), u)
            self.assertEqual(m.group(2), server._relay_sig(u))
        self.assertIn("https%3A%2F%2Fcdn.example%2Flive%2Fseg1.ts", out)
        self.assertIn("https%3A%2F%2Fother.example%2Fseg2.ts", out)


class RelayHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._dev = server.DEV
        server.DEV = True   # identity is not what is under test here
        cls.srv = server.Server(("127.0.0.1", 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        server.DEV = cls._dev

    def status(self, u, s):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", "/api/livetv/relay?u=%s&s=%s" % (urllib.parse.quote(u, safe=""), s))
        r = c.getresponse()
        r.read()
        c.close()
        return r.status

    def test_unsigned_or_badly_signed_is_forbidden(self):
        self.assertEqual(self.status("https://cdn.example/a.m3u8", ""), 403)
        self.assertEqual(self.status("https://cdn.example/a.m3u8", "0" * 40), 403)

    def test_signed_private_address_is_forbidden(self):
        for u in ("http://127.0.0.1:9/x.m3u8", "http://192.168.1.10:8096/System/Info"):
            self.assertEqual(self.status(u, server._relay_sig(u)), 403, u)


if __name__ == "__main__":
    unittest.main()
