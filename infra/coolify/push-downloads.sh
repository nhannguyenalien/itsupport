#!/bin/sh
# Copies the signed agent release + restic binaries to the Coolify host so Caddy
# can serve them (mounted at DOWNLOADS_DIR). Usage: push-downloads.sh user@host [remote-dir]
set -eu
HOST="${1:?usage: push-downloads.sh user@host [remote-dir]}"
REMOTE_DIR="${2:-/data/itsupport/downloads}"
SRC="$(cd "$(dirname "$0")/../../frontend/public/downloads/agent" && pwd)"
ssh "$HOST" "mkdir -p '$REMOTE_DIR'"
# Install scripts stay in git (served by the frontend); only ignored artifacts go here.
rsync -av --delete \
  --include='darwin-*/***' --include='linux-*/***' --include='windows-*/***' \
  --include='restic-*' --exclude='*' \
  "$SRC/" "$HOST:$REMOTE_DIR/"
echo "Pushed to $HOST:$REMOTE_DIR"
