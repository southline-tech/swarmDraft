#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-google-chrome}"
if ! command -v "$CHROME" >/dev/null 2>&1; then CHROME=chromium-browser; fi
if ! command -v "$CHROME" >/dev/null 2>&1; then CHROME=chromium; fi
shot() {
  local html=$1 out=$2
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=1280,800 --screenshot="$ROOT/$out" "file://${ROOT}/${html}" 2>/dev/null
}
shot scene-welcome.html welcome-ob4-light.png
shot scene-save-failure.html save-failure-banner-light.png
shot scene-empty-review.html empty-review-ob8-light.png
echo "Wrote PNGs; md5:"
md5sum "$ROOT"/*-light.png
