"""Fire TV control over ADB: state (awake, app, volume), volume, remote keys, app launch, power.

Pure standard library. All ADB access goes through one injectable `run(args, timeout)` so the logic is testable without a TV.
Everything here is allow-listed: the keys, the apps and the numeric ranges. Nothing from a request reaches a shell as text.
"""
import re
import subprocess
import time

KEYS = {
    "up": "KEYCODE_DPAD_UP", "down": "KEYCODE_DPAD_DOWN", "left": "KEYCODE_DPAD_LEFT", "right": "KEYCODE_DPAD_RIGHT",
    "ok": "KEYCODE_DPAD_CENTER", "back": "KEYCODE_BACK", "home": "KEYCODE_HOME", "menu": "KEYCODE_MENU",
    "play": "KEYCODE_MEDIA_PLAY", "pause": "KEYCODE_MEDIA_PAUSE", "play_pause": "KEYCODE_MEDIA_PLAY_PAUSE",
    "rewind": "KEYCODE_MEDIA_REWIND", "forward": "KEYCODE_MEDIA_FAST_FORWARD",
    "next": "KEYCODE_MEDIA_NEXT", "previous": "KEYCODE_MEDIA_PREVIOUS",
}
VOL_UP, VOL_DOWN, VOL_MUTE = "KEYCODE_VOLUME_UP", "KEYCODE_VOLUME_DOWN", "KEYCODE_VOLUME_MUTE"
SLEEP, WAKE = "KEYCODE_SLEEP", "KEYCODE_WAKEUP"

# id -> (label, package, activity or None). Only the ones actually installed on a TV are offered for it.
APPS = {
    "myflix": ("MyFlix", "dev.theprivatehome.myflix", ".Home"),
    "jellyfin": ("Jellyfin", "org.jellyfin.androidtv", None),
    "youtube": ("YouTube", "com.amazon.firetv.youtube", None),
    "youtube_tv": ("YouTube TV", "com.amazon.firetv.youtube.tv", None),
    "netflix": ("Netflix", "com.netflix.ninja", None),
    "plex": ("Plex", "com.plexapp.android", None),
    "hulu": ("Hulu", "com.hulu.plus", None),
    "disney": ("Disney+", "com.disney.disneyplus", None),
    "max": ("Max", "com.hbo.hbonow", None),
}
HOME_PKGS = {"com.amazon.tv.launcher": "Home"}

_FOCUS_RE = re.compile(r"u0 ([\w.]+)/([\w.$]+)")


def parse_volume(dump):
    """From `dumpsys audio`: {level, min, max, muted, device} for STREAM_MUSIC, or None."""
    m = re.search(r"^- STREAM_MUSIC:\n(.*?)(?=^- STREAM_|\Z)", dump or "", re.S | re.M)
    if not m:
        return None
    blk = m.group(1)
    g = lambda pat: (re.search(pat, blk) or [None, None])[1]
    cur = {name: int(v) for name, v in re.findall(r"\(([\w ]+)\): (\d+)", g(r"Current: (.*)") or "")}
    devs = [d.strip() for d in (g(r"Devices: (.*)") or "").split(",") if d.strip()]
    device = next((d for d in devs if d in cur), "default" if "default" in cur else None)
    if device is None:
        return None
    try:
        return {"level": cur[device], "min": int(g(r"Min: (\d+)") or 0), "max": int(g(r"Max: (\d+)") or 100),
                "muted": (g(r"Muted: (\w+)") or "false") == "true", "device": device}
    except (TypeError, ValueError):
        return None


def parse_focus(dump):
    """From `dumpsys window`: (package, activity) of the focused window, or (None, None)."""
    m = _FOCUS_RE.search(dump or "")
    return (m.group(1), m.group(2)) if m else (None, None)


def app_id_for(pkg):
    for k, (_label, p, _a) in APPS.items():
        if p == pkg:
            return k
    return None


class FireTV:
    def __init__(self, adb="adb", run=None):
        self.adb = adb
        self._run = run or self._subprocess
        self._pkgs = {}   # ip -> (ts, set of installed packages)

    @staticmethod
    def _subprocess(args, timeout):
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")

    def _adb(self, ip, *args, timeout=8):
        """-> (rc, output). rc is None when the TV cannot be reached at all."""
        addr = "%s:5555" % ip
        try:
            self._run([self.adb, "connect", addr], 6)
            return self._run([self.adb, "-s", addr, *args], timeout)
        except (OSError, subprocess.SubprocessError):
            return None, ""

    def _shell(self, ip, *args, timeout=8):
        return self._adb(ip, "shell", *args, timeout=timeout)

    # ---- state
    def installed(self, ip):
        hit = self._pkgs.get(ip)
        if hit and time.time() - hit[0] < 600:
            return hit[1]
        rc, out = self._shell(ip, "pm", "list", "packages")
        pk = {l.strip()[8:] for l in out.splitlines() if l.strip().startswith("package:")} if rc == 0 else set()
        if pk:
            self._pkgs[ip] = (time.time(), pk)
        return pk

    def state(self, ip):
        """{online, awake, app, appLabel, volume, apps} - online False when the TV does not answer."""
        rc, out = self._shell(ip, "dumpsys", "power", timeout=8)
        if rc is None or rc != 0 or "mWakefulness" not in out:
            return {"online": False}
        awake = "mWakefulness=Awake" in out
        st = {"online": True, "awake": awake}
        rc, out = self._shell(ip, "dumpsys", "window", timeout=8)
        pkg, _act = parse_focus(out) if rc == 0 else (None, None)
        st["app"] = app_id_for(pkg) or ("home" if pkg in HOME_PKGS else None)
        st["appLabel"] = (APPS[st["app"]][0] if st["app"] in APPS else HOME_PKGS.get(pkg) or pkg or None)
        rc, out = self._shell(ip, "dumpsys", "audio", timeout=8)
        vol = parse_volume(out) if rc == 0 else None
        if vol:
            st["volume"] = vol
        pk = self.installed(ip)
        st["apps"] = [{"id": k, "label": v[0]} for k, v in APPS.items() if v[1] in pk]
        return st

    # ---- actions
    def key(self, ip, name):
        code = KEYS.get(name)
        if not code:
            raise ValueError("unknown key")
        rc, _ = self._shell(ip, "input", "keyevent", code)
        return rc == 0

    def power(self, ip, on):
        rc, _ = self._shell(ip, "input", "keyevent", WAKE if on else SLEEP)
        return rc == 0

    def launch(self, ip, app):
        if app == "home":
            rc, _ = self._shell(ip, "input", "keyevent", "KEYCODE_HOME")
            return rc == 0
        if app not in APPS:
            raise ValueError("unknown app")
        _label, pkg, act = APPS[app]
        if act:
            rc, out = self._shell(ip, "am", "start", "-n", pkg + "/" + act, timeout=10)
            return rc == 0 and "Error" not in out
        rc, out = self._shell(ip, "monkey", "-p", pkg, "-c", "android.intent.category.LEANBACK_LAUNCHER", "1", timeout=10)
        if rc == 0 and "No activities found" not in out and "monkey aborted" not in out:
            return True
        rc, out = self._shell(ip, "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1", timeout=10)
        return rc == 0 and "No activities found" not in out

    def _read_volume(self, ip):
        rc, out = self._shell(ip, "dumpsys", "audio")
        return parse_volume(out) if rc == 0 else None

    def volume_step(self, ip, steps):
        """steps > 0 up, < 0 down; the key presses go in one call. Returns the new volume (or None)."""
        n = max(-30, min(30, int(steps)))
        if n == 0:
            return self._read_volume(ip)
        rc, _ = self._shell(ip, "input", "keyevent", *([VOL_UP if n > 0 else VOL_DOWN] * abs(n)))
        return self._read_volume(ip) if rc == 0 else None

    def mute(self, ip, muted=None):
        """Toggle (muted=None) or set mute. The key only toggles, so read first when a state is asked for."""
        cur = self._read_volume(ip)
        if muted is not None and cur is not None and cur["muted"] == bool(muted):
            return cur
        rc, _ = self._shell(ip, "input", "keyevent", VOL_MUTE)
        return self._read_volume(ip) if rc == 0 else None

    def volume_set(self, ip, target, max_rounds=4):
        """Absolute volume (0-100 on the stream's own scale). The remote's keys move it in steps of unknown size, so
        measure one step and then send the number of presses needed, re-reading after each round."""
        cur = self._read_volume(ip)
        if cur is None:
            return None
        target = max(cur["min"], min(cur["max"], int(target)))
        step = None
        for _ in range(max_rounds):
            diff = target - cur["level"]
            if abs(diff) <= (step or 1) // 2 or diff == 0:
                break
            if step is None:   # learn the step size from one press
                before = cur["level"]
                nxt = self.volume_step(ip, 1 if diff > 0 else -1)
                if nxt is None:
                    return None
                step = abs(nxt["level"] - before) or 1
                cur = nxt
                continue
            presses = round(diff / step)
            if presses == 0:
                break
            nxt = self.volume_step(ip, presses)
            if nxt is None:
                return None
            if nxt["level"] == cur["level"]:   # at the end of the range
                break
            cur = nxt
        return cur
