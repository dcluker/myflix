#!/bin/zsh
# First-time go-live for MyFlix: Access app -> policy -> launchd -> DNS -> tunnel ingress.
# Order matters: Access exists before DNS so the host is never open. Safe to re-run.
set -euo pipefail

DIR=${0:A:h}
# All site-specific values live in deploy.local.env (gitignored). Copy deploy.local.env.example and fill it in.
[[ -f $DIR/deploy.local.env ]] || { echo "missing deploy.local.env (see deploy.local.env.example)"; exit 1; }
source $DIR/deploy.local.env
for v in HOST PORT ACCT ZONE TUNNEL GOOGLE_IDP ACCESS_GROUP CF_TEAM_DOMAIN JELLYFIN_URL JELLYFIN_PUBLIC JELLYFIN_SERVER_ID CF_TOKEN_KEYCHAIN; do
  [[ -n ${(P)v:-} ]] || { echo "deploy.local.env: $v is not set"; exit 1; }
done
PLIST=~/Library/LaunchAgents/com.mac.myflix.plist
TUNNEL_CFG=${TUNNEL_CFG:-~/.cloudflared/mac-files.yml}
TUNNEL_SERVICE=${TUNNEL_SERVICE:-com.mac.files-tunnel}
DNS_NAME=${DNS_NAME:-${HOST%%.*}}
CF=https://api.cloudflare.com/client/v4
TOK=$(security find-generic-password -s "$CF_TOKEN_KEYCHAIN" -w)
H=(-H "Authorization: Bearer $TOK" -H "Content-Type: application/json")
j() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

echo "1/5 Access app"
APP=$(curl -s "$CF/accounts/$ACCT/access/apps?per_page=200" "${H[@]}" | j "print(next((a['id'] for a in d['result'] if a.get('domain')=='$HOST'),''))")
if [[ -z $APP ]]; then
  APP=$(curl -s -X POST "$CF/accounts/$ACCT/access/apps" "${H[@]}" -d "{\"name\":\"MyFlix\",\"domain\":\"$HOST\",\"type\":\"self_hosted\",\"session_duration\":\"48h\",\"app_launcher_visible\":true,\"http_only_cookie_attribute\":true,\"allowed_idps\":[\"$GOOGLE_IDP\"],\"auto_redirect_to_identity\":true}" | j "assert d['success'], d['errors']; print(d['result']['id'])")
  curl -s -X POST "$CF/accounts/$ACCT/access/apps/$APP/policies" "${H[@]}" -d "{\"name\":\"Allowed group\",\"decision\":\"allow\",\"precedence\":1,\"include\":[{\"group\":{\"id\":\"$ACCESS_GROUP\"}}]}" | j "assert d['success'], d['errors']; print('   policy ok')"
fi
AUD=$(curl -s "$CF/accounts/$ACCT/access/apps/$APP" "${H[@]}" | j "print(d['result']['aud'])")
echo "   app $APP"

echo "2/5 launchd"
# Optional runtime settings: any of these set in deploy.local.env are written into the plist, so a
# re-run never silently drops a feature. Unset ones are omitted (server defaults apply).
EXTRA_ENV=""
for v in MYFLIX_OWNER_EMAILS MYFLIX_PHONE_BASE MYFLIX_CAST MYFLIX_JF_AUTOLOGIN MYFLIX_STT_URL MYFLIX_HA_URL MYFLIX_DOORBELL_CAMERA CF_ACCESS_AUD_JELLYFIN; do
  [[ -n ${(P)v:-} ]] && EXTRA_ENV+="        <key>$v</key><string>${(P)v}</string>"$'\n'
done
cat > $PLIST <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.mac.myflix</string>
    <key>ProgramArguments</key>
    <array>
        <string>${PYTHON_BIN:-/opt/homebrew/bin/python3.14}</string>
        <string>$DIR/server.py</string>
    </array>
    <key>WorkingDirectory</key><string>$DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>CF_ACCESS_AUD</key><string>$AUD</string>
        <key>CF_TEAM_DOMAIN</key><string>$CF_TEAM_DOMAIN</string>
        <key>JELLYFIN_URL</key><string>$JELLYFIN_URL</string>
        <key>JELLYFIN_PUBLIC</key><string>$JELLYFIN_PUBLIC</string>
        <key>JELLYFIN_SERVER_ID</key><string>$JELLYFIN_SERVER_ID</string>
        <key>MYFLIX_REGISTRY_URL</key><string>${REGISTRY_URL:-}</string>
        <key>MYFLIX_REGISTRY_KEYCHAIN_SERVICE</key><string>${REGISTRY_KEYCHAIN_SERVICE:-myflix-registry-token}</string>
        <key>MYFLIX_SEERR_URL</key><string>${SEERR_URL:-}</string>
        <key>MYFLIX_SEERR_KEYCHAIN_SERVICE</key><string>${SEERR_KEYCHAIN_SERVICE:-myflix-jellyseerr-api}</string>
        <key>MYFLIX_PORT</key><string>$PORT</string>
        <key>MYFLIX_TV_CLIENT_IDS</key><string>${TV_CLIENT_IDS:-}</string>
        <key>MYFLIX_TV_EMAIL</key><string>${TV_EMAIL:-}</string>
        <key>MYFLIX_TV_NAMES</key><string>${HANDOFF_TV_NAMES:-}</string>
        <key>MYFLIX_TV_ADB</key><string>${HANDOFF_TV_ADB:-}</string>
${EXTRA_ENV}    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>/tmp/myflix.log</string>
    <key>StandardErrorPath</key><string>/tmp/myflix.log</string>
</dict>
</plist>
EOF
plutil -lint $PLIST
launchctl bootout gui/$(id -u)/com.mac.myflix 2>/dev/null || true
# bootout returns before the job is gone; bootstrapping too early fails with "5: Input/output error"
for i in {1..20}; do launchctl print gui/$(id -u)/com.mac.myflix >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap gui/$(id -u) $PLIST
sleep 2
curl -sf http://127.0.0.1:$PORT/healthz >/dev/null && echo "   server up on $PORT"

echo "3/5 DNS"
EXISTS=$(curl -s "$CF/zones/$ZONE/dns_records?name=$HOST" "${H[@]}" | j "print(len(d['result']))")
if [[ $EXISTS == 0 ]]; then
  curl -s -X POST "$CF/zones/$ZONE/dns_records" "${H[@]}" -d "{\"type\":\"CNAME\",\"name\":\"$DNS_NAME\",\"content\":\"$TUNNEL.cfargotunnel.com\",\"proxied\":true}" | j "assert d['success'], d['errors']; print('   CNAME created')"
else
  echo "   CNAME already exists"
fi

echo "4/5 tunnel ingress"
if ! grep -q "hostname: $HOST" $TUNNEL_CFG; then
  cp $TUNNEL_CFG $TUNNEL_CFG.bak-myflix
  python3 - "$TUNNEL_CFG" "$HOST" "$PORT" <<'PY'
import sys
path, host, port = sys.argv[1:]
lines = open(path).read().splitlines(keepends=True)
i = next(n for n, l in enumerate(lines) if "service: http_status:404" in l)
lines[i:i] = [f"  - hostname: {host}\n", f"    service: http://127.0.0.1:{port}\n"]
open(path, "w").writelines(lines)
PY
  launchctl kickstart -k gui/$(id -u)/$TUNNEL_SERVICE
  echo "   ingress added (backup: $TUNNEL_CFG.bak-myflix), tunnel restarted"
  sleep 8
else
  echo "   ingress already present"
fi

echo "5/5 verify"
for h in $HOST; do
  printf "   %-32s %s\n" $h "$(curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}' https://$h/ | cut -c1-90)"
done
echo "Expect 302 -> ...cloudflareaccess.com."
