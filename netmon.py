"""Internet monitor: probes the router, the WAN and the Cloudflare edge every few seconds, keeps a short history and an
outage log. Runs inside MyFlix on the T14 so it keeps working (and keeps recording) when the internet is gone."""
import collections
import json
import os
import socket
import subprocess
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

INTERVAL = 10
HISTORY = 8640   # 24 h of samples
ROUTER = os.environ.get("MYFLIX_ROUTER", "192.168.1.1")
PING_TARGETS = ("1.1.1.1", "8.8.8.8")
HTTPS_TARGETS = (("cloudflare", "https://www.cloudflare.com/cdn-cgi/trace"),)
if os.environ.get("MYFLIX_NETMON_URL"):   # your own public MyFlix health URL, e.g. https://myflix.example.com/healthz
    HTTPS_TARGETS += (("myflix", os.environ["MYFLIX_NETMON_URL"]),)
DNS_NAME = "cloudflare.com"
LABELS = {"ok": "Online", "cloudflare": "Cloudflare issue", "wan": "Internet down", "lan": "Router unreachable"}


def _ping(host, timeout=2):
    """Round-trip ms, or None."""
    t0 = time.time()
    try:
        p = subprocess.run(["ping", "-c", "1", "-W", str(timeout), host], capture_output=True, text=True, timeout=timeout + 2)
    except Exception:
        return None
    if p.returncode != 0:
        return None
    i = p.stdout.rfind("time=")
    if i >= 0:
        try:
            return float(p.stdout[i + 5:].split()[0])
        except (ValueError, IndexError):
            pass
    return round((time.time() - t0) * 1000, 1)


def _dns():
    t0 = time.time()
    try:
        socket.getaddrinfo(DNS_NAME, 443)
    except OSError:
        return None
    return round((time.time() - t0) * 1000, 1)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _https(url, timeout=5):
    """ms until any HTTP answer (a redirect or 401 still proves the edge is up), or None."""
    t0 = time.time()
    try:
        _opener.open(urllib.request.Request(url, method="GET", headers={"User-Agent": "myflix-netmon"}), timeout=timeout).close()
    except urllib.error.HTTPError:
        pass
    except Exception:
        return None
    return round((time.time() - t0) * 1000)


def classify(s):
    if s["router"] is None:
        return "lan"
    if all(s["ping"][h] is None for h in PING_TARGETS):
        return "wan"
    if all(s["https"][n] is None for n, _ in HTTPS_TARGETS):
        return "cloudflare"
    return "ok"


class Monitor:
    def __init__(self, log_path):
        self.log = Path(log_path)
        self.lock = threading.Lock()
        self.samples = collections.deque(maxlen=HISTORY)
        self.events = collections.deque(maxlen=200)   # {"t", "status", "prev"}
        self.status = None
        self.since = None
        self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="netmon")
        self._load()

    def _load(self):
        try:
            for line in self.log.read_text().splitlines()[-200:]:
                try:
                    self.events.append(json.loads(line))
                except ValueError:
                    pass
        except OSError:
            pass

    def sample(self):
        futs = {"router": self._pool.submit(_ping, ROUTER), "dns": self._pool.submit(_dns)}
        for h in PING_TARGETS:
            futs["ping:" + h] = self._pool.submit(_ping, h)
        for n, u in HTTPS_TARGETS:
            futs["https:" + n] = self._pool.submit(_https, u)
        wait(futs.values(), timeout=8)
        def res(k):
            f = futs[k]
            return f.result() if f.done() and not f.exception() else None
        s = {"t": int(time.time()), "router": res("router"), "dns": res("dns"),
             "ping": {h: res("ping:" + h) for h in PING_TARGETS},
             "https": {n: res("https:" + n) for n, _ in HTTPS_TARGETS}}
        s["status"] = classify(s)
        return s

    def record(self, s):
        with self.lock:
            self.samples.append(s)
            if s["status"] != self.status:
                if self.status is not None:
                    ev = {"t": s["t"], "status": s["status"], "prev": self.status}
                    self.events.append(ev)
                    try:
                        with self.log.open("a") as f:
                            f.write(json.dumps(ev) + "\n")
                    except OSError:
                        pass
                self.status, self.since = s["status"], s["t"]

    def run(self):
        while True:
            t0 = time.time()
            try:
                self.record(self.sample())
            except Exception:
                pass
            time.sleep(max(1, INTERVAL - (time.time() - t0)))

    def start(self):
        threading.Thread(target=self.run, name="netmon", daemon=True).start()

    def snapshot(self, n=360):
        with self.lock:
            samples = list(self.samples)
            events = list(self.events)[-60:]
            status, since = self.status, self.since
        day = [s for s in samples if s["t"] >= time.time() - 86400]
        up = sum(1 for s in day if s["status"] == "ok")
        return {"now": samples[-1] if samples else None, "status": status, "label": LABELS.get(status, "Starting"),
                "since": since, "uptime24h": round(100.0 * up / len(day), 2) if day else None,
                "samples": samples[-n:], "events": events, "interval": INTERVAL, "labels": LABELS}
