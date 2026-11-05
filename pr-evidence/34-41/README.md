# PR evidence — #34 copy deck / release gate + #41 pilot docs

Real-app screenshots at **1280×800** or larger from `pnpm tauri dev` (not mockups). One PNG per row in `docs/release-checklist.md`.

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

## Populate from merged batch evidence

From repo root:

```sh
mkdir -p pr-evidence/34-41
cp pr-evidence/34/c5-first-run-welcome-light.png pr-evidence/34-41/welcome.png
cp pr-evidence/299/home-import-wording.png pr-evidence/34-41/import.png
cp pr-evidence/299/progress-mid-big-file.png pr-evidence/34-41/opening-progress.png
cp pr-evidence/36/36-editor-light.png pr-evidence/34-41/editor.png
cp pr-evidence/34/status-saved-just-now-light.png pr-evidence/34-41/save-status.png
cp pr-evidence/310/update-available.png pr-evidence/34-41/update-prompt.png
cp pr-evidence/299/error-state.png pr-evidence/34-41/error-card.png
cp pr-evidence/34/c7-empty-review-light.png pr-evidence/34-41/empty-states.png
cp docs/pr-evidence/39/export-light.png pr-evidence/34-41/export-settings.png
cp docs/pr-evidence/192/ap4-removed-agents-collapsed-light.png pr-evidence/34-41/agents.png
```

Or: `node scripts/copy-34-41-evidence.mjs` (same mapping).
