#!/bin/zsh
# Deploy MyFlix to T14 (prod for the TVs): push main to the bare repo; its post-receive hook
# checks out into ~/myflix and restarts the service only if .py files changed.
set -euo pipefail
cd ${0:A:h}/..
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo "uncommitted changes: commit first"; exit 1; }
git push origin main
git push t14 main
echo "T14 live: $(ssh t14 'git --git-dir=$HOME/myflix.git rev-parse --short main')  local: $(git rev-parse --short HEAD)"
