#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
SITE="$REPO/site/index.html"
CHROME="${CHROME:-google-chrome}"
if ! command -v "$CHROME" >/dev/null 2>&1; then CHROME=chromium-browser; fi
if ! command -v "$CHROME" >/dev/null 2>&1; then CHROME=chromium; fi
shot() {
  local size=$1 out=$2
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --window-size="$size" --screenshot="$ROOT/$out" "file://${SITE}" 2>/dev/null
}
shot 1280,800 landing-desktop-light.png
shot 390,844 landing-mobile-light.png
