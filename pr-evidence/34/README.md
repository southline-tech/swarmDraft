# PR #312 evidence — #34 Batch B (real app captures)

In-app PNGs come from shipping Vue components via dev harness  
`http://localhost:1420/?evidence=34-install&frame=…&theme=light|dark`  
(`apps/desktop/src/evidence/Rad34InstallEvidence.vue`).

**Viewport:** 1280×800 (Chromium headless).

## Capture

```bash
node pr-evidence/34/capture.mjs
```

Starts `pnpm dev:web` on port 1420, screenshots, then stops dev. Requires Chrome/Chromium. **No HTML mockups. No fake installer PNGs.**

## Evidence index C1–C10

| ID      | What                                       | Status                                           |
| ------- | ------------------------------------------ | ------------------------------------------------ |
| **C1**  | Installer Welcome (ob1)                    | **Manual — Brett, Windows**                      |
| **C2**  | Installer Progress (ob2)                   | **Manual — Brett, Windows**                      |
| **C3**  | Installer Finish (ob3)                     | **Manual — Brett, Windows**                      |
| **C4**  | Desktop + Start menu shortcuts             | **Manual — Brett, Windows** (no UAC)             |
| **C5**  | First-run welcome + Get started focus ring | **Captured** — `c5-first-run-welcome-*.png`      |
| **C6**  | Second launch open screen                  | **Captured** — `c6-second-launch-open-light.png` |
| **C7**  | Empty review panel                         | **Captured** — `c7-empty-review-light.png`       |
| **C8**  | Save-failure banner                        | **Captured** — `c8-save-failure-*.png`           |
| **C9**  | “Saved just now” status                    | **Captured** — `status-saved-just-now-light.png` |
| **C10** | Taskbar / pinned icon                      | **Manual — Brett, Windows**                      |

Also: five ob9 error cards, comments + story-notes empty states.

## Brett — Windows installer + UAC

Linux/CI **cannot** run NSIS. On a **clean non-admin Windows** account:

1. Build or download `swarmDraft_*_x64-setup.exe` from this branch.
2. Run installer; confirm **no UAC prompt** (`installMode: currentUser`).
3. Screenshot ob1–ob3 (C1–C3) at ≥1280×800.
4. Verify Desktop + Start menu shortcuts (C4); optional taskbar (C10).
5. Record **UAC result** on PR #312. Attach installer screenshots to the PR; do not commit installer PNGs here.
