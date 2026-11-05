# PR evidence — #34 copy deck / release gate + #41 pilot docs

Real-app screenshots at **1280×800** or larger from `pnpm tauri dev` (or `pnpm dev:web` — same UI). Not mockups; components come from the dev harness `?evidence=34-41&frame=…`.

| File                   | Checklist row           |
| ---------------------- | ----------------------- |
| `welcome.png`          | Home welcome            |
| `import.png`           | Import / open book      |
| `opening-progress.png` | Opening progress        |
| `editor.png`           | Editor loaded           |
| `save-status.png`      | Footer save status      |
| `update-prompt.png`    | Update prompt           |
| `error-card.png`       | Error card (ob9)        |
| `empty-states.png`     | Review / comments empty |
| `export-settings.png`  | Settings → Export       |
| `agents.png`           | Settings → Agents       |

Manual-only rows (reopen after restart, `.draft` round-trip): note steps in the PR body if screenshots are not captured in CI.

## Recapture

From repo root (Chrome/Chromium required):

1. Start the app: `pnpm tauri dev` **or** `pnpm dev:web`
2. In another terminal: `node pr-evidence/34-41/capture.mjs`  
   (If the server is already running, set `EVIDENCE_BASE=http://127.0.0.1:1420` to skip spawning dev:web.)

Or: `node scripts/copy-34-41-evidence.mjs` (runs the same capture script).
