# PR evidence — #36 word-processor editing experience

Captured from the real dev app (`pnpm dev:web` on port 1420), using production editor chrome (`ManuscriptEditor`, `SectionNav`, status bar) — not the shells preview gallery.

```sh
node scripts/evidence-36-real.mjs
```

Requires `google-chrome` (or set `CHROME=`). Window size is 1280×800.

| File                         | Harness                                |
| ---------------------------- | -------------------------------------- |
| `36-editor-light.png`        | `?evidence=rad67&frame=wp1`            |
| `36-nav-collapsed-light.png` | `?evidence=rad67&frame=wp2`            |
| `36-review-panel-light.png`  | `?evidence=rad67&frame=wp8`            |
| `36-focus-mode-light.png`    | `?evidence=rad55`                      |
| `36-editor-dark.png`         | `?evidence=rad67&frame=wp1&theme=dark` |
| `36-find-light.png`          | `?evidence=36-wp&frame=find`           |
| `36-find-replace-light.png`  | `?evidence=36-wp&frame=find-replace`   |
| `36-shortcuts-light.png`     | `?evidence=36-wp&frame=shortcuts`      |
| `36-context-menu-light.png`  | `?evidence=36-wp&frame=context-menu`   |
| `36-track-changes-light.png` | `?evidence=36-wp&frame=track-on`       |

Chapter split/merge context menu frames live under `pr-evidence/304/` (#304).
