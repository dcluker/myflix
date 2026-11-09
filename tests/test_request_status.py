"""refine_status: Jellyseerr 'processing' must not claim 'downloading' unless a download really exists."""
import datetime
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


def iso(hours_ago):
    d = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=hours_ago)
    return d.strftime("%Y-%m-%dT%H:%M:%S.000Z")


class RefineStatusTest(unittest.TestCase):
    def setUp(self):
        self._orig = server.qb_torrents
        self.torrents = []
        server.qb_torrents = lambda: self.torrents

    def tearDown(self):
        server.qb_torrents = self._orig

    def media(self, hours=1, **kw):
        return dict({"status": 3, "requests": [{"status": 2, "createdAt": iso(hours)}]}, **kw)

    def test_passthrough(self):
        for st in ("available", "pending", "none", "partial"):
            self.assertEqual(server.refine_status(st, self.media(), "X"), st)

    def test_arr_queue_means_downloading(self):
        m = self.media(downloadStatus=[{"size": 1}])
        self.assertEqual(server.refine_status("processing", m, "X"), "downloading")

    def test_nothing_is_searching_then_no_release(self):
        self.assertEqual(server.refine_status("processing", self.media(1), "The Brady Bunch"), "searching")
        self.assertEqual(server.refine_status("processing", self.media(30), "The Brady Bunch"), "noRelease")

    def test_manual_pack_in_qbittorrent_counts(self):
        self.torrents = [{"name": "The Brady Bunch (1969-1974) [Seasons 01-05 Complete]", "state": "downloading",
                          "progress": 0.1, "num_seeds": 2}]
        self.assertEqual(server.refine_status("processing", self.media(30), "The Brady Bunch"), "downloading")

    def test_dead_metadata_torrent_does_not_count(self):
        self.torrents = [{"name": "Arrested.Development.S05E05", "state": "metaDL", "progress": 0, "num_seeds": 0}]
        self.assertEqual(server.refine_status("processing", self.media(1), "Arrested Development"), "searching")

    def test_other_title_does_not_match(self):
        self.torrents = [{"name": "Chopped S43E04", "state": "downloading", "progress": 0.5, "num_seeds": 3}]
        self.assertEqual(server.refine_status("processing", self.media(1), "The Brady Bunch"), "searching")


if __name__ == "__main__":
    unittest.main()
