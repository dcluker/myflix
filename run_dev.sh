#!/bin/sh
cd "$(dirname "$0")" || exit 1
MYFLIX_DEV=1 MYFLIX_PORT=8118 exec /opt/homebrew/bin/python3 server.py
