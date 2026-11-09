# MyFlix for iPhone / iPad

SwiftUI shell around the MyFlix web app, with a native AVPlayer for playback. Pairs with the same
8-character code as the Fire TV app (no Google login needed on the device).

Setup: `cp Config/Local.xcconfig.example Config/Local.xcconfig`, fill in your hosts and Apple team id,
then `xcodegen generate` and open `MyFlix.xcodeproj`. Free Apple signing expires after 7 days.

## Live TV (1.1.0)

The Live tab, guide, filters, theme and Settings come through the web layer (nothing to update). Tapping a channel opens the native
player: `/play/<id>?live=1` is routed to `/api/livetv/play/<id>`. Most channels are plain public HLS and play straight in AVPlayer
with **no Jellyfin headers** (the token never goes to a third-party host); the rest use a Jellyfin stream that is released on close
(`/api/livetv/stop`). Live skips progress reporting, next-episode and the VLC fallback.

## Apple Watch app (`MyFlixWatch/`)

A small remote, not a player: it controls the TV the server already drives (the same endpoints the Echo and the phone bar use).

- **Now playing:** what the chosen TV is on, with back 10 / play-pause / forward 10 / stop. Refreshes every 4 s while it is on screen.
- **Continue:** your Continue Watching list (posters, progress); tap a title to play it on the TV. A busy TV asks "cast anyway?".
- **Search:** tap the field to dictate or scribble a title; the server ranks the matches (`GET /api/search?q=`), tap one to play it.
- **TV picker:** shown only if more than one TV has remote control set up.

How it signs in: it never pairs by itself. The iPhone app sends its pairing credentials over WatchConnectivity (encrypted between your
paired devices) and clears them on sign-out; the watch keeps them in its own Keychain. If there is more than one profile you pick one once.

Layout: `Shared/` (config + keychain store, used by both apps), `MyFlixWatch/` (SwiftUI: `API`, `Account`, `Models`, one file per screen),
`MyFlixWatchTests/` (decoding and list logic), `MyFlix/WatchBridge.swift` (phone side).

Targets and schemes:

| Scheme | What | When |
|---|---|---|
| `MyFlix` | the phone/tablet app only | iPad installs and the weekly re-sign |
| `MyFlixWithWatch` | the same app with the watch app embedded | an iPhone with an Apple Watch |
| `MyFlixWatch` | the watch app alone (simulator, tests) | development |

The watch app is not part of the everyday build on purpose: Apple will only create its provisioning profile once a watch is registered
to the developer account (Xcode: connect the iPhone, pick the watch as a destination once). Until then `xcodebuild` says "No Accounts".
`MF_APP_ID=<bundle id>` on the command line installs under another id; the watch id follows (`<id>.watchkitapp`).

Simulator: boot a watch simulator, install the build, and use the DEBUG hooks instead of a phone:
`xcrun simctl spawn <watch> defaults write <bundle id>.watchkitapp debugCreds -data <hex of the credentials JSON>`
(and `debugTab` = `continue` or `search` to open on another screen).
