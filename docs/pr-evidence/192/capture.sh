#!/usr/bin/env bash
# Capture #192 ap4 removed-agents evidence (Chrome/Chromium headless).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
HTML="file://${ROOT}/removed-agents.html"
CHROME="${CHROME:-google-chrome}"
if ! command -v "$CHROME" >/dev/null 2>&1; then
  CHROME=chromium-browser
fi
if ! command -v "$CHROME" >/dev/null 2>&1; then
  CHROME=chromium
fi
shot() {
  local scene=$1 theme=$2 out=$3
  local url="${HTML}?scene=${scene}"
  [[ "$theme" == dark ]] && url="${url}&theme=dark"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=720,520 --screenshot="$ROOT/$out" "$url" 2>/dev/null
}
shot collapsed light ap4-removed-agents-collapsed-light.png
shot collapsed dark ap4-removed-agents-collapsed-dark.png
shot expanded light ap4-removed-agents-expanded-light.png
shot expanded dark ap4-removed-agents-expanded-dark.png
echo "Wrote 4 PNGs under $ROOT"
