#!/usr/bin/env bash
# Guided first-time setup: asks for your Jellyfin address, checks it, picks a password and writes .env.
# Then start MyFlix with:  docker compose up -d --build     (or: set -a; . ./.env; set +a; python3 server.py)
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
ask() { local v; read -r -p "$1" v || true; printf '%s' "${v:-${2:-}}"; }

command -v curl >/dev/null || { say "curl is required."; exit 1; }

if [ -f .env ]; then
  [ "$(ask '.env already exists. Overwrite it? [y/N] ' n)" = y ] || { say "Left .env alone."; exit 0; }
fi

say "MyFlix setup"
say "Where is Jellyfin? Use an address this computer can reach, e.g. http://192.168.1.10:8096"
say "(with Docker, do not use localhost: that points at the container; use the machine's LAN address)"
while :; do
  url="$(ask 'Jellyfin address: ')"
  url="${url%/}"
  [ -n "$url" ] || { say "Please enter an address."; continue; }
  info="$(curl -fsS -m 8 "$url/System/Info/Public" 2>/dev/null || true)"
  id="$(printf '%s' "$info" | sed -n 's/.*"Id":"\([^"]*\)".*/\1/p')"
  name="$(printf '%s' "$info" | sed -n 's/.*"ServerName":"\([^"]*\)".*/\1/p')"
  if [ -n "$id" ]; then say "Found Jellyfin server \"${name:-unnamed}\"."; break; fi
  say "Could not reach Jellyfin at $url. Check the address and that the server is running."
done

pw="$(ask 'Password for the MyFlix web page (blank = make a random one): ')"
if [ -z "$pw" ]; then
  pw="$( (openssl rand -base64 18 2>/dev/null || head -c 18 /dev/urandom | base64) | tr -d '/+=' | head -c 16)"
  say "Generated password: $pw   (saved in .env)"
fi
# .env is read by both the shell and Docker; a single-quoted value is taken literally by both, so only ' is off limits.
while [ "${#pw}" -lt 8 ] || [ "${pw#*\'}" != "$pw" ]; do
  pw="$(ask "Password must be at least 8 characters and cannot contain ' : ")"
done

umask 077
cat > .env <<ENV
# Written by setup.sh. Keep this file private (it holds the web password).
MYFLIX_AUTH=password
MYFLIX_PASSWORD='$pw'
JELLYFIN_URL='$url'
JELLYFIN_SERVER_ID=$id
MYFLIX_PORT=8108
# Listen on every network interface so phones and TVs on your home network can open it (127.0.0.1 = this computer only).
MYFLIX_HOST=0.0.0.0
ENV
chmod 600 .env
say ""
say "Done. Next:"
say "  docker compose up -d --build"
say "  then open  http://<this computer>:8108   and sign in with your password."
say "Everything else (Live TV, TV app, Cloudflare Access) is optional; see README.md."
