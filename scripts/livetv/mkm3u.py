#!/usr/bin/env python3
import json, re, sys
ok = json.load(open(sys.argv[1])); extra = open(sys.argv[2]).read().splitlines()   # extra = old news.m3u (keeps non-US/holiday entries)
def norm(s): return re.sub(r"[^a-z0-9]", "", re.sub(r"\s*\((?:\d{3,4}p|SD|HD)\)|\[[^\]]*\]", "", s.lower()))
seen, out = set(), []
for e in ok:
    k = norm(e["name"])
    if k in seen: continue
    seen.add(k); out.append(e)
# carry over extras (Stingray holiday etc.) that the US list did not provide
for i, l in enumerate(extra):
    if l.startswith("#EXTINF") and i + 1 < len(extra):
        n = l.rsplit(",", 1)[-1].strip()
        if norm(n) not in seen:
            seen.add(norm(n)); out.append({"name": n, "id": (re.search(r'tvg-id="([^"]*)"', l) or [0, ""])[1], "logo": (re.search(r'tvg-logo="([^"]*)"', l) or [0, ""])[1],
                                           "cat": "Holiday" if re.search(r"holiday|christmas", n, re.I) else "Undefined", "url": extra[i + 1].strip()})
with open(sys.argv[3], "w") as f:
    f.write("#EXTM3U\n")
    for e in out:
        f.write('#EXTINF:-1 tvg-id="%s" tvg-logo="%s" group-title="%s",%s\n%s\n' % (e["id"], e["logo"], e["cat"], e["name"].replace(",", " "), e["url"]))
json.dump({e["name"].replace(",", " "): e["cat"] for e in out}, open(sys.argv[4], "w"))
print("channels", len(out))
