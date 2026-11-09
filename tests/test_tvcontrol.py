"""Fire TV control: parsing real `dumpsys` output, allow-lists, and the volume-set loop, with a fake ADB.
Run: python3 -m unittest discover -s tests -v   (from the project root)"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tvcontrol  # noqa: E402

AUDIO = """Stream volumes (device: index)
- STREAM_VOICE_CALL:
   Muted: false
   Min: 1
   Max: 100
   Current: 2 (speaker): 50, 40000000 (default): 50
   Devices: speaker
- STREAM_MUSIC:
   Muted: false
   Min: 0
   Max: 100
   Current: 2 (speaker): 17, 4 (headset): 10, 8 (headphone): 10, 80 (bt_a2dp): 72, 40000000 (default): 25
   Devices: speaker
- STREAM_ALARM:
   Muted: false
   Min: 0
   Max: 100
   Current: 2 (speaker): 99, 40000000 (default): 99
   Devices: speaker
"""


class ParseTest(unittest.TestCase):
    def test_volume_uses_the_active_device_of_the_music_stream(self):
        v = tvcontrol.parse_volume(AUDIO)
        self.assertEqual(v, {"level": 17, "min": 0, "max": 100, "muted": False, "device": "speaker"})

    def test_muted_and_default_device_fallback(self):
        d = AUDIO.replace("Muted: false\n   Min: 0\n   Max: 100\n   Current: 2 (speaker): 17", "Muted: true\n   Min: 0\n   Max: 100\n   Current: 2 (speaker): 17", 1)
        self.assertTrue(tvcontrol.parse_volume(d)["muted"])
        d2 = AUDIO.replace("Devices: speaker\n- STREAM_ALARM", "Devices: hdmi\n- STREAM_ALARM", 1)
        self.assertEqual(tvcontrol.parse_volume(d2)["device"], "default")
        self.assertEqual(tvcontrol.parse_volume(d2)["level"], 25)

    def test_garbage_gives_none(self):
        for bad in ("", None, "nothing here", "- STREAM_MUSIC:\n   Muted: false\n"):
            self.assertIsNone(tvcontrol.parse_volume(bad))

    def test_focus(self):
        self.assertEqual(tvcontrol.parse_focus("  mCurrentFocus=Window{8e38ec u0 com.plexapp.android/tv.plex.app.MainActivity}"),
                         ("com.plexapp.android", "tv.plex.app.MainActivity"))
        self.assertEqual(tvcontrol.parse_focus("mCurrentFocus=null"), (None, None))


class FakeTV:
    """A pretend Fire TV: answers dumpsys, counts volume key presses, steps volume by 5."""
    def __init__(self, level=20, step=5, awake=True, up=True, packages=("dev.theprivatehome.myflix", "com.plexapp.android")):
        self.level, self.step, self.awake, self.up, self.muted = level, step, awake, up, False
        self.packages = packages
        self.calls = []

    def run(self, args, timeout):
        self.calls.append(args)
        if not self.up:
            raise OSError("unreachable")
        if "connect" in args:
            return 0, "connected"
        sh = args[args.index("shell") + 1:]
        if sh[:2] == ["dumpsys", "power"]:
            return 0, "mWakefulness=%s\n" % ("Awake" if self.awake else "Asleep")
        if sh[:2] == ["dumpsys", "window"]:
            return 0, "  mCurrentFocus=Window{1 u0 com.plexapp.android/tv.plex.app.MainActivity}\n"
        if sh[:2] == ["dumpsys", "audio"]:
            return 0, AUDIO.replace("(speaker): 17", "(speaker): %d" % self.level).replace(
                "Muted: false\n   Min: 0\n   Max: 100\n   Current: 2 (speaker): %d" % self.level,
                "Muted: %s\n   Min: 0\n   Max: 100\n   Current: 2 (speaker): %d" % ("true" if self.muted else "false", self.level), 1)
        if sh[:3] == ["pm", "list", "packages"]:
            return 0, "".join("package:%s\n" % p for p in self.packages)
        if sh[:2] == ["input", "keyevent"]:
            for code in sh[2:]:
                if code == tvcontrol.VOL_UP:
                    self.level = min(100, self.level + self.step)
                elif code == tvcontrol.VOL_DOWN:
                    self.level = max(0, self.level - self.step)
                elif code == tvcontrol.VOL_MUTE:
                    self.muted = not self.muted
            return 0, ""
        if sh[0] == "monkey":
            return 0, "Events injected: 1"
        if sh[0] == "am":
            return 0, "Starting: Intent"
        return 1, "unknown"

    def keys(self):
        return [a[a.index("keyevent") + 1:] for a in self.calls if "keyevent" in a]


class ControlTest(unittest.TestCase):
    def tv(self, **kw):
        self.fake = FakeTV(**kw)
        return tvcontrol.FireTV("adb", run=self.fake.run)

    def test_state(self):
        st = self.tv().state("1.2.3.4")
        self.assertTrue(st["online"] and st["awake"])
        self.assertEqual(st["app"], "plex")
        self.assertEqual(st["volume"]["level"], 20)
        self.assertEqual([a["id"] for a in st["apps"]], ["myflix", "plex"])   # only what is installed

    def test_unreachable_is_offline_not_an_error(self):
        self.assertEqual(self.tv(up=False).state("1.2.3.4"), {"online": False})

    def test_keys_are_allow_listed(self):
        t = self.tv()
        self.assertTrue(t.key("1.2.3.4", "home"))
        with self.assertRaises(ValueError):
            t.key("1.2.3.4", "rm -rf /")
        with self.assertRaises(ValueError):
            t.key("1.2.3.4", "KEYCODE_POWER")

    def test_apps_are_allow_listed(self):
        t = self.tv()
        self.assertTrue(t.launch("1.2.3.4", "myflix"))
        self.assertTrue(t.launch("1.2.3.4", "plex"))
        with self.assertRaises(ValueError):
            t.launch("1.2.3.4", "com.evil.app")
        self.assertNotIn("com.evil.app", " ".join(" ".join(c) for c in self.fake.calls))

    def test_volume_set_learns_the_step_and_lands_on_target(self):
        t = self.tv(level=20, step=5)
        self.assertEqual(t.volume_set("1.2.3.4", 60)["level"], 60)
        t = self.tv(level=80, step=4)
        self.assertEqual(t.volume_set("1.2.3.4", 40)["level"], 40)
        t = self.tv(level=50, step=5)
        self.assertEqual(t.volume_set("1.2.3.4", 52)["level"], 50)     # within half a step: leave it

    def test_volume_set_clamps_and_stops_at_the_end_of_the_range(self):
        t = self.tv(level=90, step=5)
        self.assertEqual(t.volume_set("1.2.3.4", 500)["level"], 100)
        self.assertLessEqual(len([k for k in self.fake.keys() if k and k[0] == tvcontrol.VOL_UP]), 8)

    def test_step_is_capped(self):
        t = self.tv(level=10, step=1)
        t.volume_step("1.2.3.4", 999)
        self.assertEqual(self.fake.level, 40)    # at most 30 presses per call

    def test_mute_toggle_and_set(self):
        t = self.tv()
        self.assertTrue(t.mute("1.2.3.4")["muted"])
        self.assertTrue(t.mute("1.2.3.4", muted=True)["muted"])        # already muted: no extra toggle
        self.assertEqual([k for k in self.fake.keys() if k == [tvcontrol.VOL_MUTE]].__len__(), 1)
        self.assertFalse(t.mute("1.2.3.4", muted=False)["muted"])

    def test_power(self):
        t = self.tv()
        t.power("1.2.3.4", False)
        t.power("1.2.3.4", True)
        self.assertEqual(self.fake.keys()[-2:], [[tvcontrol.SLEEP], [tvcontrol.WAKE]])


if __name__ == "__main__":
    unittest.main()
