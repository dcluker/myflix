"""TV hand-off: reading what a TV is playing from Jellyfin /Sessions and the take action.
Jellyfin and the TV are faked in-process; no network, no ADB, no real key.
Run: python3 -m unittest discover -s tests -v   (from the project root)"""
import datetime
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

UID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ITEM = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def iso(ago=0):
    t = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=ago)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "5284156Z"      # Jellyfin sends 7 fractional digits


def session(dev="AFTHA004", uid=UID, client="MyFlix TV", item=ITEM, pos=19612190000, paused=True, ago=5, **item_extra):
    now = None if item is None else dict({"Id": item, "Name": "Inside Out", "Type": "Movie", "RunTimeTicks": 56918720000}, **item_extra)
    return {"Client": client, "DeviceName": dev, "UserId": uid, "NowPlayingItem": now,
            "PlayState": {"PositionTicks": pos, "IsPaused": paused}, "LastPlaybackCheckIn": iso(ago)}


class Fake:
    """Replaces Jellyfin /Sessions, the admin key, ADB, and the user-data calls for one test."""

    def __init__(self, sessions):
        self.sessions, self.adb, self.writes, self.stops_after = sessions, [], [], None
        self.orig = (server.jf_raw, server._jf_admin_key, server.adb_back, server.jf, server._fetch_one, server.time.sleep)

    def __enter__(self):
        def raw(method, path, *a, **k):
            return 200, {}, json.dumps(self.sessions).encode()

        def back(ip):
            self.adb.append(ip)
            if self.stops_after is not None and len(self.adb) >= self.stops_after:
                self.sessions = [s for s in self.sessions if s["DeviceName"] != "AFTHA004"]
            return True

        def jf(profile, method, path, params=None, body=None, **k):
            self.writes.append((path, body))
            return {}

        server.jf_raw, server._jf_admin_key, server.adb_back, server.jf = raw, lambda: "fake-key", back, jf
        server._fetch_one = lambda profile, iid: {"UserData": {"PlaybackPositionTicks": 19700000000}}
        server.time.sleep = lambda s: None
        server.HANDOFF_TV_NAMES, server.HANDOFF_TV_ADB, server.HANDOFF_DRYRUN = {"AFTHA004": "Living room"}, {"AFTHA004": "10.0.0.5"}, False
        return self

    def __exit__(self, *exc):
        (server.jf_raw, server._jf_admin_key, server.adb_back, server.jf, server._fetch_one, server.time.sleep) = self.orig
        server.HANDOFF_TV_NAMES, server.HANDOFF_TV_ADB = {}, {}


PROFILE = {"userId": UID, "token": "t"}


class HandoffTests(unittest.TestCase):
    def test_reports_the_tv_session(self):
        with Fake([session()]):
            p = server.api_handoff(PROFILE)["playing"]
        self.assertEqual((p["itemId"], p["positionMs"], p["paused"], p["tv"], p["canStop"]), (ITEM, 1961219, True, "Living room", True))

    def test_ignores_other_users_other_clients_idle_and_stale(self):
        other = [session(uid="0" * 32), session(client="MyFlix iOS"), session(item=None), session(ago=server.HANDOFF_MAX_AGE + 60)]
        with Fake(other):
            self.assertEqual(server.api_handoff(PROFILE), {"playing": None})

    def test_newest_session_wins_and_episode_fields(self):
        eps = session(dev="AFTDCT31", ago=300, Type="Episode", SeriesName="Show", ParentIndexNumber=2, IndexNumber=5)
        with Fake([eps, session(ago=10)]):
            self.assertEqual(server.api_handoff(PROFILE)["playing"]["device"], "AFTHA004")
        with Fake([eps]):
            p = server.api_handoff(PROFILE)["playing"]
        self.assertEqual((p["season"], p["episode"], p["seriesName"], p["canStop"], p["tv"]), (2, 5, "Show", False, "AFTDCT31"))

    def test_no_admin_key_means_nothing(self):
        with Fake([session()]):
            server._jf_admin_key = lambda: ""
            self.assertEqual(server.api_handoff(PROFILE), {"playing": None})

    def test_take_stops_tv_and_uses_the_position_the_tv_saved(self):
        with Fake([session()]) as f:
            f.stops_after = 2                          # first Back only hides the controls
            r = server.api_handoff_take(PROFILE, "")
        self.assertEqual(f.adb, ["10.0.0.5", "10.0.0.5"])
        self.assertEqual((r["itemId"], r["tvStopped"], r["positionMs"]), (ITEM, True, 1970000))
        self.assertEqual(f.writes, [])                 # nothing to write: the TV saved its own final position

    def test_take_when_tv_will_not_stop_writes_the_live_position(self):
        with Fake([session()]) as f:
            r = server.api_handoff_take(PROFILE, "")
        self.assertFalse(r["tvStopped"])
        self.assertEqual(len(f.adb), 3)
        self.assertEqual(f.writes[0][1], {"PlaybackPositionTicks": 19612190000})

    def test_take_dry_run_and_nothing_playing(self):
        with Fake([session()]) as f:
            server.HANDOFF_DRYRUN = True
            r = server.api_handoff_take(PROFILE, "")
            self.assertEqual((f.adb, f.writes, r["positionMs"]), ([], [], 1961219))
        with Fake([]):
            with self.assertRaises(server.ApiError):
                server.api_handoff_take(PROFILE, "")

    def test_take_respects_the_named_device(self):
        with Fake([session(), session(dev="AFTDCT31", ago=1)]) as f:
            r = server.api_handoff_take(PROFILE, "AFTHA004")
        self.assertEqual(r["tv"], "Living room")


if __name__ == "__main__":
    unittest.main()


class HomeIpTests(unittest.TestCase):
    def test_configured_v6_matches_the_whole_prefix_and_v4_exactly(self):
        old = (server.HOME_IPS, server._cfg_home)
        try:
            server.HOME_IPS = frozenset({"75.186.96.175", "2603:6013:a000:6efa::"})
            server._cfg_home = server._configured_home()
            self.assertTrue(server.is_home_ip("75.186.96.175"))
            self.assertTrue(server.is_home_ip("2603:6013:a000:6efa:d00d:ad89:56a3:acea"))
            self.assertFalse(server.is_home_ip("75.186.96.176"))
            self.assertFalse(server.is_home_ip("2606:6080:1001:10:821b:b721:a8eb:4317"))
            self.assertFalse(server.is_home_ip(""))
        finally:
            server.HOME_IPS, server._cfg_home = old
