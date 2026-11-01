#!/usr/bin/env bash
# Capture #37 token evidence (Chrome/Chromium headless).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
HTML="file://${ROOT}/evidence.html"
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
    --window-size=480,360 --screenshot="$ROOT/$out" "$url" 2>/dev/null
}
shot outline light outline-selected-light.png
shot outline dark outline-selected-dark.png
shot comments light comments-quote-light.png
shot comments dark comments-quote-dark.png
shot focus light focus-ring-light.png
shot focus dark focus-ring-dark.png
echo "Wrote 6 PNGs under $ROOT"
