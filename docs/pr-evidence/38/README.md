# PR evidence — #38 Story notes

Screenshots of the story notes panel beside the draft (empty state and human + bot notes).

- `notes-empty-light.png` / `notes-empty-dark.png` — no notes yet
- `notes-filled-light.png` / `notes-filled-dark.png` — sample human and bot-authored notes

Source harness: `notes-panel.html` (tokens from `apps/desktop/src/styles/tokens.css`).

Regenerate:

```sh
cd /path/to/repo/.worktrees/rad-38-notes
BASE="file://$PWD/docs/pr-evidence/38/notes-panel.html"
google-chrome --headless --disable-gpu --window-size=420,720 \
  --screenshot=docs/pr-evidence/38/notes-empty-light.png "$BASE"
google-chrome --headless --disable-gpu --window-size=420,720 \
  --screenshot=docs/pr-evidence/38/notes-empty-dark.png "${BASE}?theme=dark"
google-chrome --headless --disable-gpu --window-size=420,720 \
  --screenshot=docs/pr-evidence/38/notes-filled-light.png "${BASE}?frame=filled"
google-chrome --headless --disable-gpu --window-size=420,720 \
  --screenshot=docs/pr-evidence/38/notes-filled-dark.png "${BASE}?frame=filled&theme=dark"
```

Dev app harness: `pnpm dev:web` with `?evidence=38-notes&frame=empty|filled`.
