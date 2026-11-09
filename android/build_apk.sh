#!/bin/bash
# Builds the signed MyFlix Fire TV APK -> dist/MyFlix.apk
# The APK carries no Cloudflare credentials (devices pair at runtime). Only the signing-keystore
# password is read from the macOS Keychain at build time; it is never written to disk by this script.
# Server-specific values (hosts, LAN address) come from gradle properties / env / android/local.properties.
#   ./build_apk.sh        signed release -> dist/MyFlix.apk (+ dist/MyFlix.apk.json sidecar)
#   ./build_apk.sh test   debug build "MyFlix Test" (applicationId .test, side-by-side) -> dist/MyFlix-test.apk
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 21 2>/dev/null || true)}"
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"

KS="$ROOT/keystore/myflix.jks"
# Keychain item name: env, else android/local.properties, else a generic default.
KS_SERVICE="${MYFLIX_KS_KEYCHAIN_SERVICE:-$(sed -n 's/^MYFLIX_KS_KEYCHAIN_SERVICE=//p' "$ROOT/local.properties" 2>/dev/null | head -1)}"
KS_SERVICE="${KS_SERVICE:-myflix-apk-keystore}"
mkdir -p "$ROOT/keystore" "$ROOT/dist"

if [ ! -f "$KS" ]; then
  # Never auto-create: a regenerated key (or an overwritten Keychain password) breaks in-place upgrades on installed devices.
  echo "[build_apk] ERROR: release keystore missing at $KS" >&2
  echo "  Restore it from backup. To mint a NEW key on purpose, run: ./new_keystore.sh (existing installs will need uninstalling)." >&2
  exit 1
fi

MYFLIX_KEYSTORE_PASSWORD="$(security find-generic-password -s "$KS_SERVICE" -w)"
export MYFLIX_KEYSTORE_PASSWORD
export MYFLIX_KEYSTORE_PATH="$KS"

if [ "${1:-}" = "test" ]; then
  ./gradlew --no-daemon assembleDebug
  cp app/build/outputs/apk/debug/app-debug.apk "$ROOT/dist/MyFlix-test.apk"
echo "[build_apk] wrote $ROOT/dist/MyFlix-test.apk"
  exit 0
fi

./gradlew --no-daemon assembleRelease

cp app/build/outputs/apk/release/app-release.apk "$ROOT/dist/MyFlix.apk"
# Sidecar read by the landing server alongside the APK.
VC="$(sed -n 's/.*versionCode = \([0-9]*\).*/\1/p' app/build.gradle.kts | head -1)"
VN="$(sed -n 's/.*versionName = "\([^"]*\)".*/\1/p' app/build.gradle.kts | head -1)"
MS="$(sed -n 's/.*minSdk = \([0-9]*\).*/\1/p' app/build.gradle.kts | head -1)"
printf '{"versionCode":%s,"versionName":"%s","minSdk":%s}\n' "$VC" "$VN" "$MS" > "$ROOT/dist/MyFlix.apk.json"
echo "[build_apk] wrote $ROOT/dist/MyFlix.apk ($(du -h "$ROOT/dist/MyFlix.apk" | cut -f1))"
