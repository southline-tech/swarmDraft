#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
BASE="http://127.0.0.1:${CAPTURE_PORT:-8770}/"
CHROME="${CHROME:-google-chrome}"
if ! command -v "$CHROME" >/dev/null 2>&1; then CHROME=chromium-browser; fi
if ! command -v "$CHROME" >/dev/null 2>&1; then CHROME=chromium; fi

rm -f "$ROOT"/landing-*.png

shot() {
  local url=$1 w=$2 h=$3 out=$4
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 \
    --window-size="$w,$h" \
    --screenshot="$ROOT/$out" "$url" 2>/dev/null
}

(
  cd "$REPO/site"
  python3 -m http.server "${CAPTURE_PORT:-8770}" >/dev/null
) &
srv=$!
trap 'kill "$srv" 2>/dev/null || true' EXIT
sleep 0.8

shot "${BASE}#light" 1280 3600 landing-desktop-light.png
shot "${BASE}#dark" 1280 3600 landing-desktop-dark.png
shot "${BASE}#light" 390 4200 landing-mobile-light.png
shot "${BASE}#dark" 390 4200 landing-mobile-dark.png
shot "${BASE}?focus=download#light" 1280 720 landing-download-focus.png

for f in landing-desktop-light.png landing-desktop-dark.png landing-mobile-light.png landing-mobile-dark.png; do
  python3 "$ROOT/crop-screenshots.py" "$ROOT/$f"
done

echo "Wrote pr-evidence/292/landing-*.png (full-page crops above)"
