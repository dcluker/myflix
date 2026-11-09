#!/usr/bin/env python3
"""Keep only channels that really stream: fetch the playlist, then one level deeper (first variant / first segment)."""
import json, re, sys, urllib.request, urllib.parse, concurrent.futures as cf

UA = {"User-Agent": "Mozilla/5.0 (Linux; Android 9) AppleWebKit/537.36 Chrome/138 Safari/537.36"}

def get(url, n=200000, t=8):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=t) as r:
        return r.status, r.geturl(), r.read(n)

def check(e):
    url = e["url"]
    try:
        st, final, body = get(url)
        txt = body.decode("utf-8", "ignore")
        if not txt.lstrip().startswith("#EXTM3U"):
            return e, False   # not an HLS playlist (could be a raw stream; skip, ExoPlayer direct path needs HLS)
        lines = [l.strip() for l in txt.splitlines() if l.strip() and not l.startswith("#")]
        if not lines:
            return e, False
        sub = urllib.parse.urljoin(final, lines[0])
        st2, final2, body2 = get(sub, 4096 if "#EXT-X-STREAM-INF" not in txt else 200000)
        if "#EXT-X-STREAM-INF" in txt:   # master -> media playlist must itself list segments
            t2 = body2.decode("utf-8", "ignore")
            segs = [l for l in t2.splitlines() if l.strip() and not l.startswith("#")]
            return e, bool(segs)
        return e, st2 == 200
    except Exception:
        return e, False

def parse(path):
    L = open(path).read().splitlines(); out = []
    for i, l in enumerate(L):
        if not l.startswith("#EXTINF"): continue
        j = i + 1
        while j < len(L) and L[j].startswith("#"): j += 1
        if j >= len(L): continue
        g = lambda k: (re.search(k + r'="([^"]*)"', l) or [None, ""])[1]
        name = l.rsplit(",", 1)[-1].strip()
        out.append({"name": name, "id": g("tvg-id"), "logo": g("tvg-logo"), "cat": g("group-title").split(";")[0] or "Undefined", "url": L[j].strip()})
    return out

if __name__ == "__main__":
    ents = parse(sys.argv[1])
    with cf.ThreadPoolExecutor(40) as ex:
        res = list(ex.map(check, ents))
    ok = [e for e, good in res if good]
    json.dump(ok, open(sys.argv[2], "w"))
    print("checked %d ok %d" % (len(ents), len(ok)))
