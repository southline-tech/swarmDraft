#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-google-chrome}"
if ! command -v "$CHROME" >/dev/null 2>&1; then CHROME=chromium-browser; fi
if ! command -v "$CHROME" >/dev/null 2>&1; then CHROME=chromium; fi
shot() {
  local html=$1 out=$2
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=720,900 --screenshot="$ROOT/$out" "file://${ROOT}/${html}" 2>/dev/null
}
shot scene-empty.html feedback-empty-light.png
shot scene-validation.html feedback-validation-light.png
shot scene-send-error.html feedback-send-error-light.png
shot scene-success.html feedback-success-light.png
shot scene-bot-one.html feedback-bot-one-light.png
shot scene-bot-queue.html feedback-bot-queue-light.png
echo "Wrote 6 PNGs; md5:"
md5sum "$ROOT"/feedback-*-light.png
