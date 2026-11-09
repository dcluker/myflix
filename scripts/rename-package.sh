#!/usr/bin/env bash
# Rename the app's package id for a fork (default: dev.theprivatehome.myflix) in the Android app, the iOS keychain service,
# the server's default cast package and the helper scripts. Dry run unless --apply.
# Usage: scripts/rename-package.sh com.example.myflix [--apply] [--ios-prefix com.example]
set -euo pipefail
OLD=dev.theprivatehome.myflix
NEW="${1:-}"; shift || true
APPLY=0; IOS_PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --ios-prefix) IOS_PREFIX="${2:?need a prefix}"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$NEW" =~ ^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$ ]] || { echo "usage: $0 <new.package.id> [--apply] [--ios-prefix com.example]" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
OLD_DIR="${OLD//.//}"; NEW_DIR="${NEW//.//}"
FILES=$(grep -rlF "$OLD" android/app server.py .env.example scripts ios/MyFlix ios/project.yml README.md 2>/dev/null | grep -v "/build/" | grep -v "rename-package.sh" || true)
echo "files that mention $OLD:"; echo "$FILES" | sed 's/^/  /'
echo "source dirs to move: android/app/src/*/java/$OLD_DIR -> .../$NEW_DIR"
[ -n "$IOS_PREFIX" ] && echo "iOS bundle prefix: -> $IOS_PREFIX (ios/project.yml)"
[ "$APPLY" = 1 ] || { echo "dry run: add --apply to change files"; exit 0; }
for f in $FILES; do sed -i.orig "s/${OLD//./\\.}/$NEW/g" "$f" && rm -f "$f.orig"; done
for src in android/app/src/*/java; do
  if [ -d "$src/$OLD_DIR" ]; then mkdir -p "$src/$(dirname "$NEW_DIR")"; mv "$src/$OLD_DIR" "$src/$NEW_DIR"; fi
done
find android/app/src -type d -empty -delete 2>/dev/null || true
if [ -n "$IOS_PREFIX" ]; then
  sed -i.orig -E "s/(bundleIdPrefix: ).*/\1$IOS_PREFIX/; s/(PRODUCT_BUNDLE_IDENTIFIER: ).*/\1$IOS_PREFIX.myflix/" ios/project.yml && rm -f ios/project.yml.orig
fi
echo "done. Rebuild the apps; devices need a fresh install (a different package id is a different app)."
