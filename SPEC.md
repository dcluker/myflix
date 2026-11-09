# MyFlix v2 — build spec (contract for all workers)

A Netflix-style web frontend over the existing Jellyfin server. Must look **dead-on like Netflix's
web UI** (layout, spacing, motion, colors, typography feel) but with its **own wordmark "MYFLIX"** —
never Netflix's logo, name, or "N" mark. Targets: **desktop browser, mobile browser, Fire TV Stick
(Silk browser, D-pad remote)**. Library: ~472 movies, ~40 series, ~2.4k episodes.

Project root: `<project root>/`
Stdlib-only Python 3.14 backend (`/opt/homebrew/bin/python3`), vanilla-JS ES-module frontend,
**no build step, no npm, no CDN JS**. Only external asset allowed: Google Fonts (Bebas Neue for the
wordmark). Body font stack: `"Helvetica Neue", Helvetica, Arial, sans-serif`.

## Infra facts
- Jellyfin 12.1.0, LAN: `http://<jellyfin-lan-host>:8096`, serverId `<serverId>`.
  Public (Cloudflare-Access-gated) web UI: `https://jellyfin.example.com`.
- Jellyfin auth header (v12): `Authorization: MediaBrowser Client="MyFlix", Device="myflix-server",
  DeviceId="myflix-<userId>", Version="2.0", Token="<token>"` (omit Token= when logging in).
  Login: `POST /Users/AuthenticateByName {"Username","Pw"}` → `AccessToken`, `User.Id`.
- Test Jellyfin login lives in macOS Keychain: `security find-generic-password -s <keychain item> -w`
  (a test username). **Never print, log, or write the password or any token anywhere except
  `data/sessions.json`.** This is a real person's account: don't change their watched/favorite
  state except toggle-and-immediately-restore on ONE item to test the endpoint.
- The Pi running Jellyfin is thermally strained. Upstream concurrency to Jellyfin is capped
  (semaphore = 4), heavy responses are cached server-side, images are disk-cached.
- Prod: launchd, bound `127.0.0.1:8108`, reached via Cloudflare tunnel at
  `https://myflix.example.com` (Access = Google SSO only). Env vars:
  `CF_ACCESS_AUD`, `CF_TEAM_DOMAIN=<team>.cloudflareaccess.com`,
  `JELLYFIN_URL=http://<jellyfin-lan-host>:8096`, `JELLYFIN_PUBLIC=https://jellyfin.example.com`,
  `MYFLIX_PORT` (default 8108).
- **Dev mode**: `MYFLIX_DEV=1` skips the Access JWT check (email = `dev@local`). The server MUST
  refuse to start in dev mode if the port is 8108 (prod port the tunnel targets). Dev runs on
  `127.0.0.1:8118` via `./run_dev.sh`.

## Backend — `server.py` (+ existing `sso_guard.py`, don't modify it)
`ThreadingHTTPServer`. Every route except `/healthz` requires
`sso_guard.verified_email(headers, cookies, CF_TEAM_DOMAIN, CF_ACCESS_AUD)` (unless dev).
Unauthed: `/api/*` and `/img/*` → 401 JSON `{"error":"unauthorized"}`; everything else → 401 small
dark HTML page ("Access denied"). Append unauthed attempts (ts, ip from `Cf-Connecting-Ip` or peer,
UA, path) to `data/intruders.jsonl`. gzip JSON/HTML/JS/CSS when client accepts it.

**Profiles/sessions** — `data/sessions.json` (chmod 600, atomic write via tmp+rename, lock):
`{ "<email>": { "profiles": [ {"userId","name","token","imageTag"} ] } }`.
Client sends `X-MyFlix-Profile: <userId>`; server verifies it belongs to the caller's email, else
403 `{"error":"profile"}`. If Jellyfin returns 401 for a stored token → respond 401
`{"error":"relink","userId":...}`.

| Route | Behavior |
|---|---|
| `GET /healthz` | `ok` (no auth, no data) |
| `GET /api/me` | `{email, profiles:[{userId,name,imageUrl|null}], jellyfinPublic, serverId}` (no tokens!) |
| `POST /api/profiles/link` `{username,password}` | AuthenticateByName; upsert profile; return profile (no token). Rate-limit 5/min/email → 429. Wrong creds → 400 `{"error":"bad_credentials"}` |
| `DELETE /api/profiles/<userId>` | best-effort `POST /Sessions/Logout` with that token, remove |
| `GET /api/index[?refresh=1]` | compact array of ALL Movies+Series for the profile (shape `IndexItem` below). Cache per userId 10 min in memory; refresh=1 bypasses. One upstream call with `Recursive=true&IncludeItemTypes=Movie,Series&Fields=Genres,Overview,OfficialRating,CommunityRating,CriticRating,RunTimeTicks,ProductionYear,DateCreated,ChildCount,RecursiveItemCount,SortName,People,Studios,Taglines,UserData,ImageTags,BackdropImageTags&EnableImageTypes=Primary,Backdrop,Logo,Thumb` |
| `GET /api/home` | `{resume:[Ep/IndexItem], nextUp:[EpisodeItem], latest:[IndexItem]}` — resume = `/UserItems/Resume` (fallback `/Users/{id}/Items/Resume`) limit 20 (movies+episodes); nextUp = `/Shows/NextUp` limit 20; latest = `/Users/{id}/Items/Latest?Limit=40` (movies+series). Cache 60s per user |
| `GET /api/item/<id>` | `DetailItem` = IndexItem + `{tagline, cast:[{name,role}], directors:[...], studios:[...], seasons:[{id,name,index,episodeCount,unplayedCount}] (series), nextUp:EpisodeItem|null (series), similar:[IndexItem] (≤12, `/Items/{id}/Similar`)}` |
| `GET /api/season/<seriesId>/<seasonId>` | `[EpisodeItem]` via `/Shows/{seriesId}/Episodes?seasonId=...&Fields=Overview` |
| `POST /api/item/<id>/played` `{played:bool}` | Jellyfin v12 `POST`/`DELETE /UserPlayedItems/{id}?userId=` (verify live; fall back to `/Users/{u}/PlayedItems/{id}`). Invalidate that user's index/home caches. Return `{played}` |
| `POST /api/item/<id>/favorite` `{favorite:bool}` | `/UserFavoriteItems/{id}` similarly. Return `{favorite}` |
| `GET /img/<itemId>/<type>?tag=<tag>&w=<w>` | type ∈ Primary,Backdrop,Logo,Thumb; w ∈ 160,240,320,480,640,960,1280,1920 (snap up). Fetch `/Items/{id}/Images/{type}?tag=&maxWidth=w&quality=82` with profile token, disk cache `data/imgcache/<id>_<type>_<tag>_<w>`, serve with upstream content-type, `Cache-Control: public, max-age=31536000, immutable`. 404 passthrough cached as a tiny marker for 1h |
| `GET /play/<id>` | 302 → `{JELLYFIN_PUBLIC}/web/#/details?id=<id>&serverId=<serverId>` |
| `GET /static/*` | files from `static/` (no dir traversal; correct MIME; `Cache-Control: no-cache`) |
| any other GET | `static/index.html` (SPA fallback) |

**Shapes** (all compact; numbers not strings; omit nulls OK):
```
IndexItem   {id, type:"Movie"|"Series", name, sortName, year, rating /*OfficialRating e.g. PG-13*/,
             score /*CommunityRating 0-10, 1 dp*/, critic /*CriticRating 0-100*/, runtimeMin,
             genres:[..], overview /*≤400 chars*/, added /*ISO date*/, played:bool, playedPct /*0-100*/,
             favorite:bool, seasons /*series ChildCount*/, episodes /*series RecursiveItemCount*/,
             unplayed /*series UnplayedItemCount*/, people:[≤8 names, actors first], studio,
             img:{primary,backdrop,logo,thumb} /*tags*/ }
EpisodeItem {id, type:"Episode", name, seriesId, seriesName, season, episode, overview(≤300),
             runtimeMin, played, playedPct, img:{primary,thumb}, seriesImg:{backdrop,logo,primary,thumb}}
```

## Frontend — `static/`
### Files & ownership (each worker writes ONLY its own files)
- **core** worker: `index.html`, `css/base.css`, `js/app.js`, `js/api.js`, `js/store.js`,
  `js/img.js`, `js/util.js`, `js/nav.js`, and **stub** versions of every module below (exporting
  the exact signatures, rendering a placeholder) plus empty stub CSS files, so the app boots end-to-end.
- **home** worker: `js/components/rows.js`, `js/components/hovercard.js`, `js/views/home.js`,
  `css/rows.css`, `css/hovercard.css`, `css/home.css`.
- **browse** worker: `js/views/browse.js`, `js/views/search.js`, `css/browse.css`, `css/search.css`.
- **detail+tv** worker: `js/components/detail.js`, `js/views/profiles.js`, `js/components/tv.js`,
  `css/detail.css`, `css/profiles.css`, `css/tv.css`.
`index.html` links every CSS file above in that order (base first, tv last).

### Module contract (exact exports)
- `api.js`: `getMe()`, `linkProfile(username,password)`, `unlinkProfile(userId)`,
  `getIndex({refresh}={})`, `getHome()`, `getItem(id)`, `getSeason(seriesId,seasonId)`,
  `setPlayed(id,bool)`, `setFavorite(id,bool)`, `playUrl(id)` → `"/play/"+id`.
  All fetches add `X-MyFlix-Profile` from store; on `{"error":"relink"|"profile"}` → route to `#/profiles`.
- `store.js`: `get(key)`, `set(key,val)`, `on(evt,fn)` (returns unsubscribe), `emit(evt,data)`.
  Keys: `me`, `profile` ({userId,name,imageUrl}), `index` (array), `byId` (Map id→IndexItem).
  Events: `index:updated`, `item:changed` `{id, played?, favorite?}` (store updates `byId` + emits),
  `route` `{name, params}`, `modal:open`/`modal:close`.
  Selected profile persisted in `localStorage['myflix.profile']` (wrap every access in try/catch).
- `img.js`: `imgUrl(item, type, w)` → `/img/<id>/<type>?tag=<tag>&w=<w>` or `null`; for EpisodeItem
  falls back to `seriesImg` + `seriesId`. `srcset(item,type,[ws])`. Placeholder = dark gradient tile
  with the title text (never a broken-image icon).
- `util.js`: `esc(html)`, `fmtRuntime(min)` → "1h 52m", `fmtSeasons(n)` → "3 Seasons", `debounce`,
  `el(tag, attrs, ...children)`, `isTouch()`, `isTV()` (UA `/AFT|AFTS|AFTM|Silk.*TV|SmartTV|Android TV/i`
  or `?tv=1`, persisted to localStorage; `?tv=0` clears).
- `nav.js`: `renderNav(headerEl)` — Netflix top bar: MYFLIX wordmark (Bebas Neue, #E50914, left),
  links Home · Shows · Movies · New & Popular · My List · Browse, right side search icon (expands into
  input; `/` key focuses it; typing routes to `#/search?q=`), profile avatar square + caret menu
  (Switch profile → `#/profiles`). Transparent with top gradient, turns solid `#141414` after
  scrollY > 10 (transition .4s). Mobile (<740px): links collapse into a "Browse ▾" dropdown.
- Routes (hash router in `app.js`): `#/` home · `#/shows` · `#/movies` · `#/new` · `#/mylist` ·
  `#/browse?type=&genre=&decade=&rating=&runtime=&unwatched=1&sort=&letter=` ·
  `#/search?q=` · `#/title/<id>` (detail **modal over the previous view**, don't re-render the view
  underneath) · `#/profiles`. No profile selected → `#/profiles`.
- View modules export `render(container, params)` returning optional cleanup fn:
  `views/home.js` handles `home|shows|movies|new|mylist` (params.name tells which),
  `views/browse.js`, `views/search.js`, `views/profiles.js`.
- Components: `rows.js` → `renderRow(container, {title, items, variant:'poster'|'landscape'|'top10'|'continue', seeAllHref?})`
  returns the row element; every card is `<div class="card" tabindex="0" data-id="..">` (episodes also
  `data-series-id`). `hovercard.js` → `initHoverCards(rootEl)` (delegated, called once by app.js).
  `detail.js` → `openDetail(id)`, `closeDetail()`. `tv.js` → `initTV()` (called once by app.js before
  first render; no-op-ish on non-TV except arrow-key nav when the user is using the keyboard).
- Mount points in `index.html`: `<header id="nav">`, `<main id="view">`, `<div id="modal-root">`,
  `<div id="hover-root">`, `<div id="toast-root">`.

### Netflix look — design tokens (in `base.css` `:root`)
`--bg:#141414; --bg-elev:#181818; --bg-card:#2f2f2f; --text:#fff; --text-2:#e5e5e5; --muted:#a3a3a3;
--dim:#777; --red:#e50914; --red-hover:#f40612; --green:#46d369; --btn-gray:rgba(109,109,110,.7);
--radius:4px; --gutter:4%; --row-gap:3vw; --ease:cubic-bezier(.5,0,.1,1);`
Always-dark (Netflix has no light mode). Page side gutter = 4% (Netflix's `padding: 0 4%`).

Fidelity checklist (what "dead-on" means):
- **Hero/billboard**: ~56.25vw tall (cap 80vh), backdrop image cover, left-to-right black gradient
  + bottom fade into `--bg`; title logo image (fallback big bold title) at ~40% width; 3-line synopsis;
  buttons: white **▶ Play** (black text, bold) and gray translucent **ⓘ More Info**; maturity rating
  badge flush against the right edge with a left border (Netflix's age-rating tab).
- **Rows**: row title 1.4vw (min 16px) bold `--text-2`; cards are landscape 16:9 backdrop/thumb
  images (Netflix uses landscape "boxart"), 2px gap, radius 4px; desktop shows 6 cards per view
  (5 @ <1400px, 4 @ <1100px, 3 @ <800px, 2 @ <500px) with partial peek; hover-revealed side
  chevron paddles that page the row by a full viewport with smooth translate; tiny page-indicator
  bars top-right of row on hover. Mobile: native horizontal scroll-snap, portrait posters, no paddles.
- **Top 10 row**: big outlined numerals behind portrait posters (Netflix style), "Top 10 in MyFlix Today"
  — ranking = highest community score among recently added.
- **Continue Watching**: red progress bar under the card (thin, gray track).
- **Hover card** (desktop): after 400ms hover the card scales ~1.5× into a floating card over
  neighbours (edge cards anchor left/right instead of center), image on top, then a panel `--bg-elev`
  with shadow: circular buttons (▶ white filled, ＋/✓ My List, 👍-style "watched" ✓ toggle, ⌄ More Info
  on the right), then metadata line: green "★ 8.4" (or "86% Match"-style using score*10 in green),
  maturity rating box (outlined), runtime or "N Seasons", "HD" outlined badge; genres joined by " • ";
  2–3 line synopsis; series: "S2:E4 · <name>" next-up line + progress bar if in progress. Mouse-leave
  shrinks back. Never on touch devices (tap → detail modal).
- **Detail modal** ("More Info"): centered, max-width 850px, top 5vh, radius 6px, `--bg-elev`;
  hero image with bottom gradient + logo + Play/My List/Watched buttons; two-column meta (left: green
  score, year, rating box, runtime/seasons, HD, overview; right: "Cast:", "Genres:", "Studio:" in
  `--dim` labels); episodes section with season `<select>` styled like Netflix (dark, bordered), episode
  rows (number, 16:9 thumb with progress, title, runtime, synopsis); "More Like This" 3-col grid of
  cards with image, rating, year, add button, synopsis. Close ✕ top-right circle. Background dims
  `rgba(0,0,0,.7)`. Esc/Back closes.
- **Profiles**: "Who's watching?" centered, large square avatars (radius 4px) with hover white
  border, names in gray → white; "Add Profile" tile (+); "Manage Profiles" outlined button. Link form
  styled like Netflix's sign-in card (dark translucent panel, gray inputs, red full-width button).
- **Motion**: transforms only (no layout thrash), `--ease`, 300ms; respect `prefers-reduced-motion`.
- **TV (Fire Stick)**: `html.tv` → everything ~1.35× via root font-size, cards 4 per view, focused
  card = scale 1.15 + 3px white outline + shows the hover-card info panel BELOW the row (not floating),
  no hover delays, hero shows focusable Play/More Info, nav links focusable. Overscan-safe padding 5%.
- **Keyboard/D-pad spatial nav** (`tv.js`): arrows move focus to the geometrically nearest focusable
  in that direction within the active layer (`#modal-root` if open, else nav+view); up/down between
  rows remembers each row's last-focused column; left/right scrolls the row so focus stays visible;
  Enter/OK (keyCode 13/23) clicks; Back (Escape, keyCode 4, `GoBack`, `BrowserBack`, Backspace when not
  in an input) → close modal, else `history.back()`; media Play/Pause (179/85) on a focused card →
  `/play/<id>`. Focus always visible on TV; on desktop show focus ring only after keyboard use.

### Data use (all client-side over `/api/index` — it's small)
- Home rows: Continue Watching (home.resume + home.nextUp, dedup by series), My List (favorite),
  Top 10, Recently Added (by `added`), "Because you watched <X>" (genre-overlap scoring vs the most
  recent played item), genre rows (top 8 genres by count, shuffled within row), Critically Acclaimed
  (critic ≥ 80 or score ≥ 7.5), "Hidden Gems" (score ≥ 7, unplayed), "Random Picks" with 🎲 reshuffle.
  `#/shows` / `#/movies` = same layout filtered by type, hero from that type. `#/new` = latest sorted.
  `#/mylist` = grid of favorites.
- Hero pick: random item with backdrop+logo, score ≥ 6.5, prefer unplayed; stable per session.
- Search: case/diacritic-insensitive; rank exact-prefix name > word-prefix > substring > people >
  genres; show "Explore titles related to:" chips (matched genres/people → browse links).

## Verification each worker must do before returning
- Python: `python3 -m py_compile server.py`; run `MYFLIX_DEV=1 MYFLIX_PORT=8118 python3 server.py`
  briefly and curl the endpoints; kill it after (target by port, never `pkill -f server.py`).
- JS: `node --check` every file you wrote; import graph must resolve (relative `./x.js` paths with
  extensions). No frameworks.
- Don't leave background servers running. Don't touch anything outside `myflix/`.

## Requests (Jellyseerr)
Search shows a **"Not in MyFlix yet"** section under the library results (debounced ~450ms) with titles Jellyseerr
can fetch; pressing one opens a request sheet (`components/request.js`, a `.dm-layer` in `#modal-root`; tv.js
closes it via `closeRequest()` before `closeDetail()`). Server-side, all behind the usual auth + `X-MyFlix-Profile`:
- Config: `MYFLIX_SEERR_URL` (default `http://<jellyseerr-host>:5055`); API key from `MYFLIX_SEERR_KEY` or the macOS Keychain
  item `myflix-jellyseerr-api` (read at startup, never logged). No key -> 503 `seerr_unconfigured`.
  `MYFLIX_SEERR_DRYRUN=1` builds the request payload and returns `{dryRun:true,payload}` without POSTing (for tests).
- `GET /api/discover/search?q=` (2..100 chars, else 400) -> `[{tmdbId, mediaType:"movie"|"tv", title, year, overview,
  poster, backdrop, score, status:"available"|"partial"|"processing"|"pending"|"none", jellyfinId|null}]`
  (Jellyseerr `/search`, page 2 if <8 hits; cached 2 min). Client hides rows whose `jellyfinId` is already in the index.
- `GET /api/discover/tv/<tmdbId>` -> `{tmdbId, title, seasons:[{season, episodes, status}], status}` (no season 0).
- `POST /api/request {mediaType, tmdbId, seasons?:"all"|[n..]}` -> `{status, requestId, autoApproved}`. 10/min/email (429),
  400 on bad input, 409 `already_requested`, 502 `{"error":"seerr","message"}` on Jellyseerr failure.
  The profile maps to a Jellyseerr user by `jellyfinUserId` == profile userId (dash/case-insensitive), else a
  case-insensitive name match on jellyfinUsername/displayName/username (users cached 10 min). No match -> 403
  `no_seerr_user`; we never fall back to the key's own identity. The request is created with that user's `userId`, so
  Jellyseerr's own permissions decide auto-approval (nothing is force-approved).

## Fire TV app (native shell)
A native Android/Fire TV app wraps `https://myflix.example.com/?tv=1` in a WebView and plays video
with its own player (direct play from Jellyfin over the LAN).

**Identity.** The app authenticates to Cloudflare Access with a service token (client id/secret headers).
Its Access JWT has no `email`; it carries `common_name` = the client id (e.g. `<hex>.access`), `sub ""`,
`type "app"`, same `aud`/`iss` as user JWTs. `sso_guard.verified_claims()` returns the verified payload
(same fail-closed checks as `verified_email`). Resolution in `server.py`: `email` claim if present;
else `common_name` in `MYFLIX_TV_CLIENT_IDS` (comma list) and `MYFLIX_TV_EMAIL` set -> identity is
`MYFLIX_TV_EMAIL` with `is_tv=True` (so the TV uses that account's linked profiles); else the usual 401 +
intruder log. Env is written by `deploy.sh` into the launchd plist. Dev mode: header
`X-MyFlix-Dev-Identity: tv` simulates `is_tv` (identity = `MYFLIX_TV_EMAIL` if set, else `dev@local`).

**`GET /api/playinfo/<itemId>`** (needs `X-MyFlix-Profile`; TV identity only, anyone else 403
`{"error":"forbidden"}`). Movie/Episode -> that item; Series -> its next-up episode, else S1E1. Returns
`{itemId, name, seriesName?, season?, episode?, runtimeMs, startPositionMs /*0 if played or <60s*/,
jellyfinBase, userId, token /*profile's Jellyfin token*/, mediaSourceId, playSessionId, streamUrl, container,
videoCodec, audioCodec, nextEpisodeId?}`. `streamUrl` =
`<jellyfinBase>/Videos/<id>/stream?static=true&mediaSourceId=..&playSessionId=..&api_key=<token>`
(supports HEAD and Range). Media source/session come from `POST /Items/<id>/PlaybackInfo` with a
direct-play-everything DeviceProfile (transcoding off). Never cached, never logged. 404 `not_playable` if
there is nothing to play.

**Navigation.** The shell reads the profile from `localStorage['myflix.profile']`
(`{userId,name,imageUrl}`) via `evaluateJavascript`. Navigating to a URL whose path starts with
`/play/<id>` is intercepted by the shell and opens the native player (no web change). On the remote's Back
key the shell calls `window.__myflixBack()` (defined in `tv.js`): it closes the detail modal / nav menu /
search, else navigates back within the SPA when `location.hash` is not `#/`, and returns `true` if it
handled the press; it returns `false` on home with nothing open, and only then does the shell exit.

**Playback reporting** (shell -> Jellyfin directly over the LAN): header
`Authorization: MediaBrowser Client="MyFlix TV", Device="Fire TV", DeviceId="myflix-firetv", Version="2.0",
Token="<token>"`; `POST /Sessions/Playing` at start, `/Sessions/Playing/Progress` every 10 s and on
pause/seek, `/Sessions/Playing/Stopped` on stop/exit, body `{ItemId, MediaSourceId, PlaySessionId,
PositionTicks /*ms*10000*/, IsPaused, CanSeek:true, PlayMethod:"DirectPlay"}`.
