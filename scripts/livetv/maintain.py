#!/usr/bin/env python3
"""Weekly Live TV upkeep: re-check every channel, drop the dead ones, pick up new ones, rebuild the guide.

Usage: maintain.py [--dir <jellyfin livetv dir>] [--meta <data/livetv_meta.json>]
Safe by design: the live files are only replaced when the new list keeps at least 80% of the current channels
(a network outage must not wipe the guide), and the previous M3U is kept as news.m3u.prev.
"""
import argparse, json, os, re, shutil, subprocess, sys, time, urllib.request
import concurrent.futures as cf
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from health import check, parse  # noqa: E402

SOURCE = "https://iptv-org.github.io/iptv/countries/us.m3u"


def norm(s):
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\s*\((?:\d{3,4}p|SD|HD)\)|\[[^\]]*\]", "", (s or "").lower()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(Path.home() / "jf/config/livetv"))
    ap.add_argument("--meta", default=str(Path.home() / "myflix/data/livetv_meta.json"))
    a = ap.parse_args()
    d = Path(a.dir)
    cur_m3u = d / "news.m3u"
    work = HERE / "work"
    work.mkdir(exist_ok=True)
    log = lambda *x: print(time.strftime("%Y-%m-%d %H:%M:%S"), *x, flush=True)

    req = urllib.request.Request(SOURCE, headers={"User-Agent": "livetv-maintain/1"})
    try:
        (work / "us_all.m3u").write_bytes(urllib.request.urlopen(req, timeout=60).read())
    except Exception as e:
        log("could not download the channel list, leaving everything as is:", e)
        return 1
    src = parse(str(work / "us_all.m3u"))
    old = parse(str(cur_m3u)) if cur_m3u.exists() else []
    src_names = {norm(e["name"]) for e in src}
    extras = [e for e in old if norm(e["name"]) not in src_names]   # channels from other lists (e.g. holiday): re-checked too
    cands = src + extras
    log("checking %d channels (%d from the list, %d carried over)" % (len(cands), len(src), len(extras)))
    with cf.ThreadPoolExecutor(40) as ex:
        res = list(ex.map(check, cands))
    seen, ok = set(), []
    for e, good in res:
        k = norm(e["name"])
        if good and k not in seen:
            seen.add(k)
            ok.append(e)
    if old and len(ok) < 0.8 * len(old):
        log("only %d of %d channels passed (<80%%): looks like a network problem, leaving everything as is" % (len(ok), len(old)))
        return 1

    new_m3u = work / "news.m3u.new"
    with open(new_m3u, "w") as f:
        f.write("#EXTM3U\n")
        for e in ok:
            f.write('#EXTINF:-1 tvg-id="%s" tvg-logo="%s" group-title="%s",%s\n%s\n' % (
                e["id"], e["logo"], e["cat"], e["name"].replace(",", " "), e["url"]))
    meta = work / "meta.json.new"
    meta.write_text(json.dumps({e["name"].replace(",", " "): e["cat"] for e in ok}))
    guide = work / "guide.xml.new"
    subprocess.run([sys.executable, str(HERE / "build_guide.py"), str(new_m3u), str(guide)], check=True)

    old_names = {norm(e["name"]) for e in old}
    new_names = {norm(e["name"]) for e in ok}
    dropped = sorted(e["name"] for e in old if norm(e["name"]) not in new_names)
    added = sorted(e["name"] for e in ok if norm(e["name"]) not in old_names)
    if cur_m3u.exists():
        shutil.copy2(cur_m3u, d / "news.m3u.prev")
    for tmp, dest in ((new_m3u, cur_m3u), (guide, d / "guide.xml"), (meta, Path(a.meta))):
        os.replace(tmp, dest)
    log("now %d channels. dropped %d: %s" % (len(ok), len(dropped), ", ".join(dropped[:40]) or "-"))
    log("added %d: %s" % (len(added), ", ".join(added[:40]) or "-"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
