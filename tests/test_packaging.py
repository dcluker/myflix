"""Packaging checks: the things a first-time install trips over (Docker image contents, setup.sh output)."""
import http.server
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class DockerImageTest(unittest.TestCase):
    def test_image_copies_every_module_the_server_imports(self):
        local = {p.stem for p in ROOT.glob("*.py")}
        needed = {"server"}
        todo = ["server"]
        while todo:   # follow imports between the top-level modules
            src = (ROOT / (todo.pop() + ".py")).read_text()
            for m in re.findall(r"^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)", src, re.M):
                if m in local and m not in needed:
                    needed.add(m)
                    todo.append(m)
        copied = set()
        for line in (ROOT / "Dockerfile").read_text().splitlines():
            if line.startswith("COPY "):
                copied.update(Path(a).stem for a in line.split()[1:-1] if a.endswith(".py"))
        self.assertEqual(needed - copied, set(), "Dockerfile COPY is missing modules server.py needs")

    def test_compose_pins_the_port_inside_the_container(self):
        # MYFLIX_PORT in .env picks the host port; the container must keep listening on the mapped 8108.
        text = (ROOT / "docker-compose.yml").read_text()
        self.assertIn(":8108\"", text)
        self.assertRegex(text, r'MYFLIX_PORT:\s*"8108"')


class NetmonWithoutPingTest(unittest.TestCase):
    def test_tcp_fallback_when_there_is_no_ping_program(self):
        import socket
        from unittest import mock
        import netmon
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        open_port = srv.getsockname()[1]
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        closed_port = closed.getsockname()[1]
        closed.close()
        try:
            self.assertIsNotNone(netmon._tcp_reach("127.0.0.1", 1, ports=(open_port,)))
            self.assertIsNotNone(netmon._tcp_reach("127.0.0.1", 1, ports=(closed_port,)))   # refused = host is up
            self.assertIsNone(netmon._tcp_reach("name.invalid", 1, ports=(open_port,)))
            with mock.patch.object(netmon.shutil, "which", return_value=None), \
                 mock.patch.object(netmon, "_tcp_reach", return_value=1.5) as tcp:
                self.assertEqual(netmon._ping("192.0.2.1"), 1.5)
                tcp.assert_called_once()
        finally:
            srv.close()


class _FakeJellyfin(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"Id": "abc123", "ServerName": "Test"}, separators=(",", ":")).encode()
        self.send_response(200 if self.path == "/System/Info/Public" else 404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@unittest.skipUnless(shutil.which("bash") and shutil.which("curl"), "needs bash and curl")
class SetupScriptTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeJellyfin)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = "http://127.0.0.1:%d" % cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def run_setup(self, answers):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        shutil.copy(ROOT / "setup.sh", d.name)
        r = subprocess.run(["bash", "setup.sh"], cwd=d.name, input=answers, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return Path(d.name)

    def sourced(self, d, name):
        r = subprocess.run(["sh", "-c", 'set -a; . ./.env; set +a; printf %s "$' + name + '"'],
                           cwd=d, capture_output=True, text=True, timeout=10)
        self.assertEqual(r.stderr, "")
        return r.stdout

    def test_awkward_passwords_survive_the_env_file(self):
        for pw in ("pa$$word123", "two words 99", "hash #tag123", "amp&pipe|12", 'dq"back\\slash`1'):
            d = self.run_setup("%s/\n%s\n" % (self.url, pw))
            self.assertEqual(self.sourced(d, "MYFLIX_PASSWORD"), pw)
            self.assertEqual(self.sourced(d, "JELLYFIN_URL"), self.url)
            self.assertEqual(self.sourced(d, "JELLYFIN_SERVER_ID"), "abc123")
            self.assertEqual(os.stat(d / ".env").st_mode & 0o777, 0o600)

    def test_single_quote_is_asked_again_and_other_devices_can_connect(self):
        d = self.run_setup("%s\nit's-a-password\nplain-password-1\n" % self.url)
        self.assertEqual(self.sourced(d, "MYFLIX_PASSWORD"), "plain-password-1")
        self.assertEqual(self.sourced(d, "MYFLIX_HOST"), "0.0.0.0")


if __name__ == "__main__":
    unittest.main()
