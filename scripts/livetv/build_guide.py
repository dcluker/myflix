#!/usr/bin/env python3
"""Build XMLTV guide for the Live News M3U: real programmes from i.mjh.nz FAST guides where a channel matches by name,
placeholder blocks ("Live: <channel>") otherwise. Usage: build_guide.py <news.m3u> <out.xml> [--report]"""
import gzip, io, os, re, sys, urllib.request, datetime as dt
import xml.etree.ElementTree as ET

SRC = ["https://i.mjh.nz/PlutoTV/us.xml.gz", "https://i.mjh.nz/SamsungTVPlus/us.xml.gz",
       "https://i.mjh.nz/Plex/us.xml.gz", "https://i.mjh.nz/Roku/all.xml.gz"]
SUF = re.compile(r"\s*\((?:\d{3,4}p|SD|HD)\)\s*|\s*\[[^\]]*\]\s*")

ALIAS = {"abcnewslive": "abcnewslive", "newsmaxtv": "newsmax2"}   # normalized M3U name -> normalized guide name

def norm(s):
    s = SUF.sub(" ", s or "").lower().replace("&", "and")
    return re.sub(r"[^a-z0-9]", "", s)

def fetch(u):
    req = urllib.request.Request(u, headers={"User-Agent": "livetv-guide/1"})
    return ET.parse(io.BytesIO(gzip.decompress(urllib.request.urlopen(req, timeout=60).read()))).getroot()

def read_m3u(p):
    out, L = [], open(p).read().splitlines()
    for l in L:
        if l.startswith("#EXTINF"):
            m = re.search(r'tvg-id="([^"]*)"', l)
            name = l.rsplit(",", 1)[-1].strip()
            out.append((m.group(1) if m else "", name))
    return out

def main():
    m3u, outp = sys.argv[1], sys.argv[2]
    report = "--report" in sys.argv
    mine = read_m3u(m3u)
    pool = {}   # normname -> (src_root, channel_id)
    roots = []
    for u in SRC:
        try:
            r = fetch(u)
        except Exception as e:
            print("skip", u, e, file=sys.stderr); continue
        roots.append(r)
        for c in r.findall("channel"):
            dn = c.findtext("display-name") or ""
            pool.setdefault(norm(dn), (r, c.get("id")))
    if not roots:
        print("no guide source could be read, leaving the current guide alone", file=sys.stderr)
        sys.exit(1)
    now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    horizon = now + dt.timedelta(days=3)
    tv = ET.Element("tv", {"generator-info-name": "livetv-guide"})
    matched = 0
    progs_by_src = {}
    for r in roots:
        d = {}
        for p in r.findall("programme"):
            d.setdefault(p.get("channel"), []).append(p)
        progs_by_src[id(r)] = d
    for cid, name in mine:
        cid = cid or norm(name)
        ch = ET.SubElement(tv, "channel", {"id": cid})
        ET.SubElement(ch, "display-name").text = SUF.sub("", name).strip()
        k = norm(name)
        k = "abcnewslive" if k.startswith("abcnewslive") else ALIAS.get(k, k)
        hit = pool.get(k)
        n = 0
        if hit:
            r, sid = hit
            for p in progs_by_src[id(r)].get(sid, []):
                if p.get("stop", "")[:14] > now.strftime("%Y%m%d%H%M%S"):
                    q = ET.SubElement(tv, "programme", {"start": p.get("start"), "stop": p.get("stop"), "channel": cid})
                    for tag in ("title", "sub-title", "desc", "category"):
                        v = p.findtext(tag)
                        if v: ET.SubElement(q, tag).text = v
                    n += 1
        if n:
            matched += 1
            if report: print("MATCH", name)
        else:
            if report: print("none ", name)
            t = now
            while t < horizon:
                e = t + dt.timedelta(hours=6)
                q = ET.SubElement(tv, "programme", {"start": t.strftime("%Y%m%d%H%M%S +0000"), "stop": e.strftime("%Y%m%d%H%M%S +0000"), "channel": cid})
                ET.SubElement(q, "title").text = "Live: " + SUF.sub("", name).strip()
                t = e
    tmp = outp + ".tmp"   # Jellyfin may be reading the live file
    ET.ElementTree(tv).write(tmp, encoding="utf-8", xml_declaration=True)
    os.replace(tmp, outp)
    print("channels %d matched %d placeholder %d" % (len(mine), matched, len(mine) - matched))

main()
