#!/usr/bin/env bash
# Capture #159 designer evidence PNGs from evidence.html (requires Chrome/Chromium).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
HTML="file://${ROOT}/evidence.html"
CHROME="${CHROME:-google-chrome}"
if ! command -v "$CHROME" >/dev/null 2>&1; then
  CHROME=chromium-browser
fi
shot() {
  local scene=$1 theme=$2 out=$3
  local url="${HTML}?scene=${scene}"
  [[ "$theme" == dark ]] && url="${url}&theme=dark"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=800,450 --screenshot="$ROOT/$out" "$url" 2>/dev/null
}
shot sc1 light sc1-underlines-light.png
shot sc1 dark sc1-underlines-dark.png
shot sc2 light sc2-spelling-menu-light.png
shot sc2 dark sc2-spelling-menu-dark.png
shot sc3 light sc3-grammar-menu-light.png
shot sc3 dark sc3-grammar-menu-dark.png
shot sc4 light sc4-dictionary-light.png
shot sc4 dark sc4-dictionary-dark.png
shot sc5 light sc5-empty-dict-light.png
shot sc5 dark sc5-empty-dict-dark.png
shot sc6 light sc6-dict-search-light.png
shot sc6 dark sc6-dict-search-dark.png
echo "Wrote 12 PNGs under $ROOT"
