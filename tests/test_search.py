"""Title search used by the watch app: ranking and limits. The index is faked in-process.
Run: python3 -m unittest discover -s tests -v   (from the project root)"""
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


def item(i, name, typ="Movie"):
    return {"id": str(i), "type": typ, "name": name, "year": 2000, "img": {"primary": "tag"}}


NAMES = ["The Lion King", "Lion King 1½", "Kingdom of Heaven", "Lionheart", "Barry", "The King's Speech", "Sing"]


class SearchTest(unittest.TestCase):
    def setUp(self):
        self.items = [item(i, n) for i, n in enumerate(NAMES)] + [item(99, "Lion King Show", "Episode")]
        self._orig = server.get_index
        server.get_index = lambda profile: types.SimpleNamespace(items=self.items)

    def tearDown(self):
        server.get_index = self._orig

    def names(self, q, **kw):
        return [r["name"] for r in server.api_search({}, q, **kw)]

    def test_exact_beats_prefix_beats_word_beats_contains(self):
        self.assertEqual(self.names("lion king"), ["The Lion King", "Lion King 1½"])
        self.assertEqual(self.names("king")[0], "Kingdom of Heaven")      # starts with "king"
        self.assertEqual(self.names("heaven"), ["Kingdom of Heaven"])     # a word starts with it

    def test_leading_the_and_accents_and_punctuation_are_ignored(self):
        self.assertEqual(self.names("lion king")[0], "The Lion King")
        self.assertEqual(self.names("the lion king")[0], "The Lion King")
        self.assertIn("The King's Speech", self.names("kings speech"))

    def test_too_short_or_no_match_is_empty(self):
        self.assertEqual(self.names("x"), [])
        self.assertEqual(self.names("zzzz"), [])

    def test_movies_and_series_only_and_limit(self):
        self.assertNotIn("Lion King Show", self.names("lion"))
        self.assertEqual(len(self.names("i", limit=2)), 0)
        self.assertEqual(len(self.names("in", limit=2)), 2)

    def test_result_shape_is_small(self):
        r = server.api_search({}, "barry")[0]
        self.assertEqual(set(r), {"id", "type", "name", "year", "img"})


if __name__ == "__main__":
    unittest.main()
