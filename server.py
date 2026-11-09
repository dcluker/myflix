#!/usr/bin/env python3
"""MyFlix v2 backend: a thin, caching proxy between the Netflix-style frontend and Jellyfin.

Stdlib only. Auth is Cloudflare Access (see sso_guard.py); Jellyfin sessions are stored per
Access email in data/sessions.json. Nothing here ever logs a password or token.
"""
import datetime
import gzip
import hashlib
import hmac
import ipaddress
import secrets
import base64
import json
import mimetypes
import os
import re
import socket
import subprocess
import sys
import threading
import calendar
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import local_auth
import netmon
import sso_guard

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
STATIC = ROOT / "static"
IMG_DIR = DATA / "imgcache"
SESSIONS_FILE = DATA / "sessions.json"
INTRUDERS_FILE = DATA / "intruders.jsonl"

PROD_PORT = 8108
DEV = os.environ.get("MYFLIX_DEV") == "1"
HOST = os.environ.get("MYFLIX_HOST", "127.0.0.1")
PORT = int(os.environ.get("MYFLIX_PORT", str(PROD_PORT)))
# Server-specific values come from the environment (see .env.example); there are no built-in defaults.
JELLYFIN_URL = os.environ.get("JELLYFIN_URL", "").rstrip("/")            # LAN address, e.g. http://192.168.x.x:8096
JELLYFIN_PUBLIC = os.environ.get("JELLYFIN_PUBLIC", "").rstrip("/")      # public https address behind your tunnel
SERVER_ID = os.environ.get("JELLYFIN_SERVER_ID", "")                     # Id from <jellyfin>/System/Info/Public
CF_TEAM_DOMAIN = os.environ.get("CF_TEAM_DOMAIN", "")                    # <team>.cloudflareaccess.com
CF_ACCESS_AUD = os.environ.get("CF_ACCESS_AUD", "")
# MYFLIX_AUTH=password: built-in shared-password sign-in (no Cloudflare). Default "cloudflare" keeps the Access JWT flow.
AUTH_MODE = os.environ.get("MYFLIX_AUTH", "cloudflare").strip().lower()
LOCAL_AUTH = None   # set in main() when AUTH_MODE == "password"
CF_ACCESS_AUD_JF = os.environ.get("CF_ACCESS_AUD_JELLYFIN", "")             # AUD of the jellyfin host's Access app (auto-login route)
JF_AUTOLOGIN = os.environ.get("MYFLIX_JF_AUTOLOGIN", "") == "1"             # /play -> Jellyfin web with the profile pre-signed-in
# Fire TV app: a Cloudflare Access service token (no email in its JWT, only common_name = client id)
# is mapped onto MYFLIX_TV_EMAIL so the TV uses that account's linked profiles.
TV_CLIENT_IDS = frozenset(x.strip() for x in os.environ.get("MYFLIX_TV_CLIENT_IDS", "").split(",") if x.strip())
TV_EMAIL = os.environ.get("MYFLIX_TV_EMAIL", "").strip().lower()
# Per-device service tokens (distributable app): client id -> person, served by the landing server's LAN-only
# internal API. MYFLIX_REGISTRY_URL is also the test hook; empty = no registry (only the legacy token path works).
def _env_int(name, default):
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


REGISTRY_URL = os.environ.get("MYFLIX_REGISTRY_URL", "")
REGISTRY_KEYCHAIN = (os.environ.get("MYFLIX_REGISTRY_KEYCHAIN_SERVICE", "myflix-registry-token"),
                     os.environ.get("MYFLIX_REGISTRY_KEYCHAIN_ACCOUNT", "myflix"))   # (service, account)
REGISTRY_TTL = _env_int("MYFLIX_REGISTRY_TTL", 300)               # fresh for 5 min
REGISTRY_LAN_STALE_MAX = _env_int("MYFLIX_REGISTRY_LAN_STALE_MAX", 30 * 86400)  # LAN devices: ride out a long landing outage
REGISTRY_STALE_MAX = _env_int("MYFLIX_REGISTRY_STALE_MAX", 3600)  # serve the last good copy up to 1 h if a fetch fails
REGISTRY_MISS_REFRESH = _env_int("MYFLIX_REGISTRY_MISS_REFRESH", 10)   # unknown id may be brand new: re-fetch <= every 10 s
REGISTRY_RETRY_AFTER_FAIL = _env_int("MYFLIX_REGISTRY_RETRY_AFTER_FAIL", 15)
REGISTRY_TIMEOUT = _env_int("MYFLIX_REGISTRY_TIMEOUT", 4)
# Remote (non-legacy) devices: Pi uplink/CPU protection.
REMOTE_MAX_BITRATE = _env_int("MYFLIX_REMOTE_MAX_BITRATE", 20_000_000)   # bits/s of the source file (direct play only)
REMOTE_MAX_STREAMS = _env_int("MYFLIX_REMOTE_MAX_STREAMS", 3)
REMOTE_LEASE_PAD = _env_int("MYFLIX_REMOTE_LEASE_PAD", 300)       # seconds past the remaining runtime before a lease expires
REMOTE_LEASE_MAX = _env_int("MYFLIX_REMOTE_LEASE_MAX", 6 * 3600)
# Comma list of the household's public IPs: a paired device seen from one of these is treated as local
# (no bitrate/stream caps). Empty by default = every non-legacy device is treated as remote.
HOME_IPS = frozenset(x.strip() for x in os.environ.get("MYFLIX_HOME_IPS", "").split(",") if x.strip())
# The server runs at home, so its own public address IS the household's. When on (default) the server looks that
# address up every few minutes, so devices on the home Wi-Fi are treated as local even if the ISP changes it.
HOME_IP_AUTODETECT = os.environ.get("MYFLIX_HOME_IP_AUTODETECT", "1") != "0"
HOME_IP_PROBES = ("https://1.1.1.1/cdn-cgi/trace", "https://[2606:4700:4700::1111]/cdn-cgi/trace")   # v4, v6
HOME_IP_REFRESH = _env_int("MYFLIX_HOME_IP_REFRESH", 600)

# TV hand-off ("take it with me"): a phone/tablet picks up what a TV is playing. TVs are known to Jellyfin by device
# name (e.g. AFTHA004); both lists are "DEVICE=value,DEVICE=value". Empty = the raw device name, and no remote stop.
def _env_map(name):
    out = {}
    for part in os.environ.get(name, "").split(","):
        k, _, v = part.partition("=")
        if k.strip() and v.strip():
            out[k.strip()] = v.strip()
    return out


HANDOFF_TV_NAMES = _env_map("MYFLIX_TV_NAMES")      # device name -> "Living room"
HANDOFF_TV_ADB = _env_map("MYFLIX_TV_ADB")          # device name -> LAN IP with ADB on :5555 (used to stop the TV)
CAST_ENABLED = os.environ.get("MYFLIX_CAST") == "1"      # Echo Hub "cast to TV": off until the TV app has the play entry point
HANDOFF_DRYRUN = os.environ.get("MYFLIX_HANDOFF_DRYRUN") == "1"   # never write a position or touch a TV
HANDOFF_MAX_AGE = _env_int("MYFLIX_HANDOFF_MAX_AGE", 4 * 3600)    # a session idle longer than this is not offered

# Jellyseerr: lets a profile request titles the library doesn't have yet (see "Requests (Jellyseerr)" in SPEC.md).
SEERR_URL = os.environ.get("MYFLIX_SEERR_URL", "").rstrip("/")
SEERR_DRYRUN = os.environ.get("MYFLIX_SEERR_DRYRUN") == "1"   # build the request payload, never POST it
SEERR_KEYCHAIN = os.environ.get("MYFLIX_SEERR_KEYCHAIN_SERVICE", "myflix-jellyseerr-api")
SEERR_TIMEOUT = 12
SEARCH_TTL = 120
SEERR_USERS_TTL = 600
REQUEST_PER_MIN = 10
TMDB_IMG = "https://image.tmdb.org/t/p/"
TMDB_PATH_RE = re.compile(r"^/[A-Za-z0-9._-]{1,80}$")

INDEX_TTL = 600
HOME_TTL = 60
ITEM_TTL = 30
IMG_SIZES = (160, 240, 320, 480, 640, 960, 1280, 1920)
IMG_TYPES = ("Primary", "Backdrop", "Logo", "Thumb")
IMG_404_TTL = 3600
IMG_TAGLESS_TTL = 86400
UPSTREAM_SLOTS = 4

INDEX_FIELDS = ("Genres,Overview,OfficialRating,CommunityRating,CriticRating,RunTimeTicks,ProductionYear,"
                "DateCreated,ChildCount,RecursiveItemCount,SortName,People,Studios,Taglines,UserData,"
                "ImageTags,BackdropImageTags")
IMAGE_TYPES_Q = "Primary,Backdrop,Logo,Thumb"

ID_RE = re.compile(r"^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

_upstream = threading.BoundedSemaphore(UPSTREAM_SLOTS)
_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="myflix")


# ----------------------------------------------------------------------------- errors

class ApiError(Exception):
    def __init__(self, status, code, **extra):
        super().__init__(code)
        self.status = status
        self.body = dict(error=code, **extra)


class Relink(Exception):
    def __init__(self, user_id):
        super().__init__("relink")
        self.user_id = user_id


class UpstreamError(Exception):
    def __init__(self, status, msg=""):
        super().__init__("upstream %s %s" % (status, msg))
        self.status = status


def norm_id(s):
    if not s or not ID_RE.match(s):
        return None
    return s.replace("-", "").lower()


# ----------------------------------------------------------------------------- sessions store

_sess_lock = threading.RLock()
_sessions = None


def _load_sessions():
    global _sessions
    if _sessions is None:
        try:
            with open(SESSIONS_FILE) as f:
                _sessions = json.load(f)
            if not isinstance(_sessions, dict):
                _sessions = {}
        except (OSError, ValueError):
            _sessions = {}
    return _sessions


def _save_sessions():
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = SESSIONS_FILE.with_suffix(".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(_sessions, f, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, SESSIONS_FILE)


def get_profiles(email):
    with _sess_lock:
        return [dict(p) for p in _load_sessions().get(email, {}).get("profiles", [])]


def upsert_profile(email, prof):
    with _sess_lock:
        s = _load_sessions()
        lst = s.setdefault(email, {"profiles": []}).setdefault("profiles", [])
        for i, p in enumerate(lst):
            if p["userId"] == prof["userId"]:
                lst[i] = prof
                break
        else:
            lst.append(prof)
        _save_sessions()


def remove_profile(email, user_id):
    with _sess_lock:
        s = _load_sessions()
        lst = s.get(email, {}).get("profiles", [])
        found = None
        for p in lst:
            if p["userId"] == user_id:
                found = p
        if found:
            lst.remove(found)
            _save_sessions()
        return found


def public_profile(p):
    img = None
    if p.get("imageTag"):
        img = "/img/%s/Primary?tag=%s&w=160" % (p["userId"], urllib.parse.quote(p["imageTag"]))
    out = {"userId": p["userId"], "name": p["name"], "imageUrl": img}
    if p.get("display"):
        out["display"] = p["display"]
    av = p.get("avatar")
    if isinstance(av, dict) and av.get("kind") in ("emoji", "photo"):
        out["avatar"] = {k: v for k, v in av.items() if k in ("kind", "emoji", "color", "v")}
        if av["kind"] == "photo":
            out["avatar"]["url"] = "/api/avatar/%s?v=%s" % (p["userId"], av.get("v", 0))
    if isinstance(p.get("theme"), dict):
        out["theme"] = {k: v for k, v in p["theme"].items() if k in ("accent", "secondary") and v}
    return out


# ----------------------------------------------------------------------------- profile customisation
# Per profile: a display name (the Jellyfin name stays the sign-in name), an avatar (emoji on a colour, or a small
# uploaded photo), and its own theme. Photos are checked by magic bytes, capped, stored as opaque files and only ever
# served back to the signed-in person whose profile they are.
AVATAR_DIR = DATA / "avatars"
AVATAR_MAX = 400_000
_AVATAR_TYPES = {"image/jpeg": b"\xff\xd8\xff", "image/png": b"\x89PNG\r\n\x1a\n", "image/webp": b"RIFF"}


def _clean_text(v, n):
    if not isinstance(v, str):
        return None
    v = "".join(ch for ch in v if ch.isprintable()).strip()
    return v[:n]


def profile_customize(email, user_id, body):
    """Validate and apply {display?, avatar?, theme?}; returns the public profile. Raises ApiError(400/404)."""
    changes = {}
    if "display" in body:
        d = _clean_text(body["display"], 24) if body["display"] is not None else ""
        if d is None:
            raise ApiError(400, "bad_request")
        changes["display"] = d or None
    if "avatar" in body:
        a = body["avatar"]
        if a is None or (isinstance(a, dict) and a.get("kind") == "letter"):
            changes["avatar"] = None
        elif isinstance(a, dict) and a.get("kind") == "emoji":
            # Emoji only: keep joiners (family, flags of people), refuse plain text.
            e = a.get("emoji")
            e = "".join(ch for ch in e if ch.isprintable() or ch == "\u200d").strip()[:16] if isinstance(e, str) else ""
            c = a.get("color")
            if not e or any(ord(ch) < 128 and ch.isalnum() and ch not in "#*0123456789" for ch in e) or not (isinstance(c, str) and ACCENT_RE.match(c)):
                raise ApiError(400, "bad_request")
            changes["avatar"] = {"kind": "emoji", "emoji": e, "color": c.lower()}
        else:
            raise ApiError(400, "bad_request")
    if "theme" in body:
        t = body["theme"]
        if t is None:
            changes["theme"] = None
        elif isinstance(t, dict) and set(t) <= {"accent", "secondary"}:
            clean = {}
            for k, v in t.items():
                if v is None:
                    continue
                if not (isinstance(v, str) and ACCENT_RE.match(v)):
                    raise ApiError(400, "bad_request")
                clean[k] = v.lower()
            changes["theme"] = clean or None
        else:
            raise ApiError(400, "bad_request")
    if not changes:
        raise ApiError(400, "bad_request")
    with _sess_lock:
        lst = _load_sessions().get(email, {}).get("profiles", [])
        prof = next((p for p in lst if p["userId"] == user_id), None)
        if not prof:
            raise ApiError(404, "not_found")
        had_photo = isinstance((prof.get("avatar")), dict) and prof["avatar"].get("kind") == "photo"
        for k, v in changes.items():
            if v is None:
                prof.pop(k, None)
            else:
                prof[k] = v
        _save_sessions()
        out = public_profile(prof)
    if had_photo and "avatar" in changes:
        avatar_delete(user_id)
    return out


def avatar_delete(user_id):
    try:
        (AVATAR_DIR / (user_id + ".bin")).unlink()
    except OSError:
        pass


def profile_set_photo(email, user_id, ctype, data):
    magic = _AVATAR_TYPES.get(ctype)
    if magic is None or not data.startswith(magic) or (ctype == "image/webp" and data[8:12] != b"WEBP"):
        raise ApiError(415, "unsupported_image")
    with _sess_lock:
        lst = _load_sessions().get(email, {}).get("profiles", [])
        prof = next((p for p in lst if p["userId"] == user_id), None)
        if not prof:
            raise ApiError(404, "not_found")
        AVATAR_DIR.mkdir(parents=True, exist_ok=True)
        tmp = AVATAR_DIR / (user_id + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, AVATAR_DIR / (user_id + ".bin"))
        prof["avatar"] = {"kind": "photo", "v": int(time.time()), "ct": ctype}
        _save_sessions()
        return public_profile(prof)


# ----------------------------------------------------------------------------- small caches

class TTLCache:
    def __init__(self, max_entries=600):
        self._d = {}
        self._lock = threading.Lock()
        self._max = max_entries

    def get(self, key):
        with self._lock:
            e = self._d.get(key)
            if e and e[0] > time.time():
                return e[1]
            if e:
                del self._d[key]
        return None

    def put(self, key, val, ttl):
        with self._lock:
            if len(self._d) >= self._max:
                now = time.time()
                for k in [k for k, v in self._d.items() if v[0] <= now]:
                    del self._d[k]
                if len(self._d) >= self._max:
                    self._d.clear()
            self._d[key] = (time.time() + ttl, val)

    def drop_user(self, user_id):
        with self._lock:
            for k in [k for k in self._d if k[1] == user_id]:
                del self._d[k]

    def drop_kind(self, kind):
        with self._lock:
            for k in [k for k in self._d if k[0] == kind]:
                del self._d[k]


_cache = TTLCache()


# ----------------------------------------------------------------------------- Jellyfin client

def _auth_header(device_id, token=None):
    h = 'MediaBrowser Client="MyFlix", Device="myflix-server", DeviceId="%s", Version="2.0"' % device_id
    if token:
        h += ', Token="%s"' % token
    return h


def jf_raw(method, path, params=None, body=None, token=None, device_id="myflix-server", timeout=30):
    """Returns (status, headers, bytes). Never raises on HTTP status; raises UpstreamError(0) on network failure."""
    url = JELLYFIN_URL + path
    if params:
        url += "?" + urllib.parse.urlencode(params, safe=",")
    data = None
    headers = {"Authorization": _auth_header(device_id, token), "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with _upstream:
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            try:
                return e.code, e.headers, e.read()
            finally:
                e.close()
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
            raise UpstreamError(0, type(e).__name__)


def jf(profile, method, path, params=None, body=None, timeout=60, ok404=False):
    """JSON call as a linked profile. 401 -> Relink, other failures -> UpstreamError."""
    status, _h, raw = jf_raw(method, path, params, body, profile["token"],
                             "myflix-" + profile["userId"], timeout)
    if status == 401:
        raise Relink(profile["userId"])
    if status == 404 and ok404:
        return None
    if status >= 400:
        raise UpstreamError(status, path.split("?")[0])
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        raise UpstreamError(502, "bad json")


# ----------------------------------------------------------------------------- shaping

def _ticks_min(t):
    if not t:
        return None
    return max(1, round(t / 600_000_000))


def _clip(s, n):
    if not s:
        return None
    s = " ".join(s.split())
    return s if len(s) <= n else s[:n - 1].rstrip() + "…"


def _pct(ud, runtime_ticks):
    p = ud.get("PlayedPercentage")
    if p is None and runtime_ticks and ud.get("PlaybackPositionTicks"):
        p = 100.0 * ud["PlaybackPositionTicks"] / runtime_ticks
    if p is None:
        return 100 if ud.get("Played") else 0
    return int(max(0, min(100, round(p))))


def _prune(d):
    return {k: v for k, v in d.items() if v is not None and v != [] and v != {}}


def index_item(r):
    typ = r.get("Type")
    ud = r.get("UserData") or {}
    tags = r.get("ImageTags") or {}
    bd = r.get("BackdropImageTags") or []
    people = []
    seen = set()
    for want in ("Actor", None):
        for p in r.get("People") or []:
            if (want and p.get("Type") != want) or (not want and p.get("Type") == "Actor"):
                continue
            n = p.get("Name")
            if n and n not in seen:
                seen.add(n)
                people.append(n)
    people = people[:8]
    score = r.get("CommunityRating")
    runtime = r.get("RunTimeTicks")
    out = {
        "id": r["Id"], "type": typ, "name": r.get("Name"), "sortName": r.get("SortName") or r.get("Name"),
        "year": r.get("ProductionYear"), "rating": r.get("OfficialRating"),
        "score": round(score, 1) if isinstance(score, (int, float)) else None,
        "critic": int(r["CriticRating"]) if r.get("CriticRating") is not None else None,
        "runtimeMin": _ticks_min(runtime) if typ == "Movie" else None,
        "genres": r.get("Genres") or [],
        "overview": _clip(r.get("Overview"), 400),
        "added": (r.get("DateCreated") or "")[:19] + "Z" if r.get("DateCreated") else None,
        "played": bool(ud.get("Played")),
        "favorite": bool(ud.get("IsFavorite")),
        "people": people,
        "studio": (r.get("Studios") or [{}])[0].get("Name"),
        "img": _prune({"primary": tags.get("Primary"), "backdrop": bd[0] if bd else None,
                       "logo": tags.get("Logo"), "thumb": tags.get("Thumb")}),
    }
    if typ == "Series":
        eps = r.get("RecursiveItemCount")
        unp = ud.get("UnplayedItemCount")
        out["seasons"] = r.get("ChildCount")
        out["episodes"] = eps
        out["unplayed"] = unp
        if eps and unp is not None:
            out["playedPct"] = int(round(100.0 * (eps - unp) / eps))
            out["played"] = unp == 0
        else:
            out["playedPct"] = 100 if out["played"] else 0
    else:
        out["playedPct"] = _pct(ud, runtime)
    out = _prune(out)
    out.setdefault("img", {})
    out.setdefault("genres", [])
    out.setdefault("people", [])
    out.setdefault("playedPct", 0)
    return out


# Seasonal collections: a Jellyfin Genre per season, set per item with the buttons in the UI.
# Keep in step with SEASONS in static/js/api.js and seasonal_tag.py (private-home-landing).
SEASONS = [
    {"key": "halloween", "genre": "Halloween", "emoji": "\U0001F383", "title": "Halloween"},
    {"key": "christmas", "genre": "Christmas", "emoji": "\U0001F384", "title": "Christmas"},
]
SEASON_BY_KEY = {x["key"]: x for x in SEASONS}


def episode_item(r):
    ud = r.get("UserData") or {}
    tags = r.get("ImageTags") or {}
    pbd = r.get("ParentBackdropImageTags") or []
    return _prune({
        "id": r["Id"], "type": "Episode", "name": r.get("Name"),
        "seriesId": r.get("SeriesId"), "seriesName": r.get("SeriesName"),
        "season": r.get("ParentIndexNumber"), "episode": r.get("IndexNumber"), "episodeEnd": r.get("IndexNumberEnd"),
        "overview": _clip(r.get("Overview"), 300),
        "runtimeMin": _ticks_min(r.get("RunTimeTicks")),
        "played": bool(ud.get("Played")),
        "halloween": "Halloween" in (r.get("Genres") or []),
        "seasons": [x["key"] for x in SEASONS if x["genre"] in (r.get("Genres") or [])],
        "playedPct": _pct(ud, r.get("RunTimeTicks")),
        "img": _prune({"primary": tags.get("Primary"), "thumb": tags.get("Thumb") or tags.get("Primary")}),
        "seriesImg": _prune({"backdrop": pbd[0] if pbd else None, "logo": r.get("ParentLogoImageTag"),
                             "primary": r.get("SeriesPrimaryImageTag"), "thumb": r.get("ParentThumbImageTag")}),
    })


def shape_any(r):
    t = r.get("Type")
    if t in ("Movie", "Series"):
        return index_item(r)
    if t == "Episode":
        return episode_item(r)
    return None


# ----------------------------------------------------------------------------- index (big, slow upstream)

class IndexEntry:
    __slots__ = ("items", "body", "gz", "etag", "ts", "dirty", "retry_after")

    def __init__(self, items, ts):
        self.items = items
        self.ts = ts
        self.dirty = False
        self.retry_after = 0
        self.rebuild()

    def rebuild(self):
        self.body = json.dumps(self.items, separators=(",", ":"), ensure_ascii=False).encode()
        self.gz = gzip.compress(self.body, 6)
        self.etag = '"%s"' % hashlib.md5(self.body).hexdigest()


_index = {}
_index_lock = threading.Lock()
_index_user_locks = {}
_index_refreshing = set()


def _index_path(uid):
    return DATA / ("index_%s.json" % uid)


def _fetch_index(profile):
    uid = profile["userId"]
    data = jf(profile, "GET", "/Items", {
        "userId": uid, "Recursive": "true", "IncludeItemTypes": "Movie,Series", "Fields": INDEX_FIELDS,
        "EnableImageTypes": IMAGE_TYPES_Q, "ImageTypeLimit": "1", "EnableTotalRecordCount": "false",
    }, timeout=240)
    items = []
    for r in (data or {}).get("Items", []):
        it = index_item(r)
        if it["type"] == "Series" and not it.get("episodes"):
            continue  # empty shells: nothing playable
        items.append(it)
    items.sort(key=lambda x: (x.get("sortName") or "").lower())
    entry = IndexEntry(items, time.time())
    with _index_lock:
        _index[uid] = entry
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        tmp = _index_path(uid).with_suffix(".tmp")
        tmp.write_bytes(entry.body)
        os.replace(tmp, _index_path(uid))
    except OSError:
        pass
    return entry


def _load_index_from_disk(uid):
    p = _index_path(uid)
    try:
        items = json.loads(p.read_bytes())
        entry = IndexEntry(items, p.stat().st_mtime)
    except (OSError, ValueError):
        return None
    with _index_lock:
        return _index.setdefault(uid, entry)


def _bg_refresh(profile):
    uid = profile["userId"]

    def run():
        try:
            _fetch_index(profile)
        except Exception:
            with _index_lock:
                e = _index.get(uid)
                if e:
                    e.retry_after = time.time() + 60
        finally:
            with _index_lock:
                _index_refreshing.discard(uid)

    with _index_lock:
        if uid in _index_refreshing:
            return
        _index_refreshing.add(uid)
    threading.Thread(target=run, daemon=True, name="index-refresh").start()


def get_index(profile, refresh=False):
    uid = profile["userId"]
    with _index_lock:
        entry = _index.get(uid)
    if entry is None:
        entry = _load_index_from_disk(uid)
        if entry is not None:
            entry.ts = min(entry.ts, time.time() - INDEX_TTL - 1)  # disk copy is always served stale-while-revalidate
    if refresh or entry is None:
        started = time.time()
        with _index_lock:
            lock = _index_user_locks.setdefault(uid, threading.Lock())
        with lock:
            with _index_lock:
                cur = _index.get(uid)
            if cur is not None and cur.ts >= started and not cur.dirty:
                return cur  # someone else just refreshed while we waited
            return _fetch_index(profile)
    now = time.time()
    if (now - entry.ts > INDEX_TTL or entry.dirty) and now >= entry.retry_after:
        _bg_refresh(profile)
    return entry


def patch_index(uid, item_id, **changes):
    """Reflect a played/favorite toggle in the cached index without paying for a 40s refetch."""
    with _index_lock:
        entry = _index.get(uid)
    if not entry:
        return
    for it in entry.items:
        if it["id"] == item_id:
            if "played" in changes:
                it["played"] = changes["played"]
                if it["type"] == "Series":
                    eps = it.get("episodes") or 0
                    it["unplayed"] = 0 if changes["played"] else eps
                    it["playedPct"] = 100 if changes["played"] else 0
                else:
                    it["playedPct"] = 100 if changes["played"] else 0
            if "favorite" in changes:
                it["favorite"] = changes["favorite"]
            break
    entry.dirty = True  # background-refresh on next request, but keep serving this copy
    entry.rebuild()


# ----------------------------------------------------------------------------- data endpoints

def _search_norm(t):
    import unicodedata
    t = unicodedata.normalize("NFD", str(t or "")).encode("ascii", "ignore").decode().lower()
    t = t.replace("'", "").replace("\u2019", "")      # King's -> kings, not "king s"
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", t)).strip()


def api_search(profile, q, limit=12):
    """Small ranked title search for clients that should not download the whole index (the watch app).
    Order: exact name, name starts with, a word starts with, name contains. Movies and series only."""
    qn = _search_norm(q)
    if len(qn) < 2:
        return []
    qn_the = qn[4:] if qn.startswith("the ") else qn
    scored = []
    for it in get_index(profile).items:
        if it.get("type") not in ("Movie", "Series"):
            continue
        n = _search_norm(it.get("name"))
        nt = n[4:] if n.startswith("the ") else n
        if n == qn or nt == qn_the:
            sc = 0
        elif nt.startswith(qn_the):
            sc = 1
        elif (" " + qn) in (" " + n):
            sc = 2
        elif qn in n:
            sc = 3
        else:
            continue
        scored.append((sc, n, it))
    scored.sort(key=lambda x: (x[0], x[1]))
    return [{"id": it["id"], "type": it["type"], "name": it.get("name"), "year": it.get("year"),
             "img": {"primary": (it.get("img") or {}).get("primary")}} for _s, _n, it in scored[:limit]]


def api_home(profile):
    uid = profile["userId"]
    key = ("home", uid)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    common = {"userId": uid, "Fields": INDEX_FIELDS, "EnableImageTypes": IMAGE_TYPES_Q, "ImageTypeLimit": "1"}

    def resume():
        p = dict(common, Limit="20", MediaTypes="Video", EnableTotalRecordCount="false")
        d = jf(profile, "GET", "/UserItems/Resume", p, ok404=True)
        if d is None:
            d = jf(profile, "GET", "/Users/%s/Items/Resume" % uid, p)
        return [x for x in (shape_any(r) for r in (d or {}).get("Items", [])) if x]

    def next_up():
        d = jf(profile, "GET", "/Shows/NextUp", dict(common, Limit="20", EnableTotalRecordCount="false"))
        return [episode_item(r) for r in (d or {}).get("Items", []) if r.get("Type") == "Episode"]

    def latest():
        d = jf(profile, "GET", "/Users/%s/Items/Latest" % uid,
               dict(common, Limit="40", IncludeItemTypes="Movie,Series"))
        return [index_item(r) for r in (d or []) if r.get("Type") in ("Movie", "Series")]

    def seasonal(genre):
        # Episodes tagged with the season Genre. Episodes of series that are themselves tagged are left out:
        # the series card covers them.
        ser = jf(profile, "GET", "/Items", dict(common, Recursive="true", IncludeItemTypes="Series", Genres=genre,
                                                  EnableTotalRecordCount="false"), ok404=True) or {}
        skip = {x["Id"] for x in ser.get("Items", [])}
        d = jf(profile, "GET", "/Items", dict(common, Recursive="true", IncludeItemTypes="Episode", Genres=genre,
                                                Limit="600", Fields=INDEX_FIELDS + ",SeriesId", EnableTotalRecordCount="false"), ok404=True) or {}
        return [episode_item(r) for r in d.get("Items", []) if r.get("SeriesId") not in skip]

    futs = [_pool.submit(f) for f in (resume, next_up, latest)]
    sfuts = {x["key"]: _pool.submit(seasonal, x["genre"]) for x in SEASONS}
    out = {}
    for name, fu in zip(("resume", "nextUp", "latest"), futs):
        out[name] = fu.result()
    out["seasonal"] = {k: fu.result() for k, fu in sfuts.items()}
    out["halloween"] = out["seasonal"].get("halloween", [])   # older cached clients
    _cache.put(key, out, HOME_TTL)
    return out


def _fetch_one(profile, item_id):
    d = jf(profile, "GET", "/Items", {"userId": profile["userId"], "Ids": item_id, "Fields": INDEX_FIELDS,
                                      "EnableImageTypes": IMAGE_TYPES_Q, "ImageTypeLimit": "1"})
    items = (d or {}).get("Items") or []
    return items[0] if items else None


def _resume_after_latest(profile, series_id, fields=None):
    """Jellyfin's NextUp only looks after the single most recently played episode, so jumping
    ahead to a brand-new episode leaves it with nothing (South Park: watched S29E2, so 'caught
    up', though S24-S28 are unwatched). Walk back through what was played, newest first, and
    return the first unwatched episode after the latest one that has any left after it."""
    d = jf(profile, "GET", "/Shows/%s/Episodes" % series_id,
           {"userId": profile["userId"], "Fields": fields or "UserData", "EnableTotalRecordCount": "false"},
           ok404=True, timeout=30) or {}
    eps = [e for e in d.get("Items", []) if e.get("Type") == "Episode" and (e.get("ParentIndexNumber") or 0) > 0]
    eps.sort(key=lambda e: (e.get("ParentIndexNumber") or 0, e.get("IndexNumber") or 0))
    pos = {e["Id"]: i for i, e in enumerate(eps)}
    played = [e for e in eps if (e.get("UserData") or {}).get("Played")]
    played.sort(key=lambda e: (e.get("UserData") or {}).get("LastPlayedDate") or "", reverse=True)
    for e in played:
        i = pos[e["Id"]] + 1
        while i < len(eps) and (eps[i].get("UserData") or {}).get("Played"):
            i += 1   # already seen further on (e.g. a season watched months ago): keep going
        if i < len(eps):
            return eps[i]
    return None


def api_item(profile, item_id):
    uid = profile["userId"]
    key = ("item", uid, item_id)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    raw = _fetch_one(profile, item_id)
    if raw and raw.get("Type") in ("Episode", "Season") and raw.get("SeriesId"):
        item_id = raw["SeriesId"]
        raw = _fetch_one(profile, item_id)
    if not raw or raw.get("Type") not in ("Movie", "Series"):
        raise ApiError(404, "not_found")
    is_series = raw["Type"] == "Series"

    def seasons():
        d = jf(profile, "GET", "/Shows/%s/Seasons" % item_id,
               {"userId": uid, "Fields": "ChildCount,RecursiveItemCount"})
        out = []
        for s in (d or {}).get("Items", []):
            out.append(_prune({
                "id": s["Id"], "name": s.get("Name"), "index": s.get("IndexNumber"),
                "episodeCount": s.get("ChildCount") or s.get("RecursiveItemCount") or 0,
                "unplayedCount": (s.get("UserData") or {}).get("UnplayedItemCount"),
            }))
        return out

    def next_up():
        d = jf(profile, "GET", "/Shows/NextUp", {"userId": uid, "seriesId": item_id, "Limit": "1",
                                                 "Fields": "Overview", "EnableTotalRecordCount": "false"})
        its = (d or {}).get("Items") or []
        nxt = _regular_next(its[0], profile, item_id) if its else None
        if nxt:
            return episode_item(nxt)
        ep = _resume_after_latest(profile, item_id, "Overview,UserData")
        return episode_item(ep) if ep else None

    def similar():
        d = jf(profile, "GET", "/Items/%s/Similar" % item_id,
               {"userId": uid, "Limit": "16", "Fields": INDEX_FIELDS, "EnableImageTypes": IMAGE_TYPES_Q,
                "ImageTypeLimit": "1"}, ok404=True, timeout=8)
        sims = [index_item(r) for r in (d or {}).get("Items", []) if r.get("Type") in ("Movie", "Series")]
        return sims[:12]

    fs = _pool.submit(seasons) if is_series else None
    fn = _pool.submit(next_up) if is_series else None
    fm = _pool.submit(similar)

    out = index_item(raw)
    people = raw.get("People") or []
    out["overview"] = _clip(raw.get("Overview"), 3000)   # the detail page shows it all (index rows keep the short one)
    out["tagline"] = (raw.get("Taglines") or [None])[0]
    out["cast"] = [_prune({"name": p["Name"], "role": p.get("Role") or None})
                   for p in people if p.get("Type") == "Actor" and p.get("Name")][:20]
    dirs = []
    for p in people:
        if p.get("Type") == "Director" and p.get("Name") and p["Name"] not in dirs:
            dirs.append(p["Name"])
    out["directors"] = dirs
    out["studios"] = [s["Name"] for s in raw.get("Studios") or [] if s.get("Name")]
    degraded = False
    if is_series:
        out["seasons"] = fs.result()
        out["seasonCount"] = len(out["seasons"])
        try:
            out["nextUp"] = fn.result()
        except UpstreamError:   # side rails must never stop a title opening
            out["nextUp"] = None
            degraded = True
    try:
        out["similar"] = fm.result()
    except UpstreamError:
        out["similar"] = []
        degraded = True
    if not degraded:
        _cache.put(key, out, ITEM_TTL)
    return out


def api_season(profile, series_id, season_id):
    uid = profile["userId"]
    key = ("season", uid, series_id, season_id)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    d = jf(profile, "GET", "/Shows/%s/Episodes" % series_id,
           {"userId": uid, "seasonId": season_id, "Fields": "Overview"})
    out = [episode_item(r) for r in (d or {}).get("Items", []) if r.get("Type") == "Episode"]
    _cache.put(key, out, ITEM_TTL)
    return out


def api_toggle(profile, item_id, kind, value):
    uid = profile["userId"]
    method = "POST" if value else "DELETE"
    if kind == "played":
        primary, fallback = "/UserPlayedItems/%s" % item_id, "/Users/%s/PlayedItems/%s" % (uid, item_id)
    else:
        primary, fallback = "/UserFavoriteItems/%s" % item_id, "/Users/%s/FavoriteItems/%s" % (uid, item_id)
    d = jf(profile, method, primary, {"userId": uid}, ok404=True)
    if d is None:
        d = jf(profile, method, fallback, ok404=False)
    _cache.drop_user(uid)
    patch_index(uid, item_id, **{kind: value})


def api_season_tag(profile, item_id, genre, on):
    """Add/remove a season Genre (see SEASONS) on any movie, series or episode (admin only; the route checks). Locks Genres so a
    metadata refresh keeps it. Same tag seasonal_tag.py in private-home-landing writes."""
    uid = profile["userId"]
    full = jf(profile, "GET", "/Users/%s/Items/%s" % (uid, item_id), ok404=True)
    if not full:
        raise ApiError(404, "not_found")
    genres = [g for g in (full.get("Genres") or []) if g != genre]
    items = [g for g in (full.get("GenreItems") or []) if g.get("Name") != genre]
    if on:
        genres.append(genre)
        items.append({"Name": genre, "Id": "00000000000000000000000000000000"})
    full["Genres"], full["GenreItems"] = genres, items
    lf = full.get("LockedFields") or []
    if "Genres" not in lf:
        lf.append("Genres")
    full["LockedFields"] = lf
    jf(profile, "POST", "/Items/%s" % item_id, body=full)
    for k in ("home", "item"):
        _cache.drop_kind(k)
    with _index_lock:
        entries = list(_index.values())
    for entry in entries:
        for it in entry.items:
            if it["id"] == item_id:
                it["genres"] = [g for g in (it.get("genres") or []) if g != genre] + ([genre] if on else [])
        entry.dirty = True
        entry.rebuild()


def api_restart(profile, item_id):
    """\"Start over\": forget the saved resume position so the next play begins at 0:00."""
    uid = profile["userId"]
    body = {"PlaybackPositionTicks": 0}
    d = jf(profile, "POST", "/UserItems/%s/UserData" % item_id, {"userId": uid}, body=body, ok404=True)
    if d is None:
        jf(profile, "POST", "/Users/%s/Items/%s/UserData" % (uid, item_id), body=body)
    _cache.drop_user(uid)
    patch_index(uid, item_id)


# ----------------------------------------------------------------------------- TV hand-off

def _parse_iso(s):
    """Jellyfin timestamps carry 7 fractional digits; datetime wants at most 6. 0.0 when unparseable."""
    try:
        t = re.sub(r"(\.\d{6})\d+", r"\1", str(s)).replace("Z", "+00:00")
        return datetime.datetime.fromisoformat(t).timestamp()
    except (ValueError, TypeError):
        return 0.0


def handoff_sessions(uid):
    """This user's TV sessions that are playing or paused right now, newest check-in first.
    Reads Jellyfin /Sessions with the admin key (the TVs share a login, so only the device name tells them apart)."""
    key = _jf_admin_key()
    if not key:
        return []
    try:
        status, _h, raw = jf_raw("GET", "/Sessions", token=key, timeout=8)
        sess = json.loads(raw) if status == 200 else []
    except (UpstreamError, ValueError):
        return []
    now = time.time()
    out = []
    for s in sess if isinstance(sess, list) else []:
        item = s.get("NowPlayingItem") or {}
        if (s.get("Client") != "MyFlix TV" or norm_id(str(s.get("UserId") or "")) != uid or not item.get("Id")):
            continue
        seen = _parse_iso(s.get("LastPlaybackCheckIn") or s.get("LastActivityDate"))
        if now - seen > HANDOFF_MAX_AGE:
            continue
        ps = s.get("PlayState") or {}
        dev = s.get("DeviceName") or ""
        out.append({
            "itemId": norm_id(item["Id"]), "name": item.get("Name"), "type": item.get("Type"),
            "seriesName": item.get("SeriesName"),
            "season": item.get("ParentIndexNumber") if item.get("Type") == "Episode" else None,
            "episode": item.get("IndexNumber") if item.get("Type") == "Episode" else None,
            "positionMs": int((ps.get("PositionTicks") or 0) // 10000),
            "runtimeMs": int((item.get("RunTimeTicks") or 0) // 10000),
            "paused": bool(ps.get("IsPaused")),
            "device": dev, "tv": HANDOFF_TV_NAMES.get(dev) or dev or "TV",
            "canStop": dev in HANDOFF_TV_ADB, "_seen": seen,
        })
    out.sort(key=lambda x: x["_seen"], reverse=True)
    for x in out:
        x.pop("_seen")
    return out


def api_handoff(profile):
    """What a TV is playing for this profile right now (or {"playing": null})."""
    s = handoff_sessions(profile["userId"])
    return {"playing": _prune(s[0]) if s else None}


def adb_back(ip):
    """One Back press on a Fire TV: leaves the MyFlix player, which saves the position to Jellyfin. True when sent."""
    addr = "%s:5555" % ip
    try:
        subprocess.run([ADB, "connect", addr], capture_output=True, timeout=6)
        r = subprocess.run([ADB, "-s", addr, "shell", "input", "keyevent", "KEYCODE_BACK"], capture_output=True, timeout=6)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


ADB = os.environ.get("MYFLIX_ADB", "/opt/homebrew/bin/adb")
_handoff_lock = threading.Lock()


# Echo Hub alerts: Home Assistant POSTs here when the doorbell is pressed; the Echo page polls GET /api/echo/alert and
# jumps to the camera. State is in memory only (a restart just forgets the last alert).
_echo_alert = {"seq": 0, "kind": None, "ts": 0.0}
_echo_alert_lock = threading.Lock()


def echo_alert_set(kind):
    with _echo_alert_lock:
        _echo_alert.update(seq=_echo_alert["seq"] + 1, kind=kind, ts=time.time())
        return dict(_echo_alert)


def echo_alert_get():
    with _echo_alert_lock:
        a = dict(_echo_alert)
    return {"seq": a["seq"], "kind": a["kind"], "ageSec": int(time.time() - a["ts"]) if a["ts"] else None}


CAST_PKG = os.environ.get("MYFLIX_CAST_PKG", "dev.theprivatehome.myflix")
_cast_lock = threading.Lock()
_cast_last = {}   # email -> [timestamps]; at most 6 casts/min per account


def tv_now_item(dev):
    """What a TV is playing or paused on right now (any profile): {itemId, seriesId, season, episode, name}, else None.
    Reads Jellyfin /Sessions with the admin key; a session idle for more than 5 minutes does not count."""
    key = _jf_admin_key()
    if not key:
        return None
    try:
        status, _h, raw = jf_raw("GET", "/Sessions", token=key, timeout=8)
        sess = json.loads(raw) if status == 200 else []
    except (UpstreamError, ValueError):
        return None
    now = time.time()
    for s in sess if isinstance(sess, list) else []:
        if s.get("Client") != "MyFlix TV" or (s.get("DeviceName") or "") != dev:
            continue
        item = s.get("NowPlayingItem") or {}
        if not item.get("Id"):
            continue
        if now - _parse_iso(s.get("LastPlaybackCheckIn") or s.get("LastActivityDate")) > 300:
            continue
        ep = item.get("Type") == "Episode"
        ps = s.get("PlayState") or {}
        iid = norm_id(str(item["Id"]))
        tags = item.get("ImageTags") or {}
        img = ({"id": iid, "tag": tags["Primary"]} if tags.get("Primary")
               else {"id": norm_id(str(item.get("SeriesId") or "")), "tag": item.get("SeriesPrimaryImageTag")} if item.get("SeriesPrimaryImageTag") else None)
        return {"itemId": iid, "name": item.get("Name") or "something",
                "seriesId": norm_id(str(item.get("SeriesId") or "")) if ep else None,
                "seriesName": item.get("SeriesName") if ep else None,
                "season": item.get("ParentIndexNumber") if ep else None,
                "episode": item.get("IndexNumber") if ep else None,
                "paused": bool(ps.get("IsPaused")),
                "positionMs": int((ps.get("PositionTicks") or 0) // 10000),
                "runtimeMs": int((item.get("RunTimeTicks") or 0) // 10000),
                "img": img}
    return None


def tv_now_playing(dev):
    """Title of what a TV is playing right now, else None (used to warn before casting over it)."""
    n = tv_now_item(dev)
    return n["name"] if n else None


CAST_KEYS = {"play": "KEYCODE_MEDIA_PLAY", "pause": "KEYCODE_MEDIA_PAUSE",
             "rewind": "KEYCODE_MEDIA_REWIND", "forward": "KEYCODE_MEDIA_FAST_FORWARD"}
_ctl_last = {}   # email -> timestamps; at most 40 control taps/min per account


def adb_key(ip, keycode):
    """One key press on a Fire TV (the MyFlix player handles the media keys). True when sent."""
    addr = "%s:5555" % ip
    try:
        subprocess.run([ADB, "connect", addr], capture_output=True, timeout=6)
        r = subprocess.run([ADB, "-s", addr, "shell", "input", "keyevent", keycode], capture_output=True, timeout=6)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def adb_launch(ip):
    """Wake a Fire TV and open the MyFlix app (works even when its icon is missing from the home screen). True when sent."""
    addr = "%s:5555" % ip
    try:
        subprocess.run([ADB, "connect", addr], capture_output=True, timeout=6)
        subprocess.run([ADB, "-s", addr, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], capture_output=True, timeout=6)
        r = subprocess.run([ADB, "-s", addr, "shell", "am", "start", "-n", CAST_PKG + "/.Home"],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0 and "Error" not in (r.stdout or "") + (r.stderr or "")
    except (OSError, subprocess.SubprocessError):
        return False


def api_cast_control(email, dev, action):
    """Remote control for the title a TV is playing: play / pause / rewind / forward / stop (Back, which saves the position)."""
    if not CAST_ENABLED:
        raise ApiError(501, "cast_disabled")
    ip = HANDOFF_TV_ADB.get(dev)
    if not ip:
        raise ApiError(501, "cast_unavailable")
    if action not in CAST_KEYS and action not in ("stop", "launch"):
        raise ApiError(400, "bad_request")
    now = time.time()
    with _cast_lock:
        hits = [t for t in _ctl_last.get(email, []) if now - t < 60]
        if len(hits) >= 40:
            raise ApiError(429, "rate_limited", retry=15)
        _ctl_last[email] = hits + [now]
    if HANDOFF_DRYRUN:
        return {"ok": True, "dryRun": True}
    if action == "launch":
        if not adb_launch(ip):
            raise ApiError(502, "tv_unreachable")
        return {"ok": True}
    if action == "stop":
        for _ in range(3):                      # the first Back may only hide the controls
            if not adb_back(ip):
                raise ApiError(502, "tv_unreachable")
            for _w in range(8):
                time.sleep(0.5)
                if not tv_now_item(dev):
                    return {"ok": True}
        return {"ok": True}
    if not adb_key(ip, CAST_KEYS[action]):
        raise ApiError(502, "tv_unreachable")
    return {"ok": True}


def adb_cast(ip, item_id):
    """Wake a Fire TV and tell the MyFlix app to play one title (the app reads the `cast_item` launch extra). True when sent."""
    addr = "%s:5555" % ip
    try:
        subprocess.run([ADB, "connect", addr], capture_output=True, timeout=6)
        subprocess.run([ADB, "-s", addr, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], capture_output=True, timeout=6)
        r = subprocess.run([ADB, "-s", addr, "shell", "am", "start", "-n", CAST_PKG + "/.Home", "--es", "cast_item", item_id],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0 and "Error" not in (r.stdout or "") + (r.stderr or "")
    except (OSError, subprocess.SubprocessError):
        return False


def api_cast(email, dev, iid, force):
    if not CAST_ENABLED:
        raise ApiError(501, "cast_disabled")
    ip = HANDOFF_TV_ADB.get(dev)
    if not ip:
        raise ApiError(501, "cast_unavailable")
    now = time.time()
    with _cast_lock:
        hits = [t for t in _cast_last.get(email, []) if now - t < 60]
        if len(hits) >= 6:
            raise ApiError(429, "rate_limited", retry=30)
        _cast_last[email] = hits + [now]
    busy = None if force else tv_now_playing(dev)
    if busy:
        raise ApiError(409, "tv_busy", playing=busy)
    if HANDOFF_DRYRUN:
        return {"ok": True, "dryRun": True}
    if not adb_cast(ip, iid):
        raise ApiError(502, "tv_unreachable")
    return {"ok": True}


STT_URL = os.environ.get("MYFLIX_STT_URL", "http://127.0.0.1:8119")          # local whisper service for Echo voice search / wake word
HA_URL = os.environ.get("MYFLIX_HA_URL", "").rstrip("/")                      # Home Assistant, only for the doorbell live page
DOORBELL_CAMERA = os.environ.get("MYFLIX_DOORBELL_CAMERA", "")                # HA camera entity id, e.g. camera.front_door
_stt_hits = {}


def api_echo_stt(h, email):
    """Raw audio body (webm/ogg/wav, <= 2 MB) -> {"text"} from the local whisper service. Light per-user rate limit."""
    return {"text": api_echo_stt_raw(h, email, 20)[:200]}


# ---- Echo wake words: editable list, fuzzy match on a whisper transcript -----------------------------------
WAKE_FILE = DATA / "echo_wake.json"
WAKE_DEFAULT = {"words": ["hey jarvis"], "enabled": True, "chime": True}
_wake_lock = threading.Lock()
_wake_hits = deque(maxlen=200)


def _wake_norm(t):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9' ]+", " ", str(t or "").lower())).strip()


def wake_load():
    try:
        d = json.loads(WAKE_FILE.read_text())
    except Exception:
        d = {}
    out = dict(WAKE_DEFAULT)
    if isinstance(d.get("words"), list):
        out["words"] = [w for w in (_wake_norm(x) for x in d["words"]) if 2 <= len(w) <= 40][:10]
    for k in ("enabled", "chime"):
        if isinstance(d.get(k), bool):
            out[k] = d[k]
    return out


def wake_save(body):
    cur = wake_load()
    if isinstance(body.get("words"), list):
        words = []
        for x in body["words"][:20]:
            w = _wake_norm(x)
            if 2 <= len(w) <= 40 and w not in words:
                words.append(w)
        cur["words"] = words[:10]
    for k in ("enabled", "chime"):
        if isinstance(body.get(k), bool):
            cur[k] = body[k]
    with _wake_lock:
        tmp = WAKE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cur))
        tmp.replace(WAKE_FILE)
    return cur


def wake_match(text, words):
    """-> (matched, command). The wake phrase must open the utterance (first words), allowing for whisper's spelling."""
    import difflib
    toks = _wake_norm(text).split()
    for w in words:
        n = len(w.split())
        for k in (n, n + 1, max(1, n - 1)):
            if len(toks) < k:
                continue
            head = " ".join(toks[:k])
            if head == w or difflib.SequenceMatcher(None, head, w).ratio() >= 0.8 or head.replace(" ", "") == w.replace(" ", ""):
                return True, " ".join(toks[k:])
    return False, ""


def api_echo_stt_raw(h, email, limit, bucket=""):
    key = email + bucket
    now = time.time()
    hits = [t for t in _stt_hits.get(key, []) if now - t < 60]
    if len(hits) >= limit:
        raise ApiError(429, "rate_limited")
    _stt_hits[key] = hits + [now]
    ctype = (h.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if not (ctype.startswith("audio/") or ctype == "video/webm"):
        raise ApiError(415, "audio_required")
    try:
        n = int(h.headers.get("Content-Length") or 0)
    except ValueError:
        raise ApiError(400, "bad_request")
    if n <= 0 or n > 2_000_000:
        raise ApiError(400, "bad_request")
    data = h.rfile.read(n)
    try:
        req = urllib.request.Request(STT_URL, data=data, method="POST", headers={"Content-Type": "application/octet-stream"})
        with urllib.request.urlopen(req, timeout=25) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise ApiError(422 if e.code == 422 else 502, "bad_audio" if e.code == 422 else "stt_unavailable")
    except Exception:
        raise ApiError(502, "stt_unavailable")
    return str(out.get("text") or "")[:300]


def api_echo_wake(h, email):
    """Audio of one short utterance in. Transcribed locally and thrown away: only the match result goes back."""
    cfg = wake_load()
    if not cfg["enabled"] or not cfg["words"]:
        return {"wake": False, "off": True}
    text = api_echo_stt_raw(h, email, 90, "#wake")
    ok, cmd = wake_match(text, cfg["words"])
    out = {"wake": ok, "command": cmd if ok else ""}
    if h.headers.get("X-Wake-Debug") == "1":   # the Echo's "Test wake word" button: show what was heard
        out["text"] = text
    return out


def api_cast_targets():
    """TVs the Echo Hub can cast to: every named TV (MYFLIX_TV_NAMES / MYFLIX_TV_ADB); castable only when it also has an ADB address. IPs never leave the server."""
    return [{"device": dev, "name": HANDOFF_TV_NAMES.get(dev) or dev, "enabled": CAST_ENABLED and dev in HANDOFF_TV_ADB}
            for dev in dict.fromkeys([*HANDOFF_TV_NAMES, *HANDOFF_TV_ADB])]


def api_handoff_take(profile, device):
    """Stop the TV that is playing and make the next play of that title resume at the same second.
    Returns {itemId, positionMs, tvStopped}. The TV is stopped first so its own final progress report cannot
    overwrite the position afterwards."""
    uid = profile["userId"]
    with _handoff_lock:
        live = [s for s in handoff_sessions(uid) if not device or s["device"] == device]
        if not live:
            raise ApiError(404, "nothing_playing")
        now = live[0]
        iid, pos = now["itemId"], now["positionMs"]
        stopped = False
        if not HANDOFF_DRYRUN and now["canStop"]:
            ip = HANDOFF_TV_ADB[now["device"]]
            for _ in range(3):                      # first Back may only hide the controls
                if not adb_back(ip):
                    break
                for _w in range(8):
                    time.sleep(0.5)
                    if not any(s["device"] == now["device"] and s["itemId"] == iid for s in handoff_sessions(uid)):
                        stopped = True
                        break
                if stopped:
                    break
        if not HANDOFF_DRYRUN:
            if stopped:       # the TV saved its own final position on the way out: that one is the freshest
                row = _fetch_one(profile, iid) or {}
                saved = int(((row.get("UserData") or {}).get("PlaybackPositionTicks") or 0) // 10000)
                pos = saved or pos
            else:
                body = {"PlaybackPositionTicks": pos * 10000}
                d = jf(profile, "POST", "/UserItems/%s/UserData" % iid, {"userId": uid}, body=body, ok404=True)
                if d is None:
                    jf(profile, "POST", "/Users/%s/Items/%s/UserData" % (uid, iid), body=body)
            _cache.drop_user(uid)
            patch_index(uid, iid)
        return {"itemId": iid, "positionMs": pos, "tvStopped": stopped, "tv": now["tv"]}


# ----------------------------------------------------------------------------- suggestions (profile -> profile)

SUGG_FILE = DATA / "suggestions.json"
SUGG_TTL = 30 * 86400          # a suggestion lapses after 30 days
SUGG_PER_DAY = 5               # sent per sender per 24h
SUGG_MAX_STORED = 2000
_sugg_lock = threading.Lock()
_sugg_sendlog: list = []      # (sender userId, time) per suggestion sent, last 24h (in memory)


def _sugg_load():
    try:
        with open(SUGG_FILE) as f:
            d = json.load(f)
        return d if isinstance(d, list) else []
    except (OSError, ValueError):
        return []


def _sugg_save(lst):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = SUGG_FILE.with_suffix(".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(lst[-SUGG_MAX_STORED:], f)
    os.replace(tmp, SUGG_FILE)


# Accounts nobody but the maintainer should ever see in a picker (test/service logins), and who may see the whole roster.
HIDDEN_NAMES = {n.strip().lower() for n in os.environ.get("MYFLIX_HIDDEN_NAMES", "claude-test").split(",") if n.strip()}
NETMON = netmon.Monitor(DATA / "netmon.jsonl")
OWNER_EMAILS = {e.strip().lower() for e in os.environ.get("MYFLIX_OWNER_EMAILS", "").split(",") if e.strip()}
_jfusers = {"at": 0.0, "v": {}}
JF_ADMIN_KEYCHAIN = os.environ.get("MYFLIX_JF_ADMIN_KEYCHAIN", "myflix-jellyfin-admin")


def _jf_admin_key():
    k = os.environ.get("MYFLIX_JF_ADMIN_KEY", "").strip()
    if k:
        return k
    try:
        r = subprocess.run(["security", "find-generic-password", "-s", JF_ADMIN_KEYCHAIN, "-w"],
                           capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def jellyfin_user_names():
    """{userId: name} for every enabled Jellyfin account, so a suggestion can go to someone who has not signed in
    to MyFlix yet. Needs a Jellyfin admin API key (Keychain item myflix-jellyfin-admin); without one this is empty."""
    now = time.time()
    if now - _jfusers["at"] < 300:
        return _jfusers["v"]
    key = _jf_admin_key()
    out = {}
    if key:
        try:
            status, _h, raw = jf_raw("GET", "/Users", token=key, timeout=10)
            if status == 200:
                for u in json.loads(raw):
                    pol = u.get("Policy") or {}
                    if (isinstance(u, dict) and u.get("Id") and u.get("Name") and not pol.get("IsDisabled")
                            and str(u["Name"]).lower() not in HIDDEN_NAMES):   # (IsHidden only hides from Jellyfin's own login list; new users default to it)
                        out[norm_id(u["Id"]) or u["Id"]] = u["Name"]
        except (UpstreamError, ValueError):
            out = _jfusers["v"]
    _jfusers.update(at=now, v=out)
    return out


def all_profile_names():
    """{userId: name}: every Jellyfin account (when the admin key is set) plus every profile linked to MyFlix."""
    out = dict(jellyfin_user_names())
    with _sess_lock:
        for ent in _load_sessions().values():
            for p in (ent or {}).get("profiles", []):
                if p.get("userId") and p.get("name") and str(p["name"]).lower() not in HIDDEN_NAMES:
                    out[p["userId"]] = p["name"]
    return out


def visible_names(email):
    """Who this signed-in person may see or suggest to: the owners see everyone (minus hidden accounts);
    anyone else only sees the profiles linked under their own email."""
    if (email or "").lower() in OWNER_EMAILS:
        return all_profile_names()
    return {p["userId"]: p["name"] for p in get_profiles(email) if p.get("name") and str(p["name"]).lower() not in HIDDEN_NAMES}


def api_suggest_targets(profile, email):
    return [{"userId": u, "name": n} for u, n in sorted(visible_names(email).items(), key=lambda kv: kv[1].lower())
            if u != profile["userId"]]


def api_suggest(profile, item_id, to_ids, note, email=""):
    names = visible_names(email)
    me = profile["userId"]
    to = []
    for t in to_ids:
        t = norm_id(t) if isinstance(t, str) else None
        if t and t != me and t in names and t not in to:
            to.append(t)
    if not to or len(to) > 12:
        raise ApiError(400, "bad_request")
    note = " ".join(str(note or "").split())[:140]
    raw = _fetch_one(profile, item_id)
    if not raw or raw.get("Type") not in ("Movie", "Series"):
        raise ApiError(404, "not_found")
    now = time.time()
    with _sugg_lock:
        lst = [x for x in _sugg_load() if now - x.get("ts", 0) < SUGG_TTL]
        # Count from a separate send log, so dismissing / watching / re-suggesting never hands the allowance back.
        log = [t0 for (who, t0) in _sugg_sendlog if who == me and now - t0 < 86400]
        if len(log) + len(to) > SUGG_PER_DAY:
            raise ApiError(429, "rate_limited", retry=3600)
        _sugg_sendlog[:] = [(w, t0) for (w, t0) in _sugg_sendlog if now - t0 < 86400] + [(me, now)] * len(to)
        for t in to:   # re-suggesting the same title replaces the old one (fresh note, back on top)
            lst = [x for x in lst if not (x["from"] == me and x["to"] == t and x["itemId"] == item_id)]
            lst.append({"id": os.urandom(6).hex(), "itemId": item_id, "from": me, "fromName": profile["name"],
                        "to": t, "note": note, "ts": now})
        _sugg_save(lst)
    return {"ok": True, "sent": len(to), "names": [names[t] for t in to]}


def api_suggestions(profile):
    now = time.time()
    uid = profile["userId"]
    with _sugg_lock:
        mine = [x for x in _sugg_load() if x.get("to") == uid and now - x.get("ts", 0) < SUGG_TTL]
    mine.sort(key=lambda x: -x["ts"])
    return [{"id": x["id"], "itemId": x["itemId"], "from": x["from"], "fromName": x["fromName"],
             "note": x.get("note", ""), "ts": x["ts"]} for x in mine]


def api_suggestion_dismiss(profile, sid):
    uid = profile["userId"]
    with _sugg_lock:
        lst = _sugg_load()
        keep = [x for x in lst if not (x.get("id") == sid and x.get("to") == uid)]
        if len(keep) == len(lst):
            raise ApiError(404, "not_found")
        _sugg_save(keep)
    return {"ok": True}


def api_suggestions_clear_item(profile, item_id):
    """Watching a title clears the suggestions of it that were sent to this profile."""
    uid = profile["userId"]
    with _sugg_lock:
        lst = _sugg_load()
        keep = [x for x in lst if not (x.get("to") == uid and x.get("itemId") == item_id)]
        if len(keep) != len(lst):
            _sugg_save(keep)


# ----------------------------------------------------------------------------- Jellyseerr (requests)

class SeerrError(Exception):
    def __init__(self, status, message=""):
        super().__init__("seerr %s" % status)
        self.status = status
        self.message = message


_seerr_key = {"v": None, "at": 0.0}
_seerr_key_lock = threading.Lock()


def seerr_key():
    """API key from MYFLIX_SEERR_KEY, else the macOS Keychain (read once; an empty result is retried at most every 60s)."""
    if not SEERR_URL:
        return None
    with _seerr_key_lock:
        if _seerr_key["v"]:
            return _seerr_key["v"]
        now = time.time()
        if now - _seerr_key["at"] < 60 and _seerr_key["at"]:
            return None
        _seerr_key["at"] = now
        k = os.environ.get("MYFLIX_SEERR_KEY", "").strip()
        if not k:
            try:
                r = subprocess.run(["security", "find-generic-password", "-s", SEERR_KEYCHAIN, "-w"],
                                   capture_output=True, text=True, timeout=5)
                k = r.stdout.strip() if r.returncode == 0 else ""
            except (OSError, subprocess.SubprocessError):
                k = ""
        _seerr_key["v"] = k or None
        return _seerr_key["v"]


def _safe_msg(raw, status):
    msg = ""
    try:
        d = json.loads(raw)
        if isinstance(d, dict) and isinstance(d.get("message"), str):
            msg = d["message"]
    except (ValueError, TypeError):
        pass
    msg = "".join(ch for ch in " ".join(msg.split()) if ch.isprintable())[:140]
    return msg or "Request service error (HTTP %s)" % status


def seerr_call(method, path, body=None):
    """JSON call to Jellyseerr as the admin key. Raises SeerrError on any failure; the key never leaves this function."""
    key = seerr_key()
    if not key:
        raise ApiError(503, "seerr_unconfigured")
    data = None
    headers = {"X-Api-Key": key, "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(SEERR_URL + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=SEERR_TIMEOUT) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        try:
            raise SeerrError(e.code, _safe_msg(e.read(), e.code))
        finally:
            e.close()
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError):
        raise SeerrError(0, "Request service is unreachable")
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        raise SeerrError(502, "Request service sent a bad response")


def _norm_name(s):
    return " ".join(str(s or "").lower().split())


def match_seerr_user(users, profile):
    """Jellyseerr user for a MyFlix profile: jellyfinUserId first (dash/case-insensitive), else a
    case-insensitive name match on jellyfinUsername / displayName / username. None if nobody matches."""
    uid = str(profile.get("userId") or "").replace("-", "").lower()
    if uid:
        for u in users:
            if str(u.get("jellyfinUserId") or "").replace("-", "").lower() == uid:
                return u
    name = _norm_name(profile.get("name"))
    if name:
        for u in users:
            if name in (_norm_name(u.get("jellyfinUsername")), _norm_name(u.get("displayName")),
                        _norm_name(u.get("username"))):
                return u
    return None


def seerr_user_for(profile):
    users = _cache.get(("seerr-users", "all"))
    if users is None:
        d = seerr_call("GET", "/api/v1/user?take=100")
        users = [u for u in (d or {}).get("results", []) if isinstance(u, dict) and isinstance(u.get("id"), int)]
        _cache.put(("seerr-users", "all"), users, SEERR_USERS_TTL)
    return match_seerr_user(users, profile)


_SEERR_STATUS = {5: "available", 4: "partial", 3: "processing", 2: "pending"}


def seerr_status(media):
    """MyFlix status word for a Jellyseerr mediaInfo: available | partial | processing | pending | none."""
    if not isinstance(media, dict):
        return "none"
    st = _SEERR_STATUS.get(media.get("status"), "none")
    if st == "none":
        for r in media.get("requests") or []:
            if isinstance(r, dict) and r.get("status") == 1:
                return "pending"
    return st


# Jellyseerr's "processing" only means the request reached Sonarr/Radarr, not that anything is downloading.
# refine_status() replaces it with what is really happening: downloading | searching | noRelease.
QB_URL = os.environ.get("MYFLIX_QB_URL", "").rstrip("/")
NO_RELEASE_AFTER_H = 24
_qb_cache = {"at": 0.0, "v": []}
_qb_lock = threading.Lock()
_name_key = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower().replace("&", "and"))


def qb_torrents():
    """Torrent list from qBittorrent (MYFLIX_QB_URL, LAN, cached 20s). [] when unset or unreachable: callers then fall back to 'searching'."""
    with _qb_lock:
        if time.time() - _qb_cache["at"] < 20:
            return _qb_cache["v"]
        try:
            with urllib.request.urlopen(QB_URL + "/api/v2/torrents/info", timeout=4) as r:
                v = json.loads(r.read())
            v = v if isinstance(v, list) else []
        except Exception:
            v = []
        _qb_cache.update(at=time.time(), v=v)
        return v


def _live_torrent(t):
    """A torrent that is actually moving: not stuck fetching metadata, not errored, has data or seeds."""
    return (t.get("state") not in ("metaDL", "error", "missingFiles", "unknown")
            and (t.get("progress", 0) > 0 or t.get("num_seeds", 0) > 0))


def refine_status(st, media, title):
    if st != "processing":
        return st
    media = media if isinstance(media, dict) else {}
    if media.get("downloadStatus") or media.get("downloadStatus4k"):
        return "downloading"
    key = _name_key(title)
    if key and any(_name_key(t.get("name")).startswith(key) and _live_torrent(t) for t in qb_torrents()):
        return "downloading"
    born = []
    for r in media.get("requests") or []:
        if isinstance(r, dict) and r.get("status") == 2 and isinstance(r.get("createdAt"), str):
            try:
                born.append(datetime.datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00")).timestamp())
            except ValueError:
                pass
    if born and time.time() - min(born) > NO_RELEASE_AFTER_H * 3600:
        return "noRelease"
    return "searching"


def _tmdb_img(path, size):
    return TMDB_IMG + size + path if isinstance(path, str) and TMDB_PATH_RE.match(path) else None


def _discover_item(r):
    mt = r.get("mediaType")
    if mt not in ("movie", "tv") or not isinstance(r.get("id"), int):
        return None
    title = r.get("title") if mt == "movie" else r.get("name")
    if not title:
        return None
    date = r.get("releaseDate") if mt == "movie" else r.get("firstAirDate")
    year = int(date[:4]) if isinstance(date, str) and date[:4].isdigit() else None
    score = r.get("voteAverage")
    media = r.get("mediaInfo") if isinstance(r.get("mediaInfo"), dict) else None
    jf_id = norm_id(media.get("jellyfinMediaId")) if media and isinstance(media.get("jellyfinMediaId"), str) else None
    return {
        "tmdbId": r["id"], "mediaType": mt, "title": title, "year": year,
        "overview": _clip(r.get("overview"), 300) or "",
        "poster": _tmdb_img(r.get("posterPath"), "w342"), "backdrop": _tmdb_img(r.get("backdropPath"), "w780"),
        "score": round(score, 1) if isinstance(score, (int, float)) and score > 0 else None,
        "status": refine_status(seerr_status(media), media, title), "jellyfinId": jf_id,
    }


def api_discover_search(q):
    key = ("discover", q.lower())
    hit = _cache.get(key)
    if hit is not None:
        return hit
    enc = urllib.parse.quote(q, safe="")
    out, seen = [], set()
    for page in (1, 2):
        d = seerr_call("GET", "/api/v1/search?query=%s&page=%d" % (enc, page)) or {}
        for r in d.get("results") or []:
            it = _discover_item(r) if isinstance(r, dict) else None
            if it and (it["mediaType"], it["tmdbId"]) not in seen:
                seen.add((it["mediaType"], it["tmdbId"]))
                out.append(it)
        if len(out) >= 8 or (d.get("totalPages") or 1) <= page:
            break
    _cache.put(key, out, SEARCH_TTL)
    return out


def api_discover_tv(tmdb_id):
    key = ("discover-tv", str(tmdb_id))
    hit = _cache.get(key)
    if hit is not None:
        return hit
    d = seerr_call("GET", "/api/v1/tv/%d" % tmdb_id) or {}
    media = d.get("mediaInfo") if isinstance(d.get("mediaInfo"), dict) else None
    # season states: what the library already has, then seasons named in open requests
    state = {}
    if media:
        for s in media.get("seasons") or []:
            if isinstance(s, dict) and s.get("seasonNumber") is not None:
                state[s["seasonNumber"]] = _SEERR_STATUS.get(s.get("status"), "none")
        for r in media.get("requests") or []:
            if not isinstance(r, dict) or r.get("status") not in (1, 2):
                continue
            for s in r.get("seasons") or []:
                n = s.get("seasonNumber") if isinstance(s, dict) else None
                if n is not None and state.get(n, "none") == "none":
                    state[n] = "pending" if r["status"] == 1 else "processing"
    seasons = [{"season": s["seasonNumber"], "episodes": s.get("episodeCount") or 0,
                "status": state.get(s["seasonNumber"], "none")}
               for s in d.get("seasons") or []
               if isinstance(s, dict) and isinstance(s.get("seasonNumber"), int) and s["seasonNumber"] > 0]
    top = refine_status(seerr_status(media), media, d.get("name"))
    if top in ("searching", "noRelease"):
        for s in seasons:
            if s["status"] == "processing":
                s["status"] = top
    out = {"tmdbId": tmdb_id, "title": d.get("name") or "", "seasons": seasons, "status": top}
    _cache.put(key, out, SEARCH_TTL)
    return out


def api_request_title(profile, media_type, tmdb_id, seasons):
    """Create a Jellyseerr request on behalf of the profile's own Jellyseerr user. Jellyseerr decides
    approval from that user's permissions (we never force-approve and never use the key's own identity)."""
    user = seerr_user_for(profile)
    if not user:
        raise ApiError(403, "no_seerr_user")
    payload = {"mediaType": media_type, "mediaId": tmdb_id, "userId": user["id"]}
    if media_type == "tv":
        payload["seasons"] = seasons
    if SEERR_DRYRUN:
        return {"dryRun": True, "payload": payload}
    try:
        d = seerr_call("POST", "/api/v1/request", payload) or {}
    except SeerrError as e:
        if e.status == 409:
            raise ApiError(409, "already_requested")
        raise
    _cache.drop_kind("discover")
    _cache.drop_kind("discover-tv")
    media = d.get("media") if isinstance(d.get("media"), dict) else {}
    approved = d.get("status") == 2
    st = seerr_status(media)
    if st in ("none", "pending"):
        st = "searching" if approved else "pending"
    elif st == "processing":
        st = "searching"
    return {"status": st, "requestId": d.get("id"), "autoApproved": approved}


_req_hits = {}
_req_lock = threading.Lock()


def request_rate_limited(email):
    now = time.time()
    with _req_lock:
        q = _req_hits.setdefault(email, deque())
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= REQUEST_PER_MIN:
            return int(60 - (now - q[0])) + 1
        q.append(now)
    return 0


# ----------------------------------------------------------------------------- native playback info (Fire TV)

PLAY_FIELDS = "RunTimeTicks,UserData,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,PremiereDate,ProductionYear"
# Direct play everything: a profile with a single unrestricted Video direct-play entry and no transcoding.
_DIRECT_PLAY_BODY = {
    "DeviceProfile": {
        "Name": "MyFlix TV direct",
        "MaxStreamingBitrate": 200000000,
        "MaxStaticBitrate": 200000000,
        "MusicStreamingTranscodingBitrate": 192000,
        "DirectPlayProfiles": [{"Type": "Video"}, {"Type": "Audio"}],
        "TranscodingProfiles": [],
        "ContainerProfiles": [],
        "CodecProfiles": [],
        "SubtitleProfiles": [{"Format": "srt", "Method": "External"}],
    },
    "EnableDirectPlay": True,
    "EnableDirectStream": True,
    "EnableTranscoding": False,
    "AllowVideoStreamCopy": True,
    "AllowAudioStreamCopy": True,
    "AutoOpenLiveStream": False,
}


# ----------------------------------------------------------------------------- settings (theme)

SETTINGS_FILE = DATA / "settings.json"
ACCENT_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_settings_lock = threading.Lock()


def settings_load():
    try:
        d = json.loads(SETTINGS_FILE.read_text())
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def settings_set(key, value):
    with _settings_lock:
        d = settings_load()
        if value is None:
            d.pop(key, None)
        else:
            d[key] = value
        DATA.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(d))
        os.replace(tmp, SETTINGS_FILE)
        return d


_admin_cache = {}


def jf_is_admin(profile):
    """True when this linked profile is a Jellyfin administrator (checked live, cached for a minute). Setting the theme
    for everyone is tied to this, so the Jellyfin admin and any other account with the same permissions can, nobody else."""
    uid = (profile or {}).get("userId")
    if not uid:
        return False
    hit = _admin_cache.get(uid)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    try:
        u = jf(profile, "GET", "/Users/%s" % uid, ok404=True) or {}
        ok = bool((u.get("Policy") or {}).get("IsAdministrator"))
    except (UpstreamError, Relink):
        ok = False
    _admin_cache[uid] = (time.time(), ok)
    return ok


def api_settings(email, profile=None):
    owner = email.lower() in OWNER_EMAILS
    mode = "password" if LOCAL_AUTH else "dev" if DEV else "cloudflare"
    st = settings_load()
    return {"theme": {"accent": st.get("accent"), "secondary": st.get("secondary")}, "isOwner": owner,
            "canSetGlobalTheme": jf_is_admin(profile),
            "auth": {"mode": mode, "canChangePassword": bool(LOCAL_AUTH and owner)}}


# ----------------------------------------------------------------------------- live TV

EPG_HOURS = 6
_LIVE_WEATHER_RE = re.compile(r"weather|accuweather", re.I)
_LIVE_XMAS_RE = re.compile(r"christmas|holiday|xmas", re.I)
# Political lean of news channels, roughly following AllSides-style ratings (a judgment call: edit the patterns to taste).
# First match wins; anything unmatched is "Other news".
_LIVE_LEAN = [
    ("Left-leaning", re.compile(r"^(ms ?now|msnbc|cnn|hln|the young turks|free speech tv|abc news|cbs news|nbc news|today\b|usa today|black news)", re.I)),
    ("Right-leaning", re.compile(r"^(fox news|livenow from fox|newsmax|oan|one america|blaze|lindell|ntd|bek news|salem news|america.s voice|hollywire|the first tv)", re.I)),
    ("Center / Independent", re.compile(r"^(scripps|newsy|top stories by newsy|reuters|bloomberg|court tv|cheddar|voa|estrella news|weathernation|news of the world)", re.I)),
]
# Group order for the guide; categories come from the channel list's group-title (kept in data/livetv_meta.json).
_LIVE_ORDER = ["Christmas", "News", "Weather", "Movies", "Series", "Entertainment", "Comedy", "Kids", "Animation", "Documentary",
               "Sports", "Music", "Classic", "Lifestyle", "Cooking", "Travel", "Outdoor", "Education", "Culture", "Business",
               "Family", "General", "Legislative", "Religious", "Shop", "Auto", "Other"]
_LIVE_PROFILE = {"DeviceProfile": {
    "Name": "MyFlix live", "MaxStreamingBitrate": 12000000,
    "DirectPlayProfiles": [{"Type": "Video", "Container": "hls,mpegts,ts", "VideoCodec": "h264,hevc", "AudioCodec": "aac,mp3,ac3"}],
    "TranscodingProfiles": [{"Type": "Video", "Container": "ts", "Protocol": "hls", "VideoCodec": "h264",
                             "AudioCodec": "aac", "Context": "Streaming", "BreakOnNonKeyFrames": True}],
    "ContainerProfiles": [], "CodecProfiles": [], "SubtitleProfiles": []},
    "AutoOpenLiveStream": True}

_live_meta = {"mt": 0, "d": {}}


def _live_cat(raw_name):
    try:
        mt = os.stat(DATA / "livetv_meta.json").st_mtime
        if mt != _live_meta["mt"]:
            _live_meta.update(mt=mt, d=json.loads((DATA / "livetv_meta.json").read_text()))
    except (OSError, ValueError):
        pass
    return _live_meta["d"].get((raw_name or "").replace(",", " "), "")


def _live_group(name, raw=None):
    if _LIVE_XMAS_RE.search(name):
        return "Christmas"
    if _LIVE_WEATHER_RE.search(name):
        return "Weather"
    cat = _live_cat(raw or name)
    if cat == "News" or any(rx.search(name) for _g, rx in _LIVE_LEAN):
        return "News"
    if cat in ("Holiday",):
        return "Christmas"
    return cat if cat in _LIVE_ORDER else "Other"


def _live_lean(name):
    """'L' / 'R' for the blue/red glow, 'C' for center / independent news (plain black); '' for everything unrated."""
    if _LIVE_XMAS_RE.search(name) or _LIVE_WEATHER_RE.search(name):
        return ""
    for g, rx in _LIVE_LEAN:
        if rx.search(name):
            return "L" if g.startswith("Left") else "R" if g.startswith("Right") else "C"
    return ""


_live_cache = {}


def api_livetv(profile):
    hit = _live_cache.get(profile["userId"])
    if hit and time.time() - hit[0] < 45:
        return hit[1]
    out = _api_livetv(profile)
    _live_cache[profile["userId"]] = (time.time(), out)
    return out


def _api_livetv(profile):
    """Live channels (Jellyfin Live TV, fed by the M3U tuner) grouped for the Live section."""
    d = jf(profile, "GET", "/LiveTv/Channels", {"userId": profile["userId"], "SortBy": "SortName", "Limit": 3000}, ok404=True) or {}
    # Programmes for the next EPG_HOURS from the XMLTV guide; consecutive placeholder blocks ("Live: <channel>") are
    # sent as {"ph": 1} spans with no title so the grid can draw them as plain "Live" cells.
    t0 = int(time.time())
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
    progs, now = {}, {}
    try:
        pr = jf(profile, "GET", "/LiveTv/Programs", {"userId": profile["userId"], "MinEndDate": iso(t0),
                "MaxStartDate": iso(t0 + EPG_HOURS * 3600), "Limit": 40000, "SortBy": "StartDate"}, ok404=True) or {}
        for x in pr.get("Items") or []:
            try:
                st = calendar.timegm(time.strptime(x["StartDate"][:19], "%Y-%m-%dT%H:%M:%S"))
                en = calendar.timegm(time.strptime(x["EndDate"][:19], "%Y-%m-%dT%H:%M:%S"))
            except (KeyError, ValueError):
                continue
            t = (x.get("Name") or "").strip()
            ph = (not t) or t.startswith("Live: ")
            lst = progs.setdefault(x.get("ChannelId"), [])
            if ph and lst and lst[-1].get("ph") and lst[-1]["e"] >= st:
                lst[-1]["e"] = max(lst[-1]["e"], en)
                continue
            lst.append({"s": st, "e": en, **({"ph": 1} if ph else {"t": _clip(t, 90)})})
            if not ph and st <= t0 < en:
                now[x.get("ChannelId")] = _clip(t, 80)
    except (UpstreamError, ApiError):
        pass
    chans = []
    for c in d.get("Items") or []:
        name = re.sub(r"\s*\((?:\d{3,4}p|SD|HD)\)\s*$", "", c.get("Name") or "").strip()
        tag = (c.get("ImageTags") or {}).get("Primary")
        chans.append({"id": c["Id"], "name": name, "tag": tag, "now": now.get(c["Id"]), "progs": progs.get(c["Id"], []),
                      "group": _live_group(name, c.get("Name")), "lean": _live_lean(name)})
    return {"channels": chans, "groups": [g for g in _LIVE_ORDER if any(c["group"] == g for c in chans)], "t0": t0, "hours": EPG_HOURS}


# Relay for browsers: some channel hosts do not allow browser playback (no CORS), so MyFlix fetches the playlist and
# segments itself. It only ever fetches URLs it signed: the channel's own stream URL, then URLs found inside the
# playlists it fetched (re-signed on the way out). Private and loopback addresses are refused.
_RELAY_KEY = secrets.token_bytes(32)    # per process: relay links stop working after a restart, which is fine
_RELAY_MAX_PLAYLIST = 2_000_000
_RELAY_MAX_SEGMENT = 60_000_000
_RELAY_URI_RE = re.compile(r'URI="([^"]+)"')


def _relay_sig(url):
    return hmac.new(_RELAY_KEY, url.encode(), hashlib.sha256).hexdigest()[:40]


def _relay_link(url):
    return "/api/livetv/relay?u=%s&s=%s" % (urllib.parse.quote(url, safe=""), _relay_sig(url))


def _relay_public_host(url):
    """True when url is http(s) and its host resolves only to public addresses."""
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        return False
    try:
        for fam, _t, _p, _c, sa in socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80)):
            ip = ipaddress.ip_address(sa[0])
            if not ip.is_global:
                return False
    except (socket.gaierror, ValueError):
        return False
    return True


def _relay_rewrite(text, base):
    out = []
    for line in text.splitlines():
        t = line.strip()
        if not t:
            out.append(line)
        elif t.startswith("#"):
            out.append(_RELAY_URI_RE.sub(lambda m: 'URI="%s"' % _relay_link(urllib.parse.urljoin(base, m.group(1))), line))
        else:
            out.append(_relay_link(urllib.parse.urljoin(base, t)))
    return "\n".join(out) + "\n"


def api_live_playinfo(profile, channel_id, device=None, force_transcode=False, public=False, relay=False):
    """Native-player info for a live channel: an HLS URL Jellyfin keeps open until /api/livetv/stop."""
    uid = profile["userId"]
    remote = bool(device and device.get("remote"))
    if remote:
        remote_stream_check((device or {}).get("clientId") or "")
    it = jf(profile, "GET", "/Users/%s/Items/%s" % (uid, channel_id), ok404=True) or {}
    cname = re.sub(r"\s*\((?:\d{3,4}p|SD|HD)\)\s*$", "", it.get("Name") or "").strip() or "Live"
    pb = jf(profile, "POST", "/Items/%s/PlaybackInfo" % channel_id, {"userId": uid, "AutoOpenLiveStream": "false"},
            body={**_LIVE_PROFILE, "AutoOpenLiveStream": False}, timeout=45)
    srcs = (pb or {}).get("MediaSources") or []
    if not srcs or (pb or {}).get("ErrorCode"):
        raise ApiError(404, "not_playable")
    src = srcs[0]
    # Most channels are plain public HLS: hand the TV the source URL (no T14 transcode; Jellyfin's ffmpeg also chokes
    # on multi-variant HLS such as ABC News Live). Only non-HLS sources go through Jellyfin.
    path = src.get("Path") or ""
    if not force_transcode and re.match(r"https://[^\s]+\.m3u8(\?|$)", path):
        out = {"itemId": channel_id, "live": True, "direct": True, "name": cname, "streamUrl": _relay_link(path) if relay else path,
               "userId": uid, "remote": remote, "jellyfinBase": JELLYFIN_PUBLIC if remote else JELLYFIN_URL}
        if not public:   # a browser never needs the Jellyfin token for a direct stream, so it is not sent
            out["token"] = profile["token"]
        return _prune(out)
    pb = jf(profile, "POST", "/Items/%s/PlaybackInfo" % channel_id, {"userId": uid, "AutoOpenLiveStream": "true"},
            body=_LIVE_PROFILE, timeout=45)
    srcs = (pb or {}).get("MediaSources") or []
    if not srcs or (pb or {}).get("ErrorCode"):
        raise ApiError(404, "not_playable")
    src = srcs[0]
    rel = src.get("TranscodingUrl") or ""
    if not rel:
        raise ApiError(404, "not_playable")
    base = JELLYFIN_PUBLIC if (remote or public) else JELLYFIN_URL   # a browser outside the house needs the public address
    return _prune({"itemId": channel_id, "live": True, "name": cname,
                    "jellyfinBase": base, "userId": uid, "token": profile["token"],
                   "playSessionId": pb.get("PlaySessionId"), "liveStreamId": src.get("LiveStreamId"),
                   "streamUrl": base + rel + "&api_key=" + urllib.parse.quote(profile["token"]), "remote": remote})


def api_live_stop(profile, live_stream_id):
    if re.fullmatch(r"[A-Za-z0-9_\-]{8,200}", live_stream_id or ""):
        jf_raw("POST", "/LiveStreams/Close", {"liveStreamId": live_stream_id}, token=profile["token"],
               device_id="myflix-" + profile["userId"])


def _first_item(profile, path, params):
    d = jf(profile, "GET", path, params, ok404=True)
    its = (d or {}).get("Items") or []
    return its[0] if its else None


def _regular_next(ep, profile, series_id):
    """A NextUp answer, unless it is a season-less extra (Jellyfin sorts those first) on a series that has
    real seasons: then None, so the caller falls back to the walk-back / first regular episode."""
    if not ep or ep.get("ParentIndexNumber") is not None:
        return ep
    d = jf(profile, "GET", "/Shows/%s/Seasons" % series_id, {"userId": profile["userId"]}, ok404=True, timeout=15) or {}
    if any((s.get("IndexNumber") or 0) > 0 for s in d.get("Items", [])):
        return None
    return ep


def _resolve_playable(profile, item_id):
    uid = profile["userId"]
    raw = _fetch_one(profile, item_id)
    if not raw:
        raise ApiError(404, "not_found")
    typ = raw.get("Type")
    if typ in ("Movie", "Episode"):
        return raw
    if typ != "Series":
        raise ApiError(404, "not_playable")
    common = {"userId": uid, "Fields": PLAY_FIELDS, "EnableTotalRecordCount": "false"}
    ep = _regular_next(_first_item(profile, "/Shows/NextUp", dict(common, seriesId=item_id, Limit="1")), profile, item_id)
    if not ep:
        ep = _resume_after_latest(profile, item_id, PLAY_FIELDS)
    if not ep:
        ep = _first_item(profile, "/Shows/%s/Episodes" % item_id, dict(common, season="1", Limit="1"))
    if not ep:  # no season 1 (or numbered oddly): earliest regular season, specials last
        d = jf(profile, "GET", "/Shows/%s/Episodes" % item_id, common) or {}
        eps = [e for e in d.get("Items", []) if e.get("Type") == "Episode"]
        eps.sort(key=lambda e: ((e.get("ParentIndexNumber") or 0) == 0, e.get("ParentIndexNumber") or 0,
                                e.get("IndexNumber") or 0))
        ep = eps[0] if eps else None
    if not ep:
        raise ApiError(404, "not_playable")
    return ep


def _next_episode_id(profile, ep):
    sid = ep.get("SeriesId")
    if not sid:
        return None
    try:
        d = jf(profile, "GET", "/Shows/%s/Episodes" % sid,
               {"userId": profile["userId"], "startItemId": ep["Id"], "Limit": "8",
                "Fields": "LocationType", "EnableTotalRecordCount": "false"}, ok404=True, timeout=20)
    except UpstreamError:
        return None
    its = [e for e in (d or {}).get("Items", []) if e.get("Type") == "Episode"]
    if not its or its[0].get("Id") != ep["Id"]:
        return None
    return _pick_next(ep, its[1:])


def _pick_next(ep, candidates):
    """First real follow-on episode: not a season-less extra after a numbered season (series finale ->
    'Season Unknown' movie), not a second file for the same number (webisode / duplicate), not inside the
    current file's multi-episode range, not a missing (virtual) placeholder."""
    season, num = ep.get("ParentIndexNumber"), ep.get("IndexNumber")
    end = ep.get("IndexNumberEnd") or num
    for e in candidates:
        s2, n2 = e.get("ParentIndexNumber"), e.get("IndexNumber")
        if e.get("LocationType") == "Virtual":
            continue
        if (season or 0) > 0 and s2 is None:
            continue
        if s2 == season and n2 is not None and num is not None and num <= n2 <= end:
            continue
        return e.get("Id")
    return None


_CREDITS_CHAPTER = re.compile(r"\b(end(ing)?\s*credits?|credits?|outro|closing|end\s*titles?)\b", re.I)


def _credits_start(profile, ep, runtime_ms):
    """(startMs, source) for an episode's end credits. source is 'segment' (a Jellyfin Outro media
    segment, e.g. from an intro/credits detection plugin), 'chapter' (a chapter named like credits
    in the back half), or 'estimate' (a short window before the end) when nothing is marked."""
    pid = ep["Id"]

    def segments():
        d = jf(profile, "GET", "/MediaSegments/%s" % pid, {"includeSegmentTypes": "Outro"}, ok404=True, timeout=15)
        starts = [int(s["StartTicks"] // 10000) for s in (d or {}).get("Items", [])
                  if s.get("Type") == "Outro" and s.get("StartTicks")]
        return min(starts) if starts else None

    def chapters():
        d = jf(profile, "GET", "/Items/%s" % pid, {"userId": profile["userId"]}, ok404=True, timeout=15)
        for c in (d or {}).get("Chapters") or []:
            ms = int((c.get("StartPositionTicks") or 0) // 10000)
            if _CREDITS_CHAPTER.search(c.get("Name") or "") and runtime_ms and ms > runtime_ms * 0.5:
                return ms
        return None

    for fn, src in ((segments, "segment"), (chapters, "chapter")):
        try:
            ms = fn()
        except UpstreamError:
            ms = None
        if ms and (not runtime_ms or ms < runtime_ms):
            return ms, src
    if not runtime_ms or runtime_ms < 5 * 60000:
        return None, None
    tail = 30000 if runtime_ms <= 35 * 60000 else 60000
    return runtime_ms - tail, "estimate"


def api_playinfo(profile, item_id, device=None):
    """Native-player info. `device` (from the request identity) with remote=True gets the protections:
    a lease-based cap on concurrent streams, a 15 Mbps cap on the file, and public (https) URLs only."""
    uid = profile["userId"]
    remote = bool(device and device.get("remote"))
    cid = (device or {}).get("clientId") or ""
    if remote:
        remote_stream_check(cid)      # cheap, before touching the Pi
    ep = _resolve_playable(profile, item_id)
    pid = ep["Id"]
    _cache.drop_user(uid)   # progress is about to change: the next /api/item and /api/home must not be 30-60 s stale
    pb = jf(profile, "POST", "/Items/%s/PlaybackInfo" % pid, {"userId": uid}, body=_DIRECT_PLAY_BODY, timeout=45)
    srcs = (pb or {}).get("MediaSources") or []
    if not srcs or (pb or {}).get("ErrorCode"):
        raise ApiError(404, "not_playable")
    src = srcs[0]
    streams = src.get("MediaStreams") or []
    vcodec = next((x.get("Codec") for x in streams if x.get("Type") == "Video"), None)
    audio = [x for x in streams if x.get("Type") == "Audio"]
    acodec = next((x.get("Codec") for x in audio if x.get("IsDefault")), audio[0].get("Codec") if audio else None)
    ud = ep.get("UserData") or {}
    runtime_ticks = ep.get("RunTimeTicks") or src.get("RunTimeTicks") or 0
    pos = int((ud.get("PlaybackPositionTicks") or 0) // 10000)   # a re-watched (already Played) title still resumes where it was left
    if pos < 60000:
        pos = 0
    if runtime_ticks and pos >= runtime_ticks // 10000 * 0.95:
        pos = 0   # left in the credits (killed before Stopped was sent): the detail page says "Play", so start over
    msid = src.get("Id") or pid
    psid = pb.get("PlaySessionId") or ""
    token = profile["token"]
    if remote:
        rate = source_bitrate(src, runtime_ticks)
        if rate > REMOTE_MAX_BITRATE:
            raise ApiError(409, "too_high_bitrate", mbps=round(rate / 1e6, 1), maxMbps=REMOTE_MAX_BITRATE // 1_000_000)
        remote_stream_take(cid, psid, max(0, int(runtime_ticks // 10_000_000) - pos // 1000))
    # Path + query WITHOUT the api_key: the app appends "&api_key=<token>" to lanBase or publicBase + streamPath.
    stream_path = "/Videos/%s/stream?%s" % (pid, urllib.parse.urlencode(
        {"static": "true", "mediaSourceId": msid, "playSessionId": psid}))
    base = JELLYFIN_PUBLIC if remote else JELLYFIN_URL   # a remote device is never handed the LAN URL
    stream = "%s%s&%s" % (base, stream_path, urllib.parse.urlencode({"api_key": token}))
    out = {
        "premiere": (ep.get("PremiereDate") or "")[:10] or None, "year": ep.get("ProductionYear"),
        "itemId": pid, "name": ep.get("Name"), "logoItemId": ep.get("SeriesId") or pid,
        "seriesName": ep.get("SeriesName"), "season": ep.get("ParentIndexNumber") if ep.get("Type") == "Episode" else None,
        "episode": ep.get("IndexNumber") if ep.get("Type") == "Episode" else None,
        "runtimeMs": int(runtime_ticks // 10000), "startPositionMs": pos,
        "jellyfinBase": base, "userId": uid, "token": token,
        "mediaSourceId": msid, "playSessionId": psid, "streamUrl": stream,
        "lanBase": JELLYFIN_URL, "publicBase": JELLYFIN_PUBLIC, "serverId": SERVER_ID,
        "streamPath": stream_path, "remote": remote,
        "container": src.get("Container"), "videoCodec": vcodec, "audioCodec": acodec,
        "nextEpisodeId": _next_episode_id(profile, ep) if ep.get("Type") == "Episode" else None,
    }
    if out["nextEpisodeId"]:
        out["creditsStartMs"], out["creditsSource"] = _credits_start(profile, ep, out["runtimeMs"])
    return _prune(out)


# ----------------------------------------------------------------------------- images

_img_locks = [threading.Lock() for _ in range(64)]


def _sniff(b):
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    if b[:4] == b"GIF8":
        return "image/gif"
    if b[:5] == b"<?xml" or b[:4] == b"<svg":
        return "image/svg+xml"
    return "application/octet-stream"


def snap_width(w):
    for s in IMG_SIZES:
        if w <= s:
            return s
    return IMG_SIZES[-1]


def img_fetch(profile, item_id, typ, tag, w):
    """Returns (bytes, ctype, immutable) or None for a (cached) 404."""
    key = "%s_%s_%s_%d" % (item_id, typ, tag, w)
    path = IMG_DIR / key
    marker = IMG_DIR / (key + ".404")
    tagless = tag == "0"

    def from_disk():
        try:
            st = path.stat()
            if tagless and time.time() - st.st_mtime > IMG_TAGLESS_TTL:
                return None
            b = path.read_bytes()
            return b, _sniff(b), not tagless
        except OSError:
            return None

    def marker_fresh():
        try:
            return time.time() - marker.stat().st_mtime < IMG_404_TTL
        except OSError:
            return False

    hit = from_disk()
    if hit:
        return hit
    if marker_fresh():
        return None
    with _img_locks[hash(key) % len(_img_locks)]:
        hit = from_disk()
        if hit:
            return hit
        if marker_fresh():
            return None
        q = {"maxWidth": str(w), "quality": "82"}
        if not tagless:
            q["tag"] = tag
        is_user = item_id == profile["userId"]
        paths = ["/Users/%s/Images/%s" % (item_id, typ), "/UserImage"] if is_user else \
            ["/Items/%s/Images/%s" % (item_id, typ)]
        status, headers, raw = 404, None, b""
        for p in paths:
            qq = dict(q, userId=item_id) if p == "/UserImage" else q
            status, headers, raw = jf_raw("GET", p, qq, token=profile["token"],
                                          device_id="myflix-" + profile["userId"], timeout=45)
            if status == 401:
                raise Relink(profile["userId"])
            if status == 200:
                break
        IMG_DIR.mkdir(parents=True, exist_ok=True)
        if status == 200 and raw:
            tmp = IMG_DIR / (key + ".tmp%d" % threading.get_ident())
            tmp.write_bytes(raw)
            os.replace(tmp, path)
            try:
                marker.unlink()
            except OSError:
                pass
            return raw, _sniff(raw), not tagless
        if status in (400, 404):
            marker.write_bytes(b"0")
            return None
        raise UpstreamError(status, "image")


# ----------------------------------------------------------------------------- device registry (per-device tokens)

def _registry_token():
    """Internal-API secret from the macOS Keychain, read at use time (never cached, logged or printed)."""
    tf = os.environ.get("MYFLIX_REGISTRY_TOKEN_FILE", "")   # Linux hosts: a 0600 file instead of the Keychain
    if tf:
        try:
            t = Path(tf).read_text().strip()
        except OSError:
            return None
        return t if t and t.isascii() and t.isprintable() and " " not in t else None
    svc, acct = REGISTRY_KEYCHAIN
    try:
        r = subprocess.run(["security", "find-generic-password", "-s", svc, "-a", acct, "-w"],
                           capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return None
    t = r.stdout.strip() if r.returncode == 0 else ""
    return t if t and t.isascii() and t.isprintable() and " " not in t else None


_no_proxy_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class DeviceRegistry:
    """Client for the landing server's LAN-only device list: {clientId: {email,name,label,revoked}}.
    Fresh for `ttl`; if a refresh fails the last good copy is served for up to `stale_max` (so a landing
    restart does not log everyone out), after that - and when nothing was ever fetched - lookups return
    None, i.e. the caller fails CLOSED. An id that is not in the cache triggers an early re-fetch
    (rate-limited) so a device paired a minute ago works straight away."""

    def __init__(self, url, token_fn, clock=time.time, ttl=REGISTRY_TTL, stale_max=REGISTRY_STALE_MAX,
                 miss_refresh=REGISTRY_MISS_REFRESH, retry_after_fail=REGISTRY_RETRY_AFTER_FAIL, cache_path=None):
        self.url, self.token_fn, self.clock = url, token_fn, clock
        self.ttl, self.stale_max, self.miss_refresh, self.retry_after_fail = ttl, stale_max, miss_refresh, retry_after_fail
        self.cache_path = cache_path
        self._lock = threading.Lock()
        self._devices = None
        self._ok_at = 0.0
        self._try_at = 0.0
        self._last_failed = False
        self._load()

    def _load(self):
        """Last good copy from disk, so a T14 that boots while the landing box is down still knows its devices
        (LAN lookups accept it for REGISTRY_LAN_STALE_MAX; the public path keeps the short window)."""
        if not self.cache_path:
            return
        try:
            d = json.loads(Path(self.cache_path).read_text())
            if isinstance(d.get("devices"), dict) and isinstance(d.get("at"), (int, float)):
                self._devices, self._ok_at = d["devices"], float(d["at"])
        except (OSError, ValueError, AttributeError):
            pass

    def _save(self):
        if not self.cache_path:
            return
        try:
            tmp = Path(str(self.cache_path) + ".tmp")
            tmp.write_text(json.dumps({"at": self._ok_at, "devices": self._devices}))
            os.chmod(tmp, 0o600)
            tmp.replace(self.cache_path)
        except OSError as e:
            sys.stderr.write("registry: could not save cache (%s)\n" % type(e).__name__)

    def _fetch(self):
        if not self.url:
            return None, "no registry configured"
        tok = self.token_fn()
        if not tok:
            return None, "no internal token"
        req = urllib.request.Request(self.url, headers={"X-Internal-Token": tok, "Accept": "application/json"})
        try:
            with _no_proxy_opener.open(req, timeout=REGISTRY_TIMEOUT) as r:
                if r.status != 200:
                    return None, "http %s" % r.status
                raw = r.read(2 * 1024 * 1024)
            devs = json.loads(raw).get("devices")
        except urllib.error.HTTPError as e:
            e.close()
            return None, "http %s" % e.code
        except (urllib.error.URLError, socket.timeout, TimeoutError, OSError, ValueError, AttributeError) as e:
            return None, type(e).__name__
        if not isinstance(devs, dict):
            return None, "bad payload"
        out = {}
        for cid, v in devs.items():
            if isinstance(cid, str) and isinstance(v, dict):
                out[cid] = {"email": str(v.get("email") or "").strip().lower(), "name": str(v.get("name") or "")[:80],
                            "label": str(v.get("label") or "")[:80], "revoked": bool(v.get("revoked"))}
        return out, ""

    @staticmethod
    def _find(devs, cid):
        if cid in devs:
            return devs[cid]
        alt = cid[:-7] if cid.endswith(".access") else cid + ".access"   # tolerate the optional ".access" suffix
        return devs.get(alt)

    def lookup(self, cid, stale_max=None):
        """Device entry for a client id (revoked entries included), or None if unknown / registry unusable.
        `stale_max` overrides how old the last good copy may be (the LAN path passes a longer window)."""
        now = self.clock()
        stale_max = self.stale_max if stale_max is None else stale_max
        with self._lock:
            have = self._devices is not None
            fresh = have and now - self._ok_at < self.ttl
            cooling = now - self._try_at < (self.retry_after_fail if self._last_failed else self.miss_refresh)
            need = (not fresh or (have and self._find(self._devices, cid) is None)) and not cooling
            if need:
                self._try_at = now
                devs, why = self._fetch()
                if devs is not None:
                    changed = devs != self._devices
                    self._devices, self._ok_at, self._last_failed = devs, now, False
                    if changed or now - getattr(self, "_saved_at", 0) > 3600:
                        self._saved_at = now
                        self._save()
                else:
                    self._last_failed = True
                    sys.stderr.write("registry: fetch failed (%s)%s\n" % (
                        why, "; serving stale copy" if have and now - self._ok_at <= stale_max else ""))
            if self._devices is None or now - self._ok_at > stale_max:
                return None
            return self._find(self._devices, cid)


REGISTRY = DeviceRegistry(REGISTRY_URL, _registry_token, cache_path=DATA / "registry_cache.json")

_id_logged = {}
_id_log_lock = threading.Lock()


def _log_identity(cid, path):
    """One line per (device, outcome) per 10 min: which path resolved a service-token identity. No secrets."""
    now = time.time()
    with _id_log_lock:
        if now - _id_logged.get((cid, path), 0) < 600:
            return
        _id_logged[(cid, path)] = now
        if len(_id_logged) > 500:
            _id_logged.clear()
    sys.stderr.write("identity: service token %s... via=%s\n" % (cid[:8], path))


_auto_home = {"v4": set(), "v6": set()}   # v6 holds /64 prefixes


def _ip_key(ip):
    """('v4'|'v6', key) for an address string; v6 collapses to its /64. None if unparsable."""
    try:
        a = ipaddress.ip_address((ip or "").strip().split("%")[0])
    except ValueError:
        return None
    if a.version == 4:
        return "v4", str(a)
    return "v6", str(ipaddress.ip_network("%s/64" % a, strict=False).network_address)


def _configured_home():
    """MYFLIX_HOME_IPS as {'v4': {...}, 'v6': {/64 prefixes}}: a v6 entry (an address or a prefix) matches its whole /64,
    because phones rotate their privacy addresses inside it."""
    out = {"v4": set(), "v6": set()}
    for entry in HOME_IPS:
        k = _ip_key(entry.split("/")[0])
        if k:
            out[k[0]].add(k[1])
    return out


_cfg_home = _configured_home()


def is_home_ip(ip):
    """True if `ip` (Cf-Connecting-Ip) is one of the household's public addresses (configured or auto-detected)."""
    if not ip:
        return False
    if ip in HOME_IPS:
        return True
    k = _ip_key(ip)
    return bool(k and (k[1] in _auto_home[k[0]] or k[1] in _cfg_home[k[0]]))


def refresh_home_ips(fetch=None):
    """Look up this machine's public v4/v6 address (it is on the home network). A failed lookup keeps the old value."""
    fetch = fetch or _fetch_trace_ip
    for url in HOME_IP_PROBES:
        ip = fetch(url)
        k = _ip_key(ip) if ip else None
        if k:
            if _auto_home[k[0]] != {k[1]}:
                sys.stderr.write("home-ip: %s address %s\n" % (k[0], "updated" if _auto_home[k[0]] else "detected"))
            _auto_home[k[0]] = {k[1]}


def _fetch_trace_ip(url):
    try:
        with _no_proxy_opener.open(urllib.request.Request(url), timeout=5) as r:
            for line in r.read(4096).decode("ascii", "replace").splitlines():
                if line.startswith("ip="):
                    return line[3:].strip()
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError, ValueError):
        pass
    return None


def _home_ip_loop():
    while True:
        try:
            refresh_home_ips()
        except Exception as e:   # never let this thread die
            sys.stderr.write("home-ip refresh failed: %s\n" % type(e).__name__)
        time.sleep(HOME_IP_REFRESH)


# --- LAN device auth: the app works with the internet down (no Cloudflare Access in the path) ---
# A paired device fetches /api/lan-credential once while online. On the LAN it then sends
# X-MyFlix-Device "<clientId>:<lanSecret>"; the server answers with a signed session cookie so page
# sub-requests authenticate too. Accepted only from private source addresses that did not come through a proxy.
LAN_COOKIE = "myflix_lan"
LAN_COOKIE_TTL = 30 * 24 * 3600
LAN_BASE = os.environ.get("MYFLIX_LAN_BASE", "").rstrip("/")


def _load_lan_key():
    path = DATA / "lan.key"
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


_LAN_KEY = _load_lan_key()


def _lan_mac(msg):
    return hmac.new(_LAN_KEY, msg.encode(), hashlib.sha256).hexdigest()


def lan_secret(cid):
    return _lan_mac("secret:" + cid)


def lan_cookie_make(cid, now=None):
    exp = int((now or time.time()) + LAN_COOKIE_TTL)
    return "%s.%d.%s" % (cid, exp, _lan_mac("cookie:%s.%d" % (cid, exp)))


def lan_cookie_client(value, now=None):
    """clientId from a valid, unexpired LAN cookie, else None."""
    try:
        cid, exp, mac = (value or "").rsplit(".", 2)
        if int(exp) > (now or time.time()) and hmac.compare_digest(mac, _lan_mac("cookie:%s.%s" % (cid, exp))):
            return cid
    except ValueError:
        pass
    return None


def lan_cookie_left(value, now=None):
    """Seconds until a LAN cookie expires (0 if malformed); only called after it validated."""
    try:
        return max(0, int((value or "").rsplit(".", 2)[1]) - int(now or time.time()))
    except (ValueError, IndexError):
        return 0


def lan_header_client(value):
    """clientId from an 'id:secret' header value whose secret checks out, else None."""
    cid, _, sec = (value or "").partition(":")
    if cid and sec and hmac.compare_digest(sec, lan_secret(cid)):
        return cid
    return None


def is_lan_source(addr, headers):
    """Direct private-network peer, not relayed by the tunnel / a proxy."""
    if any(headers.get(h) for h in ("Cf-Connecting-Ip", "Cf-Ray", "X-Forwarded-For", "X-Forwarded-Host")):
        return False
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return ip.is_private and not ip.is_loopback


def resolve_service_identity(claims, ip=None, registry=None, stale_max=None):
    """(email, device) for a verified Access JWT payload without an email (a service token), else (None, None).
    The legacy shared TV token is checked first and behaves exactly as before; every other client id must be
    in the device registry and not revoked (unknown / revoked / registry never fetched -> fail closed)."""
    cn = claims.get("common_name")
    if not isinstance(cn, str) or not cn:
        return None, None
    if cn in TV_CLIENT_IDS and TV_EMAIL:
        _log_identity(cn, "legacy")
        return TV_EMAIL, {"clientId": cn, "path": "legacy", "remote": False}
    reg = registry or REGISTRY
    ent = reg.lookup(cn, stale_max) if stale_max is not None else reg.lookup(cn)
    if not ent:
        _log_identity(cn, "denied-unknown")
        return None, None
    if ent.get("revoked") or not ent.get("email"):
        _log_identity(cn, "denied-revoked")
        return None, None
    _log_identity(cn, "registry")
    return ent["email"], {"clientId": cn, "path": "registry", "name": ent.get("name"), "label": ent.get("label"),
                          "remote": not is_home_ip(ip)}


# Concurrent remote streams. Own bookkeeping rather than Jellyfin /Sessions: behind the Cloudflare tunnel
# Jellyfin sees the tunnel's address as RemoteEndPoint (not the viewer's), a non-admin profile token only
# lists its own sessions, and the call would hit the fragile Pi on every playback start. Instead each remote
# device holds ONE lease (a new playinfo from the same device replaces its old one, so skipping episodes
# never double-counts); it ends when the remaining runtime + 5 min passes, or on POST /api/playstop.
_streams = {}
_streams_lock = threading.Lock()


def _streams_prune(now):
    for k in [k for k, v in _streams.items() if v["exp"] <= now]:
        del _streams[k]


def remote_stream_check(cid):
    """Raise ApiError(429, too_many_streams) when 3 OTHER remote devices already hold a lease."""
    now = time.time()
    with _streams_lock:
        _streams_prune(now)
        if sum(1 for k in _streams if k != cid) >= REMOTE_MAX_STREAMS:
            raise ApiError(429, "too_many_streams", retry=60)


def remote_stream_take(cid, play_session, remaining_s):
    now = time.time()
    with _streams_lock:
        _streams_prune(now)
        if sum(1 for k in _streams if k != cid) >= REMOTE_MAX_STREAMS:
            raise ApiError(429, "too_many_streams", retry=60)
        ttl = max(REMOTE_LEASE_PAD, min(REMOTE_LEASE_MAX, remaining_s + REMOTE_LEASE_PAD))
        _streams[cid] = {"exp": now + ttl, "psid": play_session}


def remote_stream_release(cid, play_session=None):
    with _streams_lock:
        cur = _streams.get(cid)
        if cur and (not play_session or cur["psid"] == play_session):
            del _streams[cid]
            return True
    return False


def source_bitrate(src, runtime_ticks):
    """bits/s of a media source: the larger of Jellyfin's reported Bitrate and Size/duration (0 if unknown)."""
    best = 0
    b = src.get("Bitrate")
    if isinstance(b, (int, float)) and not isinstance(b, bool):
        best = int(b)
    size = src.get("Size")
    if isinstance(size, (int, float)) and runtime_ticks and runtime_ticks > 0:
        best = max(best, int(size * 8 / (runtime_ticks / 1e7)))
    return best


# ----------------------------------------------------------------------------- misc helpers

_link_hits = {}
_link_lock = threading.Lock()


def link_rate_limited(email):
    now = time.time()
    with _link_lock:
        q = _link_hits.setdefault(email, deque())
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= 5:
            return int(60 - (now - q[0])) + 1
        q.append(now)
    return 0


LINK_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">
<title>Sign in to MyFlix TV</title><style>
body{margin:0;background:#141414;color:#fff;font:17px/1.4 system-ui,sans-serif;display:flex;justify-content:center}
main{width:100%;max-width:26rem;padding:2rem 1.2rem}h1{font-size:1.5rem;margin:.2rem 0 .3rem}
.logo{color:#e50914;font-weight:800;letter-spacing:.04em;font-size:1.3rem}p{color:#b3b3b3;margin:.3rem 0 1.2rem}
code{background:#2a2a2a;padding:.1rem .5rem;border-radius:6px;color:#fff;letter-spacing:.12em}
input{width:100%;box-sizing:border-box;padding:.9rem 1rem;margin:0 0 .8rem;border-radius:8px;border:1px solid #444;background:#222;color:#fff;font:inherit}
button{width:100%;padding:.95rem;border:0;border-radius:8px;background:#e50914;color:#fff;font:700 1rem inherit;cursor:pointer}
button:disabled{opacity:.5}#m{margin-top:1rem;min-height:1.4rem}.ok{color:#46d369}.bad{color:#ff6b6b}
</style></head><body><main><div class="logo">MYFLIX</div><h1>Sign in on your TV</h1>
<p>Code on the TV: <code id="c">------</code><br>Type the Jellyfin username and password for the account you want on that TV.</p>
<form id="f"><input id="u" placeholder="Jellyfin username" autocomplete="username" autocapitalize="none" autocorrect="off" required>
<input id="p" type="password" placeholder="Password" autocomplete="current-password" required>
<button id="b" type="submit">Sign in</button></form><div id="m"></div>
<script>
const code=(new URLSearchParams(location.search).get('c')||'').toUpperCase();
document.getElementById('c').textContent=code||'(missing)';
const m=document.getElementById('m');
document.getElementById('f').addEventListener('submit',async e=>{
 e.preventDefault();const b=document.getElementById('b');b.disabled=true;m.className='';m.textContent='Signing in...';
 try{const r=await fetch('/api/link-session/'+encodeURIComponent(code)+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:document.getElementById('u').value.trim(),password:document.getElementById('p').value})});
  document.getElementById('p').value='';
  if(r.ok){const d=await r.json();m.className='ok';m.textContent='Done. '+d.name+' is signed in on your TV.';return}
  const d=await r.json().catch(()=>({}));b.disabled=false;m.className='bad';
  m.textContent=d.error==='bad_credentials'?'Wrong username or password.':d.error==='code_expired'?'That code expired. Press the sign-in button on the TV again.':d.error==='code_used'?'That code was already used.':d.error==='too_many_tries'?'Too many tries. Get a new code on the TV.':'Could not sign in. Try again.';
 }catch(x){b.disabled=false;m.className='bad';m.textContent='Could not reach MyFlix.'}
});
</script></main></body></html>"""


def do_link(email, username, password):
    """Sign in to Jellyfin and store the profile under [email]. Raises ApiError / UpstreamError."""
    if not isinstance(username, str) or not isinstance(password, str) or not username.strip() \
            or len(username) > 128 or len(password) > 256:
        raise ApiError(400, "bad_credentials")
    dev_id = "myflix-" + hashlib.sha1(email.encode()).hexdigest()[:12]
    status, _h, raw = jf_raw("POST", "/Users/AuthenticateByName",
                             body={"Username": username.strip(), "Pw": password}, device_id=dev_id, timeout=20)
    password = None
    if status in (400, 401, 403):
        raise ApiError(400, "bad_credentials")
    if status != 200:
        raise UpstreamError(status, "login")
    try:
        d = json.loads(raw)
        user = d["User"]
        prof = {"userId": user["Id"].replace("-", "").lower(), "name": user.get("Name") or username.strip(),
                "token": d["AccessToken"], "imageTag": user.get("PrimaryImageTag") or None}
    except (ValueError, KeyError, AttributeError):
        raise UpstreamError(502, "bad login response")
    upsert_profile(email, prof)
    _cache.drop_user(prof["userId"])
    return prof


# ----------------------------------------------------------------------------- sign in from a phone
# The TV shows a QR code + short code. The phone opens PHONE_BASE/link?c=CODE (behind the normal Google sign-in),
# types the Jellyfin username/password THERE, and the server links that account to the TV's own profile list.
# The password never touches the TV. Codes live 10 minutes, are single use and get 5 wrong tries.
PHONE_BASE = os.environ.get("MYFLIX_PHONE_BASE", "").rstrip("/")
_LINKSESS = {}
_linksess_lock = threading.Lock()
LINKSESS_TTL = 600
_LINK_ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def linksess_new(email):
    now = time.time()
    with _linksess_lock:
        for c in [c for c, v in _LINKSESS.items() if now - v["ts"] > LINKSESS_TTL]:
            _LINKSESS.pop(c, None)
        mine = [c for c, v in _LINKSESS.items() if v["email"] == email]
        for c in mine[:-4]:          # at most 5 live codes per TV account
            _LINKSESS.pop(c, None)
        code = "".join(_LINK_ALPHA[b % len(_LINK_ALPHA)] for b in os.urandom(6))
        _LINKSESS[code] = {"email": email, "ts": now, "done": False, "tries": 0, "userId": None, "name": None}
    return code


def linksess_valid(code):
    code = (code or "").strip().upper()
    with _linksess_lock:
        v = _LINKSESS.get(code)
        if not v or time.time() - v["ts"] > LINKSESS_TTL:
            _LINKSESS.pop(code, None)
            return None, None
        return code, v


_intruder_seen = {}
_intruder_lock = threading.Lock()


def log_intruder(ip, ua, path):
    now = time.time()
    with _intruder_lock:
        k = (ip, path)
        if now - _intruder_seen.get(k, 0) < 30:
            return
        _intruder_seen[k] = now
        if len(_intruder_seen) > 2000:
            _intruder_seen.clear()
        try:
            DATA.mkdir(parents=True, exist_ok=True)
            with open(INTRUDERS_FILE, "a") as f:
                f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "ip": ip,
                                    "ua": (ua or "")[:200], "path": path[:300]}) + "\n")
        except OSError:
            pass


DENIED_HTML = (b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" '
               b'content="width=device-width,initial-scale=1"><title>Access denied</title>'
               b'<style>html,body{height:100%;margin:0;background:#141414;color:#a3a3a3;'
               b'font:16px "Helvetica Neue",Helvetica,Arial,sans-serif}'
               b'body{display:flex;align-items:center;justify-content:center}'
               b'h1{color:#e50914;font-size:20px;letter-spacing:.2em;margin:0 0 8px}</style></head>'
               b'<body><div style="text-align:center"><h1>MYFLIX</h1>Access denied</div></body></html>')

MIME_OVERRIDES = {".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
                  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
                  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
                  ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".woff": "font/woff",
                  ".ico": "image/x-icon", ".webp": "image/webp"}
COMPRESSIBLE = ("text/", "application/json", "image/svg+xml", "application/manifest+json")
_static_gz = {}

ASSET_VER_RE = re.compile(r"^v[0-9a-f]{12}$")
_asset_ver = {"at": 0.0, "ver": ""}


def asset_version():
    """'v' + 12 hex chars derived from every static asset's path/mtime/size (recomputed ≤ every 2s)."""
    now = time.time()
    if now - _asset_ver["at"] < 2 and _asset_ver["ver"]:
        return _asset_ver["ver"]
    h = hashlib.sha1()
    for p in sorted(STATIC.rglob("*")):
        if p.is_file() and p.name != "index.html":
            st = p.stat()
            h.update(("%s:%d:%d;" % (p.relative_to(STATIC), st.st_mtime_ns, st.st_size)).encode())
    _asset_ver.update(at=now, ver="v" + h.hexdigest()[:12])
    return _asset_ver["ver"]


# ----------------------------------------------------------------------------- HTTP handler

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MyFlix"
    sys_version = ""
    _is_tv = False
    _device = None
    _lan_set_cookie = None

    # -- plumbing
    def log_message(self, fmt, *args):
        try:
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))
        except Exception:
            pass

    def log_request(self, code="-", size="-"):
        path = self.path.split("?")[0]
        sys.stderr.write("%s %s %s %s\n" % (time.strftime("%H:%M:%S"), self.command, path, code))

    def _accepts_gzip(self):
        return "gzip" in (self.headers.get("Accept-Encoding") or "")

    def _send(self, status, body=b"", ctype="application/json", extra=None, gz=None, compress=True):
        headers = {"Content-Type": ctype, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"}
        if extra:
            headers.update(extra)
        if gz is not None and self._accepts_gzip():
            body = gz
            headers["Content-Encoding"] = "gzip"
            headers["Vary"] = "Accept-Encoding"
        elif (compress and len(body) > 600 and self._accepts_gzip()
              and any(ctype.startswith(c) for c in COMPRESSIBLE)):
            body = gzip.compress(body, 5)
            headers["Content-Encoding"] = "gzip"
            headers["Vary"] = "Accept-Encoding"
        elif gz is not None:
            headers["Vary"] = "Accept-Encoding"
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        lan_cookie = getattr(self, "_lan_set_cookie", None)
        if lan_cookie:
            self.send_header("Set-Cookie", "%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax" % (LAN_COOKIE, lan_cookie, LAN_COOKIE_TTL))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, obj, extra=None):
        h = {"Cache-Control": "no-store"}
        if extra:
            h.update(extra)
        self._send(status, json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode(),
                   "application/json; charset=utf-8", h)

    def _client_ip(self):
        return (self.headers.get("Cf-Connecting-Ip") or self.client_address[0] or "?").strip()

    def _identity(self):
        """(email, is_tv) or (None, False); also sets self._device. Users: verified email claim. Native app: a
        verified Access service-token JWT has no email but carries common_name = client id; the legacy shared TV
        id acts as MYFLIX_TV_EMAIL, any other id is looked up in the device registry (see
        resolve_service_identity). is_tv=True for both."""
        self._device = None
        if DEV:
            who = (self.headers.get("X-MyFlix-Dev-Identity") or "").strip().lower()
            if who == "tv":
                self._device = {"clientId": "dev-tv", "path": "legacy", "remote": False}
                return (TV_EMAIL or "dev@local"), True
            if who.startswith("remote"):   # dev-only: exercise the registry path, "remote:<email>"
                self._device = {"clientId": "dev-remote", "path": "registry", "remote": True}
                return (who.partition(":")[2] or "remote@local"), True
            return "dev@local", False
        cookies = {}
        raw = self.headers.get("Cookie")
        if raw:
            try:
                c = SimpleCookie()
                c.load(raw)
                cookies = {k: m.value for k, m in c.items()}
            except Exception:
                cookies = {}
        if LOCAL_AUTH:
            return (LOCAL_AUTH.email, False) if LOCAL_AUTH.valid_cookie(cookies.get(local_auth.COOKIE)) else (None, False)
        if is_lan_source((getattr(self, "client_address", None) or ("",))[0], self.headers):
            hdr = self.headers.get("X-MyFlix-Device")
            cid = lan_header_client(hdr) if hdr else lan_cookie_client(cookies.get(LAN_COOKIE))
            if cid:
                email, dev = resolve_service_identity({"common_name": cid}, None, stale_max=REGISTRY_LAN_STALE_MAX)
                if email:
                    dev["remote"] = False
                    self._device = dev
                    if hdr or lan_cookie_left(cookies.get(LAN_COOKIE)) < LAN_COOKIE_TTL - 86400:
                        self._lan_set_cookie = lan_cookie_make(cid)   # sliding: a daily-used device never expires
                    return email, True
        if not CF_ACCESS_AUD:
            return None, False
        claims = sso_guard.verified_claims(self.headers, cookies, CF_TEAM_DOMAIN, CF_ACCESS_AUD)
        if not claims:
            return None, False
        email = str(claims.get("email") or claims.get("identity") or "").strip().lower()
        if email:
            return email, False
        email, self._device = resolve_service_identity(claims, self.headers.get("Cf-Connecting-Ip"))
        return (email, True) if email else (None, False)

    def _live_relay(self, query):
        """GET /api/livetv/relay?u=<url>&s=<signature>: playlist (rewritten) or segment, fetched by the server."""
        url = (query.get("u") or [""])[0]
        if not url or not hmac.compare_digest((query.get("s") or [""])[0], _relay_sig(url)) or not _relay_public_host(url):
            raise ApiError(403, "forbidden")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138 Safari/537.36"})
        try:
            r = urllib.request.urlopen(req, timeout=12)
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError, ValueError):
            raise ApiError(502, "upstream")
        with r:
            if not _relay_public_host(r.geturl()):   # a redirect must not lead somewhere private
                raise ApiError(403, "forbidden")
            ctype = (r.headers.get("Content-Type") or "").lower()
            head = r.read(7)
            if head.startswith(b"#EXTM3U") or "mpegurl" in ctype:
                body = head + r.read(_RELAY_MAX_PLAYLIST)
                text = _relay_rewrite(body.decode("utf-8", "replace"), r.geturl())
                return self._send(200, text.encode(), "application/vnd.apple.mpegurl", {"Cache-Control": "no-store"})
            self.send_response(200)
            self.send_header("Content-Type", ctype or "application/octet-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            sent = len(head)
            try:
                self.wfile.write(head)
                while sent < _RELAY_MAX_SEGMENT:
                    chunk = r.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    sent += len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

    def _local_auth_route(self, path, method):
        """MYFLIX_AUTH=password: POST /login (form field "password") sets the session cookie; POST /logout clears it."""
        secure = "; Secure" if (self.headers.get("X-Forwarded-Proto") or "").lower() == "https" else ""
        # same-origin (not the default no-referrer): with no-referrer a browser sends "Origin: null" on the form POST,
        # which the same-origin check below would refuse.
        nostore = {"Cache-Control": "no-store", "Referrer-Policy": "same-origin"}
        if method == "GET":
            return self._send(200, local_auth.login_page(), "text/html; charset=utf-8", nostore)
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        raw = self.rfile.read(n) if 0 < n <= 4096 else b""   # always drain the body, even when refusing
        if method != "POST" or not self._same_origin():
            raise ApiError(403, "origin")
        if path == "/logout":
            return self._send(303, b"", "text/plain", {**nostore, "Location": "/", "Set-Cookie":
                              "%s=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax%s" % (local_auth.COOKIE, secure)})
        ip = self.client_address[0]
        wait = LOCAL_AUTH.retry_after(ip)
        if wait:
            return self._send(429, local_auth.login_page(retry=wait), "text/html; charset=utf-8", {**nostore, "Retry-After": str(wait)})
        form = urllib.parse.parse_qs(raw.decode("utf-8", "replace"))
        if not LOCAL_AUTH.check_password((form.get("password") or [""])[0]):
            LOCAL_AUTH.record_fail(ip)
            log_intruder(ip, self.headers.get("User-Agent"), "/login (wrong password)")
            time.sleep(0.4)   # slows guessing a little on top of the per-address limit
            return self._send(401, local_auth.login_page(error="bad"), "text/html; charset=utf-8", nostore)
        LOCAL_AUTH.clear(ip)
        return self._send(303, b"", "text/plain", {**nostore, "Location": "/", "Set-Cookie":
                          "%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax%s" % (
                              local_auth.COOKIE, LOCAL_AUTH.make_cookie(), LOCAL_AUTH.ttl, secure)})

    def _deny(self, path):
        if not LOCAL_AUTH:   # password mode: an unauthenticated visitor is normal, not an intruder
            log_intruder(self._client_ip(), self.headers.get("User-Agent"), path)
        if path.startswith("/api/") or path.startswith("/img/"):
            self._json(401, {"error": "unauthorized"})
        elif LOCAL_AUTH:
            self._send(401, local_auth.login_page(), "text/html; charset=utf-8",
                       {"Cache-Control": "no-store", "Referrer-Policy": "same-origin"})   # see _local_auth_route
        else:
            self._send(401, DENIED_HTML, "text/html; charset=utf-8", {"Cache-Control": "no-store"})

    def _profile(self, email, required=True):
        profs = get_profiles(email)
        want = self.headers.get("X-MyFlix-Profile")
        if want:
            for p in profs:
                if p["userId"] == want:
                    return p
            raise ApiError(403, "profile")
        if required:
            raise ApiError(403, "profile")
        return profs[0] if profs else None

    def _body_json(self):
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ApiError(415, "json_required")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "bad_request")
        if n <= 0 or n > 16384:
            raise ApiError(400, "bad_request")
        try:
            d = json.loads(self.rfile.read(n))
        except ValueError:
            raise ApiError(400, "bad_request")
        if not isinstance(d, dict):
            raise ApiError(400, "bad_request")
        return d

    def _same_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or ""
        return urllib.parse.urlsplit(origin).netloc == host or DEV

    # -- dispatch
    def do_HEAD(self):
        self._dispatch("GET")

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _echo_alert_hook(self):
        """Home Assistant (same LAN) -> 'the doorbell was pressed'. Not for the public tunnel: anything that came through
        Cloudflare carries Cf-* headers and is refused; the caller must be a private-network address."""
        import ipaddress
        peer = self.client_address[0]
        try:
            private = ipaddress.ip_address(peer).is_private
        except ValueError:
            private = False
        if not private or any(h.lower().startswith("cf-") for h in self.headers.keys()):
            raise ApiError(403, "forbidden")
        body = self._body_json() if int(self.headers.get("Content-Length") or 0) > 0 else {}
        kind = body.get("kind") if body.get("kind") in ("doorbell",) else "doorbell"
        a = echo_alert_set(kind)
        return self._json(200, {"ok": True, "seq": a["seq"]})

    def _doorbell_live_page(self, query):
        """LAN-only page the TV's PiPup overlay loads: the front-door snapshot refreshed about once a second (a cheap 'live' view)."""
        import ipaddress
        try:
            private = ipaddress.ip_address(self.client_address[0]).is_private
        except ValueError:
            private = False
        if not private or any(h.lower().startswith("cf-") for h in self.headers.keys()):
            raise ApiError(403, "forbidden")
        if not HA_URL or not re.fullmatch(r"camera\.[a-z0-9_]+", DOORBELL_CAMERA):
            raise ApiError(404, "not_found")      # not configured (MYFLIX_HA_URL + MYFLIX_DOORBELL_CAMERA)
        tok = (query.get("t") or [""])[0]
        if not re.fullmatch(r"[A-Za-z0-9_\-]{8,200}", tok):
            raise ApiError(400, "bad_request")
        html = ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
                "<style>html,body{margin:0;background:#000;height:100%%;overflow:hidden}img{width:100%%;height:100%%;object-fit:contain;display:block}</style>"
                "<img id=a><script>var base=%s,a=document.getElementById('a'),n=0;"
                "function go(){var i=new Image();i.onload=function(){a.src=i.src;setTimeout(go,300)};i.onerror=function(){setTimeout(go,1500)};i.src=base+'&n='+(n++)}go();</script>" % json.dumps("%s/api/camera_proxy/%s?token=%s" % (HA_URL, DOORBELL_CAMERA, tok)))
        return self._send(200, html.encode(), "text/html; charset=utf-8", {"Cache-Control": "no-store"})

    def _jf_login(self, query):
        """Served on the Jellyfin host (tunnel path route). Verifies the Cloudflare Access sign-in against the
        Jellyfin app's AUD, then writes that profile's Jellyfin session into the web client's localStorage and
        opens the title. Only a profile that belongs to the signed-in email is ever used."""
        cookies = {}
        try:
            c = SimpleCookie(); c.load(self.headers.get("Cookie") or "")
            cookies = {k: m.value for k, m in c.items()}
        except Exception:
            pass
        if not CF_ACCESS_AUD_JF:
            # discovery aid: log the unverified aud once so it can be configured; never grants access
            try:
                tok = self.headers.get("Cf-Access-Jwt-Assertion") or cookies.get("CF_Authorization") or ""
                pl = tok.split(".")[1]; pl += "=" * (-len(pl) % 4)
                sys.stderr.write("jf-login: unconfigured; unverified aud=%s\n" % json.loads(base64.urlsafe_b64decode(pl)).get("aud"))
            except Exception:
                sys.stderr.write("jf-login: unconfigured; no jwt\n")
            return self._deny("/myflix-login")
        claims = sso_guard.verified_claims(self.headers, cookies, CF_TEAM_DOMAIN, CF_ACCESS_AUD_JF)
        email = str((claims or {}).get("email") or "").strip().lower()
        if not email:
            return self._deny("/myflix-login")
        iid = norm_id((query.get("id") or [""])[0])
        want = norm_id((query.get("p") or [""])[0])
        profs = get_profiles(email)
        prof = next((p for p in profs if want and norm_id(p["userId"]) == want), None) or (profs[0] if profs else None)
        if not iid or not prof or not prof.get("token") or not SERVER_ID:
            loc = "%s/web/#/details?id=%s&serverId=%s" % (JELLYFIN_PUBLIC, iid or "", SERVER_ID)
            return self._send(302, b"", "text/plain", {"Location": loc, "Cache-Control": "no-store"})
        cred = {"Servers": [{"Id": SERVER_ID, "Name": "Jellyfin", "ManualAddress": JELLYFIN_PUBLIC,
                             "AccessToken": prof["token"], "UserId": prof["userId"],
                             "DateLastAccessed": int(time.time() * 1000), "LastConnectionMode": 2}]}
        dest = "/web/#/details?id=%s&serverId=%s" % (iid, SERVER_ID)
        html = ("<!doctype html><meta charset=utf-8><title>Opening…</title><body style='background:#000'>"
                "<script>try{localStorage.setItem('jellyfin_credentials',%s)}catch(e){}location.replace(%s)</script>"
                % (json.dumps(json.dumps(cred)).replace("</", "<\\/"), json.dumps(dest)))
        return self._send(200, html.encode(), "text/html; charset=utf-8",
                          {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})

    def _dispatch(self, method):
        self._lan_set_cookie = None   # per request (keep-alive reuses the handler)
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path
        query = urllib.parse.parse_qs(parts.query)
        try:
            if path == "/healthz" and method == "GET":
                return self._send(200, b"ok", "text/plain", {"Cache-Control": "no-store"})
            if path == "/hook/doorbell-live" and method == "GET":
                return self._doorbell_live_page(query)
            if path == "/hook/echo-alert" and method == "POST":
                return self._echo_alert_hook()
            if path == "/myflix-login" and method == "GET":
                return self._jf_login(query)
            if LOCAL_AUTH and path in ("/login", "/logout"):
                return self._local_auth_route(path, method)
            if method == "GET" and path in ("/netmon", "/api/netmon") and is_lan_source((getattr(self, "client_address", None) or ("",))[0], self.headers):
                return self._netmon(path)   # read-only; open to the LAN so it works with the internet (and Cloudflare Access) down
            email, self._is_tv = self._identity()
            if not email:
                return self._deny(path)
            if method == "GET" and path in ("/netmon", "/api/netmon"):
                if email.lower() not in OWNER_EMAILS:
                    raise ApiError(403, "forbidden")
                return self._netmon(path)
            if path == "/api/lan-credential" and method == "GET":
                if not (self._is_tv and self._device):
                    raise ApiError(403, "forbidden")
                base = LAN_BASE or "http://%s:%d" % (HOST, PORT)
                return self._json(200, {"lanBase": base, "lanSecret": lan_secret(self._device["clientId"])})
            if method != "GET" and not self._same_origin():
                raise ApiError(403, "origin")
            segs = [urllib.parse.unquote(s) for s in path.split("/")[1:]]
            if method == "GET":
                return self._get(email, path, segs, query)
            if segs[:2] in (["api", "link-session"], ["api", "profiles"], ["api", "item"], ["api", "request"], ["api", "playstop"], ["api", "livetv"], ["api", "settings"], ["api", "suggest"], ["api", "suggestion"], ["api", "handoff"], ["api", "cast"], ["api", "echo"]):
                return self._write(email, method, segs)
            raise ApiError(404, "not_found")
        except ApiError as e:
            self._json(e.status, e.body, {"Retry-After": str(e.body["retry"])} if "retry" in e.body else None)
        except Relink as e:
            self._json(401, {"error": "relink", "userId": e.user_id})
        except UpstreamError as e:
            self._json(502, {"error": "upstream", "status": e.status})
        except SeerrError as e:
            self._json(502, {"error": "seerr", "message": e.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # never leak internals
            sys.stderr.write("handler error: %s: %s\n" % (type(e).__name__, e))
            try:
                self._json(500, {"error": "internal"})
            except Exception:
                pass

    def _netmon(self, path):
        if path == "/api/netmon":
            return self._json(200, NETMON.snapshot(), {"Cache-Control": "no-store"})
        return self._static("netmon.html")

    # -- GET routes
    def _get(self, email, path, segs, query):
        if segs[0] == "api":
            return self._api_get(email, segs, query)
        if segs[0] == "img" and len(segs) == 3:
            return self._img(email, segs[1], segs[2], query)
        if segs == ["link"]:   # the phone page behind the Google sign-in
            return self._send(200, LINK_PAGE.encode(), "text/html; charset=utf-8", {"Cache-Control": "no-store"})
        if segs[0] == "play" and len(segs) == 2:
            iid = norm_id(segs[1])
            if not iid:
                raise ApiError(404, "not_found")
            loc = "%s/web/#/details?id=%s&serverId=%s" % (JELLYFIN_PUBLIC, iid, SERVER_ID)
            pid = (query.get("p") or [""])[0]
            if JF_AUTOLOGIN and CF_ACCESS_AUD_JF and norm_id(pid):
                loc = "%s/myflix-login?id=%s&p=%s" % (JELLYFIN_PUBLIC, iid, norm_id(pid))
            return self._send(302, b"", "text/plain", {"Location": loc, "Cache-Control": "no-store"})
        if segs == ["echo"]:   # Echo Hub: compact touch UI for the Echo Show 5 launcher app
            return self._static("echo.html")
        if segs[0] == "static":
            if len(segs) > 2 and ASSET_VER_RE.match(segs[1]):
                return self._static("/".join(segs[2:]), versioned=True)
            return self._static("/".join(segs[1:]))
        if path.startswith("/img/") or path.startswith("/play/"):
            raise ApiError(404, "not_found")
        return self._static("index.html", spa=True)

    def _api_get(self, email, segs, query):
        name = segs[1] if len(segs) > 1 else ""
        if name == "me" and len(segs) == 2:
            mine = {p["userId"] for p in get_profiles(email)}
            others = ([{"userId": u, "name": n} for u, n in sorted(all_profile_names().items(), key=lambda kv: kv[1].lower()) if u not in mine]
                      if email.lower() in OWNER_EMAILS else [])
            return self._json(200, {"email": email,
                                    "profiles": [public_profile(p) for p in get_profiles(email)],
                                    "others": others,
                                    "jellyfinPublic": JELLYFIN_PUBLIC, "serverId": SERVER_ID,
                                    "theme": {"accent": settings_load().get("accent"), "secondary": settings_load().get("secondary")}})
        if name == "index" and len(segs) == 2:
            prof = self._profile(email)
            entry = get_index(prof, refresh=query.get("refresh", ["0"])[0] in ("1", "true"))
            inm = self.headers.get("If-None-Match")
            hdr = {"Cache-Control": "private, no-cache", "ETag": entry.etag}
            if inm and entry.etag in [t.strip().removeprefix("W/") for t in inm.split(",")]:   # Cloudflare weakens validators
                return self._send(304, b"", "application/json", hdr)
            return self._send(200, entry.body, "application/json; charset=utf-8", hdr, gz=entry.gz)
        if name == "home" and len(segs) == 2:
            return self._json(200, api_home(self._profile(email)))
        if name == "search" and len(segs) == 2:
            q = (query.get("q") or [""])[0]
            if len(q) > 100:
                raise ApiError(400, "bad_request")
            return self._json(200, api_search(self._profile(email), q), {"Cache-Control": "no-store"})
        if name == "link-session" and len(segs) == 3:   # the TV polling its own code
            code, v = linksess_valid(segs[2])
            if not v or v["email"] != email:
                raise ApiError(404, "not_found")
            return self._json(200, {"status": "done" if v["done"] else "pending", "userId": v["userId"], "name": v["name"],
                                    "ttl": max(0, int(LINKSESS_TTL - (time.time() - v["ts"])))})
        if name == "echo" and segs[2:] == ["wakewords"]:
            return self._json(200, wake_load(), {"Cache-Control": "no-store"})
        if name == "echo" and segs[2:] == ["alert"]:
            return self._json(200, echo_alert_get(), {"Cache-Control": "no-store"})
        if name == "cast" and segs[2:] == ["now"]:
            self._profile(email)
            dev = (query.get("device") or [""])[0]
            if dev not in {t["device"] for t in api_cast_targets()}:
                raise ApiError(400, "bad_request")
            return self._json(200, {"playing": tv_now_item(dev)}, {"Cache-Control": "no-store"})
        if name == "cast" and segs[2:] == ["targets"]:
            self._profile(email)
            return self._json(200, api_cast_targets(), {"Cache-Control": "no-store"})
        if name == "handoff" and len(segs) == 2:
            return self._json(200, api_handoff(self._profile(email)), {"Cache-Control": "no-store"})
        if name == "suggestions" and len(segs) == 2:
            return self._json(200, api_suggestions(self._profile(email)))
        if name == "suggest" and segs[2:] == ["targets"]:
            return self._json(200, api_suggest_targets(self._profile(email), email))
        if name == "item" and len(segs) == 3:
            iid = norm_id(segs[2])
            if not iid:
                raise ApiError(404, "not_found")
            return self._json(200, api_item(self._profile(email), iid))
        if name == "avatar" and len(segs) == 3:
            uid = norm_id(segs[2])
            prof = next((p for p in get_profiles(email) if p["userId"] == uid), None) if uid else None
            av = (prof or {}).get("avatar")
            if not (isinstance(av, dict) and av.get("kind") == "photo"):
                raise ApiError(404, "not_found")
            try:
                body = (AVATAR_DIR / (uid + ".bin")).read_bytes()
            except OSError:
                raise ApiError(404, "not_found")
            return self._send(200, body, av.get("ct") if av.get("ct") in _AVATAR_TYPES else "application/octet-stream",
                              {"Cache-Control": "private, max-age=86400", "Content-Security-Policy": "default-src 'none'",
                               "Content-Disposition": "inline"}, compress=False)
        if name == "settings" and len(segs) == 2:
            return self._json(200, api_settings(email, self._profile(email, required=False)), {"Cache-Control": "no-store"})
        if name == "livetv" and len(segs) == 2:
            return self._json(200, api_livetv(self._profile(email)), {"Cache-Control": "private, max-age=30"})
        if name == "livetv" and segs[2:] == ["relay"]:
            return self._live_relay(query)
        if name == "livetv" and len(segs) == 4 and segs[2] == "play":
            iid = norm_id(segs[3])
            if not iid:
                raise ApiError(404, "not_found")
            return self._json(200, api_live_playinfo(self._profile(email), iid, self._device,
                                                     force_transcode=(query.get("mode") or [""])[0] == "transcode",
                                                     relay=(query.get("mode") or [""])[0] == "relay",
                                                     public=(query.get("web") or [""])[0] == "1"), {"Cache-Control": "no-store"})
        if name == "playinfo" and len(segs) == 3:
            if not self._is_tv:
                raise ApiError(403, "forbidden")
            iid = norm_id(segs[2])
            if not iid:
                raise ApiError(404, "not_found")
            return self._json(200, api_playinfo(self._profile(email), iid, self._device))
        if name == "season" and len(segs) == 4:
            sid, seas = norm_id(segs[2]), norm_id(segs[3])
            if not sid or not seas:
                raise ApiError(404, "not_found")
            return self._json(200, api_season(self._profile(email), sid, seas))
        if name == "discover":
            self._profile(email)
            if len(segs) == 3 and segs[2] == "search":
                q = " ".join((query.get("q") or [""])[0].split())
                if not 2 <= len(q) <= 100:
                    raise ApiError(400, "bad_request")
                return self._json(200, api_discover_search(q))
            if len(segs) == 4 and segs[2] == "tv" and segs[3].isdigit() and len(segs[3]) <= 9:
                return self._json(200, api_discover_tv(int(segs[3])))
        raise ApiError(404, "not_found")

    # -- write routes
    def _write(self, email, method, segs):
        if method == "POST" and segs == ["api", "profiles", "link"]:
            return self._link(email)
        if method == "POST" and segs == ["api", "profiles", "customize"]:
            body = self._body_json()
            uid = norm_id(body.get("userId") if isinstance(body.get("userId"), str) else "")
            if not uid:
                raise ApiError(400, "bad_request")
            return self._json(200, profile_customize(email, uid, body))
        if method == "POST" and segs == ["api", "profiles", "photo"]:   # raw image body, ?userId=
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n <= 0 or n > AVATAR_MAX:
                if n > 0:   # drain what we can so the connection is not left mid-body
                    self.rfile.read(min(n, 1_000_000))
                raise ApiError(413, "too_large")
            data = self.rfile.read(n)
            uid = norm_id((urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("userId") or [""])[0])
            if not uid:
                raise ApiError(400, "bad_request")
            return self._json(200, profile_set_photo(email, uid, ctype, data))
        if method == "DELETE" and len(segs) == 3 and segs[1] == "profiles":
            uid = norm_id(segs[2])
            found = remove_profile(email, uid) if uid else None
            if not found:
                raise ApiError(404, "not_found")
            _cache.drop_user(uid)
            avatar_delete(uid)
            with _index_lock:
                _index.pop(uid, None)
            try:
                _index_path(uid).unlink()
            except OSError:
                pass
            try:  # best effort: revoke the Jellyfin session
                jf_raw("POST", "/Sessions/Logout", token=found["token"], device_id="myflix-" + uid, timeout=10)
            except UpstreamError:
                pass
            return self._json(200, {"ok": True})
        if method == "POST" and len(segs) == 4 and segs[1] == "item" and segs[3] == "restart":
            iid = norm_id(segs[2])
            if not iid:
                raise ApiError(404, "not_found")
            api_restart(self._profile(email), iid)
            return self._json(200, {"ok": True})
        if method == "POST" and len(segs) == 4 and segs[1] == "item" and segs[3] == "season":
            iid = norm_id(segs[2])
            if not iid:
                raise ApiError(404, "not_found")
            prof = self._profile(email)
            if not jf_is_admin(prof):
                raise ApiError(403, "forbidden")
            body = self._body_json()
            season = SEASON_BY_KEY.get(body.get("season"))
            if not season or not isinstance(body.get("on"), bool):
                raise ApiError(400, "bad_request")
            api_season_tag(prof, iid, season["genre"], body["on"])
            return self._json(200, {"season": season["key"], "on": body["on"]})
        if method == "POST" and len(segs) == 4 and segs[1] == "item" and segs[3] in ("played", "favorite"):
            iid = norm_id(segs[2])
            if not iid:
                raise ApiError(404, "not_found")
            prof = self._profile(email)
            kind = segs[3]
            key = "played" if kind == "played" else "favorite"
            body = self._body_json()
            if not isinstance(body.get(key), bool):
                raise ApiError(400, "bad_request")
            api_toggle(prof, iid, kind, body[key])
            if kind == "played" and body[key]:
                api_suggestions_clear_item(prof, iid)
            return self._json(200, {key: body[key]})
        if method == "POST" and segs == ["api", "link-session"]:   # from the TV: start a phone sign-in
            if not PHONE_BASE:
                raise ApiError(503, "phone_link_unavailable")
            wait = link_rate_limited(email)
            if wait:
                raise ApiError(429, "rate_limited", retry=wait)
            code = linksess_new(email)
            return self._json(200, {"code": code, "url": "%s/link?c=%s" % (PHONE_BASE, code), "ttl": LINKSESS_TTL})
        if method == "POST" and len(segs) == 4 and segs[1] == "link-session" and segs[3] == "complete":   # from the phone
            code, v = linksess_valid(segs[2])
            if not v:
                raise ApiError(404, "code_expired")
            with _linksess_lock:
                if v["done"]:
                    raise ApiError(409, "code_used")
                v["tries"] += 1
                if v["tries"] > 5:
                    _LINKSESS.pop(code, None)
                    raise ApiError(429, "too_many_tries")
            wait = link_rate_limited(email)
            if wait:
                raise ApiError(429, "rate_limited", retry=wait)
            body = self._body_json()
            prof = do_link(v["email"], body.get("username"), body.get("password"))
            with _linksess_lock:
                v["done"], v["userId"], v["name"] = True, prof["userId"], prof["name"]
            return self._json(200, {"ok": True, "name": prof["name"]})
        if method == "POST" and segs == ["api", "suggest"]:
            prof = self._profile(email)
            body = self._body_json()
            iid = norm_id(body.get("itemId")) if isinstance(body.get("itemId"), str) else None
            to = body.get("to")
            if not iid or not isinstance(to, list) or not all(isinstance(t, str) for t in to):
                raise ApiError(400, "bad_request")
            return self._json(200, api_suggest(prof, iid, to, body.get("note"), email))
        if method == "DELETE" and len(segs) == 3 and segs[1] == "suggestion":
            if not re.fullmatch(r"[0-9a-f]{12}", segs[2]):
                raise ApiError(404, "not_found")
            return self._json(200, api_suggestion_dismiss(self._profile(email), segs[2]))
        if method == "POST" and segs == ["api", "handoff", "take"]:   # phone/tablet only: a TV never takes from a TV
            ua = self.headers.get("User-Agent") or ""
            ios_app = "MyFlixApp/" in ua and " iOS" in ua     # the iPhone/iPad app signs in as a paired device (is_tv), but it is not a TV
            if self._is_tv and not ios_app:
                raise ApiError(403, "forbidden")
            body = self._body_json() if int(self.headers.get("Content-Length") or 0) > 0 else {}
            dev = body.get("device") if isinstance(body.get("device"), str) and len(body["device"]) <= 64 else ""
            return self._json(200, api_handoff_take(self._profile(email), dev))
        if method == "POST" and segs == ["api", "echo", "wake"]:   # Echo Hub wake word: one utterance in, {wake, command} out
            self._profile(email)
            return self._json(200, api_echo_wake(self, email))
        if method == "POST" and segs == ["api", "echo", "wakewords"]:
            self._profile(email)
            return self._json(200, wake_save(self._body_json()))
        if method == "POST" and segs == ["api", "echo", "stt"]:   # Echo Hub voice search: audio in, text out
            self._profile(email)
            return self._json(200, api_echo_stt(self, email))
        if method == "POST" and segs == ["api", "cast", "control"]:
            self._profile(email)
            body = self._body_json() if int(self.headers.get("Content-Length") or 0) > 0 else {}
            dev, action = body.get("device"), body.get("action")
            if not isinstance(dev, str) or dev not in {t["device"] for t in api_cast_targets()} or not isinstance(action, str):
                raise ApiError(400, "bad_request")
            return self._json(200, api_cast_control(email, dev, action))
        if method == "POST" and segs == ["api", "cast"]:   # Echo Hub (paired like a TV)
            self._profile(email)
            body = self._body_json() if int(self.headers.get("Content-Length") or 0) > 0 else {}
            dev, iid = body.get("device"), norm_id(str(body.get("itemId") or ""))
            if not isinstance(dev, str) or dev not in {t["device"] for t in api_cast_targets()} or not iid:
                raise ApiError(400, "bad_request")
            return self._json(200, api_cast(email, dev, iid, body.get("force") is True))
        if method == "POST" and segs == ["api", "request"]:
            return self._request(email)
        if method == "POST" and segs == ["api", "settings", "theme"]:   # a Jellyfin administrator sets the default for everyone
            prof = self._profile(email)
            if not jf_is_admin(prof):
                raise ApiError(403, "forbidden")
            body = self._body_json()
            keys = [k for k in ("accent", "secondary") if k in body]
            if not keys:
                raise ApiError(400, "bad_request")
            for k in keys:   # validate everything before saving anything
                v = body[k]
                if v is not None and not (isinstance(v, str) and ACCENT_RE.match(v)):
                    raise ApiError(400, "bad_request")
            for k in keys:
                settings_set(k, body[k].lower() if body[k] else None)
            return self._json(200, api_settings(email, prof))
        if method == "POST" and segs == ["api", "settings", "password"]:
            if not LOCAL_AUTH or email.lower() not in OWNER_EMAILS:
                raise ApiError(403, "forbidden")
            ip = self.client_address[0]
            wait = LOCAL_AUTH.retry_after(ip)
            if wait:
                raise ApiError(429, "too_many_attempts", retry=wait)
            body = self._body_json()
            cur, new = body.get("current"), body.get("new")
            if not (isinstance(cur, str) and isinstance(new, str)):
                raise ApiError(400, "bad_request")
            if not LOCAL_AUTH.check_password(cur):
                LOCAL_AUTH.record_fail(ip)
                raise ApiError(403, "wrong_password")
            try:
                LOCAL_AUTH.set_password(new)
            except ValueError:
                raise ApiError(400, "password_too_short")
            LOCAL_AUTH.clear(ip)
            secure = "; Secure" if (self.headers.get("X-Forwarded-Proto") or "").lower() == "https" else ""
            return self._json(200, {"ok": True}, {"Set-Cookie": "%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax%s" % (
                local_auth.COOKIE, LOCAL_AUTH.make_cookie(), LOCAL_AUTH.ttl, secure)})
        if method == "POST" and segs == ["api", "livetv", "stop"]:   # frees the open Jellyfin live stream
            v = self._body_json().get("liveStreamId")
            api_live_stop(self._profile(email), v if isinstance(v, str) else "")
            return self._json(200, {"ok": True})
        if method == "POST" and segs == ["api", "playstop"]:   # optional: the app frees its remote-stream lease
            if not self._is_tv:
                raise ApiError(403, "forbidden")
            psid = ""
            if int(self.headers.get("Content-Length") or 0) > 0:
                v = self._body_json().get("playSessionId")
                psid = v if isinstance(v, str) and len(v) <= 64 else ""
            if self._device and self._device.get("remote"):
                remote_stream_release(self._device["clientId"], psid or None)
            return self._json(200, {"ok": True})
        raise ApiError(404, "not_found")

    def _request(self, email):
        prof = self._profile(email)
        body = self._body_json()
        mt, tmdb, seasons = body.get("mediaType"), body.get("tmdbId"), body.get("seasons", "all")
        if mt not in ("movie", "tv") or not isinstance(tmdb, int) or isinstance(tmdb, bool) or not 0 < tmdb < 10**9:
            raise ApiError(400, "bad_request")
        if mt == "tv" and seasons != "all":
            if not isinstance(seasons, list) or not 0 < len(seasons) <= 60 or not all(
                    isinstance(n, int) and not isinstance(n, bool) and 0 < n < 200 for n in seasons):
                raise ApiError(400, "bad_request")
            seasons = sorted(set(seasons))
        wait = request_rate_limited(email)
        if wait:
            raise ApiError(429, "rate_limited", retry=wait)
        return self._json(200, api_request_title(prof, mt, tmdb, seasons))

    def _link(self, email):
        wait = link_rate_limited(email)
        if wait:
            raise ApiError(429, "rate_limited", retry=wait)
        body = self._body_json()
        prof = do_link(email, body.get("username"), body.get("password"))
        return self._json(200, public_profile(prof))

    # -- images
    def _img(self, email, item_id, typ, query):
        iid = norm_id(item_id)
        if not iid or typ not in IMG_TYPES:
            raise ApiError(404, "not_found")
        tag = re.sub(r"[^A-Za-z0-9]", "", (query.get("tag") or [""])[0])[:64] or "0"
        try:
            w = snap_width(int((query.get("w") or ["480"])[0]))
        except ValueError:
            w = 480
        # <img> tags cannot send X-MyFlix-Profile, so fall back to the first linked profile (images are not per-user).
        prof = self._profile(email, required=False)
        if not prof:
            raise ApiError(403, "profile")
        res = img_fetch(prof, iid, typ, tag, w)
        if res is None:
            return self._send(404, b"", "text/plain", {"Cache-Control": "public, max-age=3600"})
        data, ctype, immutable = res
        cc = "public, max-age=31536000, immutable" if immutable else "public, max-age=86400"
        self._send(200, data, ctype, {"Cache-Control": cc})

    # -- static
    def _static(self, rel, spa=False, versioned=False):
        base = STATIC.resolve()
        try:
            target = (base / rel).resolve()
            target.relative_to(base)
        except (ValueError, OSError):
            raise ApiError(404, "not_found")
        if ".bak" in target.name.lower() or target.name.startswith("."):   # never serve editor/backup/dotfiles
            raise ApiError(404, "not_found")
        if not target.is_file():
            if spa:
                target = base / "index.html"
                if not target.is_file():
                    return self._send(404, b"MyFlix: static/index.html missing", "text/plain")
            else:
                return self._send(404, b"Not found", "text/plain", {"Cache-Control": "no-store"})
        st = target.stat()
        is_html = target.name in ("index.html", "echo.html")   # both get /static/v<hash>/ asset URLs (Cloudflare edge-caches plain .js/.css)
        ver = asset_version() if is_html else ""
        etag = '"%x-%x%s"' % (st.st_mtime_ns, st.st_size, ver)
        # Cloudflare rewrites no-cache on .js/.css to a 4h browser TTL and edge-caches them, so
        # index.html points every asset at /static/v<hash>/… (relative module imports inherit
        # the prefix); those URLs change whenever any asset does and can be cached forever.
        cc = "public, max-age=31536000, immutable" if versioned else "no-cache"
        hdr = {"Cache-Control": cc, "ETag": etag}
        if self.headers.get("If-None-Match") == etag:
            return self._send(304, b"", "text/plain", hdr)
        ext = target.suffix.lower()
        ctype = MIME_OVERRIDES.get(ext) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        body = target.read_bytes()
        if is_html:
            body = body.replace(b'="/static/', b'="/static/' + ver.encode() + b"/")
        if self._accepts_gzip() and len(body) > 600 and any(ctype.startswith(c) for c in COMPRESSIBLE):
            ck = (str(target), st.st_mtime_ns, st.st_size, ver)
            gz = _static_gz.get(ck)
            if gz is None:
                gz = gzip.compress(body, 6)
                if len(_static_gz) > 200:
                    _static_gz.clear()
                _static_gz[ck] = gz
            return self._send(200, body, ctype, hdr, gz=gz)
        self._send(200, body, ctype, hdr, compress=False)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64
    allow_reuse_address = True


# ----------------------------------------------------------------------------- image warmer
# Jellyfin resizes an image the first time a size is asked for, which takes 5-30 s on the Pi under
# load: a cold hero backdrop on the TV sat blank for half a minute. Fetch every size the pages use
# ahead of time, one at a time, so the Pi barely notices. Re-runs pick up newly added titles.
WARM_SIZES = (("Backdrop", (320, 480, 640, 1280, 1920)), ("Logo", (240, 640, 960)), ("Primary", (240, 320)))
WARM_EVERY = 30 * 60


def _warm_once():
    with _sess_lock:
        profs = [p for e in _load_sessions().values() for p in (e.get("profiles") or []) if p.get("token")]
    seen, done, cold = set(), 0, 0
    for prof in profs:
        try:
            with open(_index_path(prof["userId"])) as f:
                items = json.load(f)
        except (OSError, ValueError):
            continue
        for it in items if isinstance(items, list) else []:
            img = it.get("img") or {}
            for typ, widths in WARM_SIZES:
                tag = img.get(typ.lower())
                if not tag or (it["id"], typ) in seen:
                    continue
                seen.add((it["id"], typ))
                for w in widths:
                    key = "%s_%s_%s_%d" % (it["id"], typ, re.sub(r"[^A-Za-z0-9]", "", tag)[:64], w)
                    if (IMG_DIR / key).exists() or (IMG_DIR / (key + ".404")).exists():
                        continue
                    t0 = time.time()
                    try:
                        img_fetch(prof, it["id"], typ, re.sub(r"[^A-Za-z0-9]", "", tag)[:64], w)
                        cold += 1
                    except Relink:
                        break
                    except Exception:
                        pass
                    done += 1
                    # Back off in proportion to how hard Jellyfin is working: an idle Pi answers in
                    # well under a second, a loaded one takes many, and then we wait longer still.
                    time.sleep(max(1.0, 3 * (time.time() - t0)))
    return done, cold


def _warmer():
    time.sleep(20)
    while True:
        t0 = time.time()
        try:
            n, _ = _warm_once()
            if n:
                sys.stderr.write("image warmer: fetched %d images in %ds\n" % (n, time.time() - t0))
        except Exception as e:
            sys.stderr.write("image warmer error: %s: %s\n" % (type(e).__name__, e))
        time.sleep(WARM_EVERY)


def main():
    if DEV and PORT == PROD_PORT:
        sys.stderr.write("refusing to start: MYFLIX_DEV=1 is not allowed on prod port %d\n" % PROD_PORT)
        sys.exit(2)
    global LOCAL_AUTH, JELLYFIN_PUBLIC, SERVER_ID
    if AUTH_MODE not in ("cloudflare", "password"):
        sys.stderr.write("refusing to start: MYFLIX_AUTH must be 'cloudflare' or 'password'\n")
        sys.exit(2)
    if AUTH_MODE == "password" and not DEV:
        # Friendly mode: one shared password; Jellyfin's public URL and server id are filled in when not given.
        pw = local_auth.load_password()
        try:
            LOCAL_AUTH = local_auth.LocalAuth(pw, DATA / "session.key", store_path=DATA / "auth.json")
        except ValueError as e:
            sys.stderr.write("refusing to start: set MYFLIX_PASSWORD (or MYFLIX_PASSWORD_FILE): %s\n" % e)
            sys.exit(2)
        OWNER_EMAILS.add(LOCAL_AUTH.email)
        JELLYFIN_PUBLIC = JELLYFIN_PUBLIC or JELLYFIN_URL
        if JELLYFIN_URL and not SERVER_ID:
            try:
                with urllib.request.urlopen(JELLYFIN_URL + "/System/Info/Public", timeout=8) as r:
                    SERVER_ID = json.loads(r.read()).get("Id", "")
            except Exception as e:
                sys.stderr.write("could not read the Jellyfin server id from %s (%s: %s)\n" % (JELLYFIN_URL, type(e).__name__, e))
    elif not DEV and not CF_ACCESS_AUD:
        sys.stderr.write("warning: CF_ACCESS_AUD unset; every request will be denied\n")
    missing = [n for n, v in (("JELLYFIN_URL", JELLYFIN_URL), ("JELLYFIN_PUBLIC", JELLYFIN_PUBLIC),
                              ("JELLYFIN_SERVER_ID", SERVER_ID)) if not v]
    if not DEV and not LOCAL_AUTH and not CF_TEAM_DOMAIN:
        missing.append("CF_TEAM_DOMAIN")
    if DEV and not JELLYFIN_URL:
        missing = ["JELLYFIN_URL"]
    if missing:
        sys.stderr.write("refusing to start: set %s (see .env.example)\n" % ", ".join(missing))
        sys.exit(2)
    DATA.mkdir(parents=True, exist_ok=True)
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    seerr_key()   # warm the Jellyseerr key from the Keychain (never logged); requests degrade to 503 without it
    srv = Server((HOST, PORT), Handler)
    if not DEV:   # dev shares the image cache; one warmer is plenty
        threading.Thread(target=_warmer, name="img-warmer", daemon=True).start()
    if not DEV:
        NETMON.start()
    if HOME_IP_AUTODETECT and not DEV:
        threading.Thread(target=_home_ip_loop, name="home-ip", daemon=True).start()
    sys.stderr.write("MyFlix listening on %s:%d%s\n" % (HOST, PORT, " (DEV: auth disabled)" if DEV else " (password sign-in)" if LOCAL_AUTH else ""))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
