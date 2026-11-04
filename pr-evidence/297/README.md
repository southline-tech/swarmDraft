# PR #297 evidence (#208 feedback UI)

Static HTML reproduces shipped dialog CSS (`tokens.css`, `app.css`, `settings.css`).

- **Per-scene files** (used by `./capture.sh`): `scene-empty.html`, `scene-validation.html`, `scene-send-error.html`, `scene-success.html`, `scene-bot-one.html`, `scene-bot-queue.html`
- **Combined viewer**: `evidence.html?scene=` (manual browser only; headless uses per-scene files)

Capture: `./capture.sh` (Chromium, 900×640). Verify six distinct MD5s.
