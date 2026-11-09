import sys, time, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server


class LanAuth(unittest.TestCase):
    def test_secret_roundtrip(self):
        self.assertEqual(server.lan_header_client("abc:" + server.lan_secret("abc")), "abc")
        self.assertIsNone(server.lan_header_client("abc:" + server.lan_secret("abd")))
        self.assertIsNone(server.lan_header_client("abc"))
        self.assertIsNone(server.lan_header_client(""))

    def test_cookie(self):
        c = server.lan_cookie_make("dev1")
        self.assertEqual(server.lan_cookie_client(c), "dev1")
        self.assertIsNone(server.lan_cookie_client(c[:-1] + ("0" if c[-1] != "0" else "1")))
        self.assertIsNone(server.lan_cookie_client(c, now=time.time() + server.LAN_COOKIE_TTL + 5))
        self.assertIsNone(server.lan_cookie_client(None))

    def test_source(self):
        self.assertTrue(server.is_lan_source("192.168.1.20", {}))
        self.assertFalse(server.is_lan_source("8.8.8.8", {}))
        self.assertFalse(server.is_lan_source("127.0.0.1", {}))
        self.assertFalse(server.is_lan_source("192.168.1.30", {"Cf-Connecting-Ip": "1.2.3.4"}))
        self.assertFalse(server.is_lan_source("192.168.1.30", {"X-Forwarded-For": "1.2.3.4"}))


if __name__ == "__main__":
    unittest.main()
