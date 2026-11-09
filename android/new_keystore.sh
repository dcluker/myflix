#!/bin/bash
# Deliberately creates a NEW release keystore. Refuses to overwrite an existing keystore or Keychain item.
# Installed apps signed with the old key cannot upgrade in place after this.
set -euo pipefail
cd "$(dirname "$0")"
KS="$(pwd)/keystore/myflix.jks"
SVC="${MYFLIX_KS_KEYCHAIN_SERVICE:-$(sed -n 's/^MYFLIX_KS_KEYCHAIN_SERVICE=//p' local.properties 2>/dev/null | head -1)}"
SVC="${SVC:-myflix-apk-keystore}"
[ -e "$KS" ] && { echo "keystore already exists: $KS" >&2; exit 1; }
security find-generic-password -s "$SVC" >/dev/null 2>&1 && { echo "Keychain item '$SVC' already exists; refusing to overwrite" >&2; exit 1; }
mkdir -p keystore
PW="$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-24)"
keytool -genkeypair -keystore "$KS" -alias myflix -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PW" -keypass "$PW" -dname "CN=MyFlix, O=MyFlix, C=US" >/dev/null 2>&1
security add-generic-password -a myflix -s "$SVC" -w "$PW"
chmod 600 "$KS"
echo "created $KS and Keychain item $SVC"
