"""QA: what plays and from where. Next-up / resume walking, series -> episode resolution, auto-next,
credits timing and /api/playinfo shaping, against a faked Jellyfin (no network).

Tests marked @expectedFailure pin down a known bug found in the QA pass (2026-11-03): they FAIL today by
design and will start "unexpectedly succeeding" once the bug is fixed -- then drop the decorator.
Shapes of the fake data come from the real library (South Park / VeggieTales "Season Unknown",
Seinfeld multi-episode files, The Office S6E3 duplicate, Rick and Morty with only Season 9).

Run: python3 -m unittest discover -s tests -v   (from the project root)"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

UID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
PROFILE = {"userId": UID, "token": "tok-test"}
SID = "cccccccccccccccccccccccccccccccc"


def ep(iid, s, e, played=False, last=None, pos=0, rt=13_200_000_000, end=None, name=None, series=SID):
    ud = {"Played": played, "PlaybackPositionTicks": pos}
    if last:
        ud["LastPlayedDate"] = last
    out = {"Id": iid, "Type": "Episode", "SeriesId": series, "SeriesName": "Show", "Name": name or iid,
           "ParentIndexNumber": s, "IndexNumber": e, "RunTimeTicks": rt, "UserData": ud}
    if end is not None:
        out["IndexNumberEnd"] = end
    return out


class FakeJF:
    """Routes server.jf(profile, method, path, params, ...) to canned answers. routes: {(method, path): fn|value}."""

    def __init__(self, routes):
        self.routes, self.calls = routes, []
        self.orig = (server.jf, server.jf_raw)

    def __enter__(self):
        def jf(profile, method, path, params=None, body=None, timeout=60, ok404=False):
            self.calls.append((method, path, dict(params or {})))
            h = self.routes.get((method, path))
            if h is None:
                if ok404:
                    return None
                raise server.UpstreamError(404, path)
            return h(params or {}, body) if callable(h) else h

        def jf_raw(*a, **k):
            raise AssertionError("unexpected raw Jellyfin call")

        server.jf, server.jf_raw = jf, jf_raw
        return self

    def __exit__(self, *exc):
        server.jf, server.jf_raw = self.orig


def series_eps(eps):
    """Fake /Shows/<id>/Episodes honouring season=, seasonId= and startItemId=/Limit like Jellyfin does."""
    def h(params, _body):
        items = list(eps)
        if "season" in params:
            items = [x for x in items if x.get("ParentIndexNumber") == int(params["season"])]
        if "startItemId" in params:
            ids = [x["Id"] for x in items]
            items = items[ids.index(params["startItemId"]):] if params["startItemId"] in ids else []
        if "Limit" in params:
            items = items[:int(params["Limit"])]
        return {"Items": items}
    return h


# ------------------------------------------------------------------ _resume_after_latest

class ResumeAfterLatest(unittest.TestCase):
    def run_with(self, eps):
        with FakeJF({("GET", "/Shows/%s/Episodes" % SID): series_eps(eps)}):
            return server._resume_after_latest(PROFILE, SID)

    def test_jump_ahead_then_back_fills_gap(self):
        # South Park case: watched S29E2 last, older seasons unwatched -> the latest has S29E3 after it.
        eps = [ep("a", 1, 1, True, "2026-01-01"), ep("b", 1, 2), ep("c", 29, 1), ep("d", 29, 2, True, "2026-10-01"), ep("e", 29, 3)]
        self.assertEqual(self.run_with(eps)["Id"], "e")

    def test_latest_is_series_finale_walks_back_to_older_gap(self):
        # King of the Hill case: S15 all watched (latest), S14E7.. unwatched -> S14E7.
        eps = [ep("k1", 14, 6, True, "2026-01-01"), ep("k2", 14, 7), ep("k3", 15, 1, True, "2026-02-01"),
               ep("k4", 15, 2, True, "2026-02-02")]
        self.assertEqual(self.run_with(eps)["Id"], "k2")

    def test_season_finale_goes_to_next_season_premiere(self):
        eps = [ep("a", 1, 9, True, "2026-03-01"), ep("b", 1, 10, True, "2026-03-02"), ep("c", 2, 1)]
        self.assertEqual(self.run_with(eps)["Id"], "c")

    def test_everything_watched_is_none(self):
        eps = [ep("a", 1, 1, True, "2026-03-01"), ep("b", 1, 2, True, "2026-03-02")]
        self.assertIsNone(self.run_with(eps))

    def test_nothing_watched_is_none(self):
        self.assertIsNone(self.run_with([ep("a", 1, 1), ep("b", 1, 2)]))

    def test_specials_and_unknown_season_never_chosen(self):
        eps = [ep("sp", 0, 1), ep("a", 1, 1, True, "2026-03-01"), ep("unk", None, None)]
        self.assertIsNone(self.run_with(eps))

    def test_unsorted_upstream_is_sorted_by_season_then_episode(self):
        eps = [ep("c", 2, 1), ep("b", 1, 10, True, "2026-03-02"), ep("a", 1, 9, True, "2026-03-01")]
        self.assertEqual(self.run_with(eps)["Id"], "c")

    def test_multi_episode_file_counts_as_one_step(self):
        # Seinfeld S3E17-E18 watched -> next is S3E19.
        eps = [ep("m", 3, 17, True, "2026-03-01", end=18), ep("n", 3, 19)]
        self.assertEqual(self.run_with(eps)["Id"], "n")


# ------------------------------------------------------------------ _resolve_playable (series -> episode)

class ResolvePlayable(unittest.TestCase):
    def routes(self, kind="Series", nextup=None, eps=()):
        return {
            ("GET", "/Items"): {"Items": [{"Id": SID, "Type": kind, "Name": "Show"}]},
            ("GET", "/Shows/NextUp"): {"Items": [nextup] if nextup else []},
            ("GET", "/Shows/%s/Episodes" % SID): series_eps(list(eps)),
            ("GET", "/Shows/%s/Seasons" % SID): {"Items": [{"IndexNumber": n} for n in
                                                           sorted({e.get("ParentIndexNumber") for e in eps}, key=lambda n: (n is None, n or 0))]},
        }

    def test_movie_and_episode_pass_through(self):
        for kind in ("Movie", "Episode"):
            with FakeJF(self.routes(kind)):
                self.assertEqual(server._resolve_playable(PROFILE, SID)["Type"], kind)

    def test_season_or_boxset_id_not_playable(self):
        for kind in ("Season", "BoxSet", "Folder"):
            with FakeJF(self.routes(kind)):
                with self.assertRaises(server.ApiError) as cm:
                    server._resolve_playable(PROFILE, SID)
                self.assertEqual(cm.exception.status, 404)

    def test_series_uses_nextup(self):
        with FakeJF(self.routes(nextup=ep("n", 4, 1))):
            self.assertEqual(server._resolve_playable(PROFILE, SID)["Id"], "n")

    def test_fully_watched_series_restarts_at_s1e1(self):
        eps = [ep("sp", 0, 1, True, "2026-01-01"), ep("a", 1, 1, True, "2026-01-02"), ep("b", 1, 2, True, "2026-01-03")]
        with FakeJF(self.routes(eps=eps)):
            self.assertEqual(server._resolve_playable(PROFILE, SID)["Id"], "a")

    def test_no_season_one_picks_earliest_regular_season_not_specials(self):
        # Rick and Morty (only S9) / King of the Hill (S14, S15): season=1 is empty.
        eps = [ep("sp", 0, 1), ep("unk", None, None), ep("k15", 15, 1), ep("k14", 14, 1)]
        with FakeJF(self.routes(eps=eps)):
            self.assertEqual(server._resolve_playable(PROFILE, SID)["Id"], "k14")

    def test_only_unknown_season_still_plays(self):
        # The Ren & Stimpy Show: every file sits in "Season Unknown".
        eps = [ep("r1", None, None), ep("r2", None, None)]
        with FakeJF(self.routes(eps=eps)):
            self.assertEqual(server._resolve_playable(PROFILE, SID)["Id"], "r1")

    def test_series_without_episodes_is_404(self):
        with FakeJF(self.routes(eps=[])):
            with self.assertRaises(server.ApiError):
                server._resolve_playable(PROFILE, SID)

    # fixed 2026-11-03 (was @unittest.expectedFailure)
    def test_bug_nextup_unknown_season_extra_beats_s1e1(self):
        # Real data: Jellyfin NextUp for a new viewer of VeggieTales returns "Ultimate Silly Songs" (Season Unknown),
        # for South Park "XM South Park Movie Bigger Longer And Uncut", instead of S1E1. MyFlix plays it as-is.
        eps = [ep("s1e1", 1, 1), ep("s1e2", 1, 2), ep("xm", None, None, name="XM South Park Movie")]
        with FakeJF(self.routes(nextup=eps[2], eps=eps)):
            self.assertEqual(server._resolve_playable(PROFILE, SID)["Id"], "s1e1")


# ------------------------------------------------------------------ _next_episode_id (auto-next)

class NextEpisode(unittest.TestCase):
    def nxt(self, eps, cur):
        with FakeJF({("GET", "/Shows/%s/Episodes" % SID): series_eps(eps)}):
            return server._next_episode_id(PROFILE, cur)

    def test_mid_season(self):
        eps = [ep("a", 1, 1), ep("b", 1, 2)]
        self.assertEqual(self.nxt(eps, eps[0]), "b")

    def test_season_finale_to_next_premiere(self):
        eps = [ep("a", 1, 13), ep("b", 2, 1)]
        self.assertEqual(self.nxt(eps, eps[0]), "b")

    def test_series_finale_has_no_next(self):
        eps = [ep("a", 9, 22), ep("b", 9, 23)]
        self.assertIsNone(self.nxt(eps, eps[1]))

    def test_no_series_id(self):
        self.assertIsNone(server._next_episode_id(PROFILE, {"Id": "x"}))

    def test_upstream_error_is_none(self):
        with FakeJF({}):
            self.assertIsNone(server._next_episode_id(PROFILE, ep("a", 1, 1)))

    # fixed 2026-11-03 (was @unittest.expectedFailure)
    def test_bug_series_finale_autoplays_unknown_season_extra(self):
        # Real data: Jellyfin orders "Season Unknown" last, so South Park S29E4 -> "XM South Park Movie",
        # VeggieTales S20E14 -> "Ultimate Silly Songs" auto-play after the finale.
        eps = [ep("fin", 29, 4), ep("xm", None, None)]
        self.assertIsNone(self.nxt(eps, eps[0]))

    # fixed 2026-11-03 (was @unittest.expectedFailure)
    def test_bug_duplicate_episode_number_autoplays_same_episode(self):
        # Real data: The Office S6E3 x2, That '70s Show S6E5 x2, Rugrats S8E3-E4 -> S8E3, Goosebumps S2E20-E21 -> S2E21.
        eps = [ep("p1", 6, 3), ep("p2", 6, 3), ep("p4", 6, 4)]
        self.assertEqual(self.nxt(eps, eps[0]), "p4")

    # fixed 2026-11-03 (was @unittest.expectedFailure)
    def test_bug_multi_episode_file_then_covered_episode(self):
        eps = [ep("m", 8, 3, end=4), ep("dup", 8, 3), ep("n", 8, 5)]
        self.assertEqual(self.nxt(eps, eps[0]), "n")


# ------------------------------------------------------------------ _credits_start

class CreditsStart(unittest.TestCase):
    def cs(self, runtime_ms, segments=None, chapters=None):
        routes = {
            ("GET", "/MediaSegments/x"): {"Items": segments or []},
            ("GET", "/Items/x"): {"Chapters": chapters or []},
        }
        with FakeJF(routes):
            return server._credits_start(PROFILE, {"Id": "x"}, runtime_ms)

    def test_short_episode_estimate_30s(self):
        self.assertEqual(self.cs(22 * 60000), (22 * 60000 - 30000, "estimate"))

    def test_long_episode_estimate_60s(self):
        self.assertEqual(self.cs(44 * 60000), (44 * 60000 - 60000, "estimate"))

    def test_under_five_minutes_no_credits(self):
        self.assertEqual(self.cs(4 * 60000), (None, None))

    def test_no_runtime_no_credits(self):
        # Black Box S1E6/E7 and The Beverly Hillbillies S7E3 have no RunTimeTicks.
        self.assertEqual(self.cs(0), (None, None))

    def test_segment_wins(self):
        self.assertEqual(self.cs(22 * 60000, segments=[{"Type": "Outro", "StartTicks": 1_260_000_000}]), (126000, "segment"))

    def test_segment_past_end_ignored(self):
        self.assertEqual(self.cs(60000 * 22, segments=[{"Type": "Outro", "StartTicks": 99 * 60000 * 10000}])[1], "estimate")

    def test_credits_chapter_only_in_back_half(self):
        ch = [{"Name": "Credits", "StartPositionTicks": 60000 * 10000}, {"Name": "End Credits", "StartPositionTicks": 20 * 60000 * 10000}]
        self.assertEqual(self.cs(22 * 60000, chapters=ch), (20 * 60000, "chapter"))


# ------------------------------------------------------------------ api_playinfo

def source(sid="ms1", bitrate=5_000_000, size=None, audio=(("aac", True),)):
    streams = [{"Type": "Video", "Codec": "h264"}] + [{"Type": "Audio", "Codec": c, "IsDefault": d} for c, d in audio]
    s = {"Id": sid, "Container": "mkv", "Bitrate": bitrate, "MediaStreams": streams}
    if size:
        s["Size"] = size
    return s


class PlayInfo(unittest.TestCase):
    def setUp(self):
        self.saved = (server.JELLYFIN_URL, server.JELLYFIN_PUBLIC, server.SERVER_ID)
        server.JELLYFIN_URL, server.JELLYFIN_PUBLIC, server.SERVER_ID = "http://192.168.1.10:8096", "https://jf.example.dev", "srv"
        server._streams.clear()

    def tearDown(self):
        server.JELLYFIN_URL, server.JELLYFIN_PUBLIC, server.SERVER_ID = self.saved
        server._streams.clear()

    def play(self, item, sources=None, device=None, eps=None, err=None):
        pb = {"MediaSources": [source()] if sources is None else sources, "PlaySessionId": "ps1"}
        if err:
            pb["ErrorCode"] = err
        routes = {
            ("GET", "/Items"): {"Items": [item]},
            ("POST", "/Items/%s/PlaybackInfo" % item["Id"]): pb,
            ("GET", "/Shows/%s/Episodes" % SID): series_eps(eps or [item]),
            ("GET", "/MediaSegments/%s" % item["Id"]): {"Items": []},
            ("GET", "/Items/%s" % item["Id"]): {"Chapters": []},
        }
        with FakeJF(routes):
            return server.api_playinfo(PROFILE, item["Id"], device)

    def movie(self, pos=0, played=False, rt=72_000_000_000):
        return {"Id": "mov", "Type": "Movie", "Name": "Film", "RunTimeTicks": rt,
                "UserData": {"PlaybackPositionTicks": pos, "Played": played}}

    def test_lan_device_gets_lan_stream_and_both_bases(self):
        out = self.play(self.movie())
        self.assertTrue(out["streamUrl"].startswith("http://192.168.1.10:8096/Videos/mov/stream?static=true"))
        self.assertEqual((out["lanBase"], out["publicBase"], out["serverId"]), ("http://192.168.1.10:8096", "https://jf.example.dev", "srv"))
        self.assertNotIn("api_key", out["streamPath"])
        self.assertIn("mediaSourceId=ms1", out["streamPath"])
        self.assertIn("playSessionId=ps1", out["streamPath"])
        self.assertNotIn("nextEpisodeId", out)

    def test_remote_device_never_gets_lan_url_in_stream(self):
        out = self.play(self.movie(), device={"clientId": "c1", "remote": True})
        self.assertTrue(out["streamUrl"].startswith("https://jf.example.dev/"))
        self.assertEqual(out["jellyfinBase"], "https://jf.example.dev")
        self.assertIn("c1", server._streams)

    def test_resume_under_a_minute_starts_at_zero(self):
        self.assertEqual(self.play(self.movie(pos=59 * 10_000_000))["startPositionMs"], 0)

    def test_resume_position_kept(self):
        self.assertEqual(self.play(self.movie(pos=600 * 10_000_000))["startPositionMs"], 600_000)

    def test_rewatch_of_played_title_still_resumes(self):
        self.assertEqual(self.play(self.movie(pos=600 * 10_000_000, played=True))["startPositionMs"], 600_000)

    # fixed 2026-11-03 (was @unittest.expectedFailure)
    def test_bug_resume_past_95pct_should_start_over(self):
        # The UI (detail.js pctLeft) shows "Play" (not "Resume") and hides Start Over at >=95%,
        # but the server still hands the player the saved position, so it opens on the credits / ends at once.
        rt = 72_000_000_000
        self.assertEqual(self.play(self.movie(pos=int(rt * 0.97), rt=rt))["startPositionMs"], 0)

    def test_no_media_sources_is_404(self):
        with self.assertRaises(server.ApiError):
            self.play(self.movie(), sources=[])

    def test_playbackinfo_error_code_is_404(self):
        with self.assertRaises(server.ApiError):
            self.play(self.movie(), err="NoCompatibleStream")

    def test_multi_version_plays_first_source(self):
        # Animaniacs: two different shows merged as versions; the TV always gets MediaSources[0].
        out = self.play(self.movie(), sources=[source("v2020"), source("v1993")])
        self.assertEqual(out["mediaSourceId"], "v2020")

    def test_default_audio_codec_reported(self):
        out = self.play(self.movie(), sources=[source(audio=(("ac3", False), ("eac3", True)))])
        self.assertEqual(out["audioCodec"], "eac3")
        out = self.play(self.movie(), sources=[source(audio=(("ac3", False), ("eac3", False)))])
        self.assertEqual(out["audioCodec"], "ac3")

    def test_remote_too_high_bitrate(self):
        with self.assertRaises(server.ApiError):
            self.play(self.movie(), sources=[source(bitrate=80_000_000)], device={"clientId": "c2", "remote": True})

    def test_series_plays_nextup_with_next_and_credits(self):
        e1, e2 = ep("e1", 1, 1, rt=22 * 60 * 10_000_000), ep("e2", 1, 2)
        series = {"Id": SID, "Type": "Series", "Name": "Show"}
        routes = {
            ("GET", "/Items"): lambda p, b: {"Items": [series if p.get("Ids") == SID else e1]},
            ("GET", "/Shows/NextUp"): {"Items": [e1]},
            ("POST", "/Items/e1/PlaybackInfo"): {"MediaSources": [source()], "PlaySessionId": "ps"},
            ("GET", "/Shows/%s/Episodes" % SID): series_eps([e1, e2]),
            ("GET", "/MediaSegments/e1"): {"Items": []},
            ("GET", "/Items/e1"): {"Chapters": []},
        }
        with FakeJF(routes):
            out = server.api_playinfo(PROFILE, SID, None)
        self.assertEqual((out["itemId"], out["season"], out["episode"], out["nextEpisodeId"]), ("e1", 1, 1, "e2"))
        self.assertEqual((out["creditsStartMs"], out["creditsSource"]), (22 * 60000 - 30000, "estimate"))
        self.assertEqual(out["logoItemId"], SID)

    def test_last_episode_has_no_next_or_credits(self):
        e = ep("fin", 9, 23)
        out = self.play(e, eps=[ep("a", 9, 22), e])
        self.assertNotIn("nextEpisodeId", out)
        self.assertNotIn("creditsStartMs", out)


# ------------------------------------------------------------------ shaping

class Shaping(unittest.TestCase):
    def test_pct(self):
        self.assertEqual(server._pct({"PlayedPercentage": 42.4}, 100), 42)
        self.assertEqual(server._pct({"PlaybackPositionTicks": 50}, 200), 25)
        self.assertEqual(server._pct({"Played": True}, 0), 100)
        self.assertEqual(server._pct({}, 0), 0)
        self.assertEqual(server._pct({"PlayedPercentage": 140}, 1), 100)

    def test_episode_item_unknown_season_prunes_numbers(self):
        out = server.episode_item(ep("x", None, None))
        self.assertNotIn("season", out)
        self.assertNotIn("episode", out)

    # fixed 2026-11-03 (was @unittest.expectedFailure)
    def test_bug_episode_item_drops_index_number_end(self):
        # Seinfeld S3E17-E18 shows as "S3:E17" in the Play label and as "17" in the episode list.
        self.assertEqual(server.episode_item(ep("m", 3, 17, end=18)).get("episodeEnd"), 18)


if __name__ == "__main__":
    unittest.main()
