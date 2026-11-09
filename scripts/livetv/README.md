# Live TV channel + guide scripts

Run on the host that runs Jellyfin (stdlib Python only):

1. `curl -o us_all.m3u https://iptv-org.github.io/iptv/countries/us.m3u`
2. `python3 health.py us_all.m3u ok_us.json` keeps only channels whose HLS playlist and first variant fetch.
3. `python3 mkm3u.py ok_us.json <old.m3u> out.m3u meta.json` dedupes, writes the M3U and the name -> category sidecar
   (copy `meta.json` to `data/livetv_meta.json` next to `server.py`).
4. `python3 build_guide.py out.m3u guide.xml` builds the XMLTV guide (i.mjh.nz free-streaming guides matched by name,
   "Live: <channel>" placeholders otherwise). Point Jellyfin's Live TV tuner (M3U) and listing provider (XMLTV) at the two files.

Political-lean tint and the left/center/right filter are patterns in `server.py` (`_LIVE_LEAN`).

## Keeping it healthy

The free guides only reach about 13 hours ahead, so rebuild every 4 hours (cron `10 */4 * * *`) and set Jellyfin's "Refresh Guide"
scheduled task to every 4 hours too (its default is 24).


`python3 maintain.py` does steps 1 to 4 in one go against the live files (re-checks every channel, drops dead ones, adds new
ones, rebuilds the guide). It refuses to replace anything if fewer than 80% of the current channels pass (a network outage),
and keeps the previous list as `news.m3u.prev`. Run it weekly, e.g. cron `30 4 * * 0`. Jellyfin picks the files up on its next
daily "Refresh Guide".
