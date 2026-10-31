#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/docs/pr-evidence/39"
HTML="file://$OUT/evidence.html"
if ! command -v google-chrome >/dev/null 2>&1; then
  echo "google-chrome not found; open evidence.html manually for screenshots"
  exit 0
fi
google-chrome --headless --disable-gpu --window-size=720,900 \
  --screenshot="$OUT/export-light.png" "$HTML"
google-chrome --headless --disable-gpu --window-size=720,900 \
  --screenshot="$OUT/export-dark.png" "${HTML}?theme=dark"
