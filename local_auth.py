"""Built-in password sign-in for people who do not use Cloudflare Access (MYFLIX_AUTH=password).

One shared password, a signed session cookie, and login throttling. Standard library only.

Design notes:
- The cookie is "<expiry>.<hmac>". The HMAC key is derived from a random per-install key (data/session.key, 0600)
  and the password, so changing the password signs everyone out.
- The password is never stored or logged; it is compared in constant time after hashing.
- Failed sign-ins are throttled per client address: MAX_FAILS in WINDOW seconds, then HTTP 429 until the window passes.
"""
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from pathlib import Path

COOKIE = "myflix_session"
SESSION_TTL = 30 * 24 * 3600
MAX_FAILS = 5
WINDOW = 15 * 60
MIN_PASSWORD = 8
PBKDF2_ITER = 200_000


def _sha(b):
    return hashlib.sha256(b).digest()


class LocalAuth:
    def __init__(self, password, key_path, email="owner@local", ttl=SESSION_TTL, clock=time.time, store_path=None):
        if len(password or "") < MIN_PASSWORD:
            raise ValueError("password must be at least %d characters" % MIN_PASSWORD)
        self.email = email
        self.ttl = ttl
        self._clock = clock
        self._pw = _sha(password.encode())          # the password from the environment / secret file
        self._base = self._load_key(Path(key_path))
        self._store = Path(store_path) if store_path else None
        self._stored = None                         # (salt, hash, iterations) once changed from the Settings page
        self._load_store()
        self._rekey()
        self._fails = {}
        self._lock = threading.Lock()

    # -- a password changed in Settings is kept (salted PBKDF2) in data/auth.json. If the environment password is
    #    edited later, that wins again and the stored one is dropped, so ".env is the reset button" stays true.
    def _env_fp(self):
        return hmac.new(self._base, self._pw, hashlib.sha256).hexdigest()

    def _load_store(self):
        if not self._store:
            return
        try:
            d = json.loads(self._store.read_text())
            if d.get("env_fp") != self._env_fp():
                self._store.unlink()
                return
            self._stored = (bytes.fromhex(d["salt"]), bytes.fromhex(d["hash"]), int(d["iter"]))
        except (OSError, ValueError, KeyError, TypeError):
            self._stored = None

    def _rekey(self):
        secret = self._stored[1] if self._stored else self._pw
        self._key = hmac.new(self._base, secret, hashlib.sha256).digest()

    def set_password(self, new):
        """Change the password (kept hashed on disk) and invalidate every existing session cookie."""
        if len(new or "") < MIN_PASSWORD:
            raise ValueError("password must be at least %d characters" % MIN_PASSWORD)
        if not self._store:
            raise ValueError("password changes are not enabled")
        salt = os.urandom(16)
        h = hashlib.pbkdf2_hmac("sha256", new.encode(), salt, PBKDF2_ITER)
        tmp = self._store.with_suffix(".tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"env_fp": self._env_fp(), "salt": salt.hex(), "hash": h.hex(), "iter": PBKDF2_ITER}, f)
        os.replace(tmp, self._store)
        self._stored = (salt, h, PBKDF2_ITER)
        self._rekey()

    @staticmethod
    def _load_key(path):
        try:
            k = path.read_bytes()
            if len(k) >= 32:
                return k
        except OSError:
            pass
        path.parent.mkdir(parents=True, exist_ok=True)
        k = secrets.token_bytes(32)
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(k)
        return k

    # -- password
    def check_password(self, given):
        given = (given or "").encode()
        if self._stored:
            salt, h, it = self._stored
            return hmac.compare_digest(hashlib.pbkdf2_hmac("sha256", given, salt, it), h)
        return hmac.compare_digest(_sha(given), self._pw)

    # -- session cookie
    def _sig(self, exp):
        return hmac.new(self._key, str(exp).encode(), hashlib.sha256).hexdigest()

    def make_cookie(self):
        exp = int(self._clock() + self.ttl)
        return "%d.%s" % (exp, self._sig(exp))

    def valid_cookie(self, value):
        try:
            exp_s, sig = (value or "").split(".", 1)
            exp = int(exp_s)
        except ValueError:
            return False
        return exp > self._clock() and hmac.compare_digest(sig, self._sig(exp))

    # -- throttling
    def retry_after(self, ip):
        """Seconds the client must wait, or 0 when it may try."""
        now = self._clock()
        with self._lock:
            recent = [t for t in self._fails.get(ip, []) if now - t < WINDOW]
            self._fails[ip] = recent
            if len(recent) >= MAX_FAILS:
                return int(WINDOW - (now - recent[0])) + 1
            if len(self._fails) > 5000:
                self._fails.clear()
        return 0

    def record_fail(self, ip):
        with self._lock:
            self._fails.setdefault(ip, []).append(self._clock())

    def clear(self, ip):
        with self._lock:
            self._fails.pop(ip, None)


def load_password(env=os.environ):
    """MYFLIX_PASSWORD, or the contents of MYFLIX_PASSWORD_FILE (Docker/systemd secrets)."""
    p = env.get("MYFLIX_PASSWORD", "")
    f = env.get("MYFLIX_PASSWORD_FILE", "")
    if not p and f:
        try:
            p = Path(f).read_text().strip()
        except OSError:
            p = ""
    return p


def login_page(error="", retry=0):
    msg = ""
    if retry:
        msg = "Too many attempts. Try again in %d minutes." % max(1, (retry + 59) // 60)
    elif error:
        msg = "Wrong password."
    return ("""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">
<title>MyFlix</title><style>
html,body{height:100%%;margin:0;background:#141414;color:#e5e5e5;font:16px "Helvetica Neue",Helvetica,Arial,sans-serif}
body{display:flex;align-items:center;justify-content:center}
form{width:min(22rem,86vw);text-align:center}
h1{color:#e50914;font-size:2rem;letter-spacing:.25em;margin:0 0 1.5rem}
input{width:100%%;box-sizing:border-box;padding:.85rem 1rem;border-radius:6px;border:1px solid #444;background:#2a2a2a;color:#fff;font-size:1rem}
input:focus{outline:2px solid #fff}
button{margin-top:.9rem;width:100%%;padding:.85rem;border:0;border-radius:6px;background:#e50914;color:#fff;font-size:1rem;font-weight:700;cursor:pointer}
button:focus,button:hover{outline:2px solid #fff}
.err{color:#ff6b6b;min-height:1.4rem;margin:.8rem 0 0}
</style></head><body><form method="post" action="/login">
<h1>MYFLIX</h1>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>
<p class="err" role="alert">%s</p></form></body></html>""" % msg).encode()
