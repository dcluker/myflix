#!/usr/bin/env bash
# Refresh MyFlix on a Fire TV: clear WebView/app CACHE only (never `pm clear`), force-stop, relaunch.
# Cache clearing happens inside the app via the `clear_cache` launch extra (MainActivity).
# Usage: tv-refresh.sh [<name>|<ip[:port]>] [--force] [--install]
# TV names come from scripts/tv-refresh.local.env (gitignored) or the TV_REFRESH_TVS environment variable, e.g.
#   TV_REFRESH_TVS="bedroom=192.168.1.20,living=192.168.1.21"   (the first one is the default target)
set -euo pipefail

PKG=${MYFLIX_CAST_PKG:-dev.theprivatehome.myflix}   # the TV app package id (change it if you renamed the package)
LAUNCH=$PKG/.Home            # launcher activity-alias -> MainActivity
PLAYER=PlayerActivity
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")/.." && pwd)"
APK="$ROOT/android/dist/MyFlix.apk"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/tv-refresh.local.env" ] && . "$HERE/tv-refresh.local.env"
TV_REFRESH_TVS="${TV_REFRESH_TVS:-}"
target="${TV_REFRESH_TVS%%=*}" force=0 install=0
for a in "$@"; do
  case "$a" in
    --force) force=1 ;;
    --install) install=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *) target="$a" ;;
  esac
done

dev=""
for pair in ${TV_REFRESH_TVS//,/ }; do
  if [ "${pair%%=*}" = "$target" ]; then dev="${pair#*=}:5555"; fi
done
if [ -z "$dev" ]; then
  case "$target" in
    *:*) dev=$target ;;
    [0-9]*) dev=$target:5555 ;;
    *) echo "unknown TV '$target': set TV_REFRESH_TVS or scripts/tv-refresh.local.env" >&2; exit 2 ;;
  esac
fi

command -v adb >/dev/null || { echo "adb not found on PATH" >&2; exit 1; }

# `adb connect` does not wake the TV.
out=$(adb connect "$dev" 2>&1 || true)
case "$out" in
  *connected*) ;;
  *) echo "FAILED: could not connect to $dev ($out)" >&2; exit 1 ;;
esac
A=(adb -s "$dev")

# Asleep check first so we never wake the TV (no input events, no am start).
wake=$("${A[@]}" shell dumpsys power 2>/dev/null | tr -d '\r' | grep -m1 -o 'mWakefulness=[A-Za-z]*' || true)
if [ "$wake" != "mWakefulness=Awake" ]; then
  echo "TV is asleep, nothing done"
  exit 0
fi

# Don't kill a movie in progress unless told to.
focus=$("${A[@]}" shell dumpsys window 2>/dev/null | tr -d '\r' | grep -m1 'mCurrentFocus' || true)
if [[ "$focus" == *"$PKG/"*"$PLAYER"* || "$focus" == *"$PKG"*"$PLAYER"* ]] && [ "$force" -eq 0 ]; then
  echo "REFUSED: MyFlix is in the player (a movie may be playing) on $dev; re-run with --force to refresh anyway" >&2
  exit 1
fi

if [ "$install" -eq 1 ]; then
  [ -f "$APK" ] || { echo "FAILED: $APK not found" >&2; exit 1; }
  "${A[@]}" install -r "$APK" >/dev/null
fi

"${A[@]}" shell am force-stop "$PKG"
res=$("${A[@]}" shell am start -n "$LAUNCH" --ez clear_cache true 2>&1 | tr -d '\r')
if [[ "$res" == *Error* || "$res" == *Exception* ]]; then
  echo "FAILED: $res" >&2
  exit 1
fi
echo "OK: $target ($dev) cache cleared, force-stopped, relaunched$([ "$install" -eq 1 ] && echo ", APK installed")"
