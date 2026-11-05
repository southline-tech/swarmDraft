# PR evidence — #310 in-app updater

Captured from the real Vue components at **1280×800** using the dev harness (`?evidence=310-updater`). The updater plugin is mocked by the harness (static toast/progress/up-to-date states).

| File                    | Frame                                     |
| ----------------------- | ----------------------------------------- |
| `update-available.png`  | New version toast with Update now / Later |
| `update-progress.png`   | Download progress                         |
| `update-up-to-date.png` | Manual check — You're up to date          |

Regenerate:

```sh
node pr-evidence/310/capture.mjs
```

Requires Chrome/Chromium; the script starts `pnpm dev:web`.
