# MyFlix

A Netflix-style front end for a personal Jellyfin server, plus a native Android TV / Fire TV app that plays
video directly (no browser streaming). The web UI and API are a single Python file with no dependencies
beyond the standard library; the TV app is Kotlin + ExoPlayer.

Designed to sit behind Cloudflare Access: people sign in through your identity provider, and each TV pairs
once with a short code that gives it its own revocable Cloudflare Access service token.

## Quick start (about 5 minutes)

You need Jellyfin running somewhere on your network, and Docker.

```sh
git clone https://github.com/dcluker/myflix.git && cd myflix
./setup.sh                     # asks for your Jellyfin address and a password, checks them, writes .env
docker compose up -d --build
```

Open `http://<this computer>:8108`, sign in with your password, then link your Jellyfin profile (the "Who's watching?" screen).
That is all you need for the web UI on phones, tablets, laptops and any TV browser.

- **No Docker?** `./setup.sh`, then `set -a; . ./.env; set +a; python3 server.py` (Python 3.9+, nothing to install; tested on 3.13 and 3.14).
- **From outside your home:** put it behind HTTPS (a reverse proxy, Tailscale, or a Cloudflare Tunnel). The password page is
  fine on a home network; do not expose plain HTTP to the internet.
- **Forgot the password?** Edit `MYFLIX_PASSWORD` in `.env` and `docker compose up -d`. Changing it signs every browser out.
- **Several people with their own sign-ins, or the Fire TV app?** Use Cloudflare Access instead (`MYFLIX_AUTH=cloudflare`,
  the default when `MYFLIX_AUTH` is unset); see the rest of this file.
- **Make it yours:** open the profile menu, then **Settings**. Give each profile a display name and picture (emoji on a colour, or an uploaded
  photo, shrunk in the browser and checked by the server), pick a theme (main colour and a background colour that replaces the black) for this
  device, this profile or everyone, and in password mode change the password or sign out there.
- **Live TV (free news, movies, kids, sports channels with a guide)?** See `scripts/livetv/README.md`. In a browser, channels play in a
  built-in player (hls.js, vendored; Safari plays natively). If a channel's host blocks browser playback, MyFlix relays it itself (it only
  fetches URLs it signed, never private addresses), then falls back to Jellyfin's transcode.

## What is in here

| Path | What |
|---|---|
| `server.py`, `static/` | Web UI + JSON API (profiles, rows, search, requests, `playinfo` for the TV app) |
| `sso_guard.py` | Verifies Cloudflare Access JWTs (RS256, fail-closed) |
| `android/` | The TV/phone app (package `dev.theprivatehome.myflix`; change it if you fork) |
| `tests/` | Server tests (`python3 -m unittest discover -s tests`) |
| `deploy.sh` | macOS one-shot: Access app, policy, launchd job, DNS, tunnel ingress |
| `SPEC.md` | Design notes |

## Run it

```sh
cp .env.example .env     # fill in, then export the variables (server.py reads the environment)
MYFLIX_DEV=1 MYFLIX_PORT=8118 python3 server.py    # dev mode: auth disabled, never use on a public port
python3 -m unittest discover -s tests
```

The server refuses to start without `JELLYFIN_URL`, `JELLYFIN_PUBLIC`, `JELLYFIN_SERVER_ID` and (outside
dev mode) `CF_TEAM_DOMAIN`. Every server-specific value comes from the environment; see `.env.example`.

## Android app

```sh
cd android
cp local.properties.example local.properties    # your hostnames and LAN address (gitignored)
./gradlew testDebugUnitTest assembleDebug
./build_apk.sh                                  # signed release; reads the keystore password from the macOS Keychain
```

The APK contains **no credentials**. On first launch the app asks for a pairing code and exchanges it for a
per-device Cloudflare Access service token, stored with `EncryptedSharedPreferences`. Tokens are only sent to
HTTPS hosts under `MYFLIX_HOST_SUFFIX`, never to the LAN address.

### Pairing service (not included)

The app expects a small public service at `MYFLIX_TV_BASE` that you run yourself:

- `POST /pair` with `{"code":"XXXX-XXXX","deviceLabel":"..."}` returns
  `{"clientId","clientSecret","name","myflixBase","jellyfinBase"}`; codes are single-use and expire.
- `GET /version.json` returns `{"versionCode","versionName","sha256","apk","minSdk"}` for in-app updates.
- `GET /MyFlix.apk` serves the signed APK.

The MyFlix server resolves a paired device's `clientId` to a person through the registry at
`MYFLIX_REGISTRY_URL` (`GET` with `X-Internal-Token`, returns `{"devices":{"<clientId>":{"email","name","label","revoked"}}}`).

## Forking: make it yours

- **Package id:** `scripts/rename-package.sh com.yourname.myflix [--apply] [--ios-prefix com.yourname]` renames the Android
  package, the iOS keychain service and the server's default `MYFLIX_CAST_PKG` (dry run unless `--apply`).
- **Hosts and addresses:** nothing site-specific is hard-coded. Android reads `android/local.properties`, the server reads
  the environment (`.env.example`), `deploy.sh` reads `deploy.local.env`, and `scripts/tv-refresh.sh` reads
  `scripts/tv-refresh.local.env` (`TV_REFRESH_TVS="bedroom=192.168.1.20,living=192.168.1.21"`). All of those files are gitignored.
- **iOS:** `cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig`, then `xcodegen generate && pod install`.
  Free Apple signing expires after 7 days, so reinstall weekly (or use a paid account).

## Home extras (optional)

Everything below is off unless configured, and none of it is needed for the TV app or the web UI.

- **TV remote + cast + "take it with me":** set `MYFLIX_TV_NAMES`, `MYFLIX_TV_ADB` (device name -> LAN IP with ADB on :5555) and
  `MYFLIX_CAST=1`. The server drives the TV over ADB (play/pause/seek/stop, start a title via the `cast_item` launch extra).
- **Echo Hub** (`/echo`, `static/echo.*`): a compact launcher page for a small touch display (built for an Echo Show 5
  running LineageOS), with browse, filters, casting, now-playing and doorbell alerts. Needs the Echo Hub APK (separate project).
- **Apple Watch app** (`ios/MyFlixWatch`): TV remote, Continue Watching and search-to-play from the wrist. See `ios/README.md`.
- **Voice search + wake word:** the page records short clips and POSTs them to `/api/echo/stt` / `/api/echo/wake`, which forward
  to a local speech-to-text service at `MYFLIX_STT_URL` (POST audio, returns `{"text": "..."}`; faster-whisper `base.en` works well).
  Audio is transcribed and discarded. Wake words are editable in the Echo UI and stored in `data/echo_wake.json`.
- **Doorbell:** Home Assistant POSTs `{"kind":"doorbell"}` to `/hook/echo-alert` (LAN only) to pop the camera up on the Echo, and
  can show a live-ish view on a TV through `/hook/doorbell-live?t=<camera access token>` (needs `MYFLIX_HA_URL` and
  `MYFLIX_DOORBELL_CAMERA`; the page refreshes the camera snapshot about once a second). Both hooks refuse anything that did
  not come from a private address or that carries Cloudflare headers.

## Security model

- **Password mode (`MYFLIX_AUTH=password`):** one shared password, a signed 30-day session cookie (HttpOnly, SameSite=Lax),
  constant-time comparison, and 5 wrong tries per 15 minutes per address before it locks that address out. The signing key
  lives in `data/session.key` (0600) and is mixed with the password. It is meant for a home network or behind HTTPS.
- Everything except the pairing service sits behind Cloudflare Access; the server also verifies the Access JWT itself.
- Each device has its own service token and can be revoked without touching anyone else.
- Remote devices are capped (source bitrate, concurrent streams) and direct-play only.
- Keep `android/keystore/`, `android/local.properties`, `deploy.local.env` and `data/` out of version control (already in `.gitignore`).

MIT licensed; see `LICENSE`.
