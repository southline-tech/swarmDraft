# PR evidence — #34 install + first-run (Batch B / B3)

In-app PNGs use shipping Vue components at **1280×800** (Chromium headless). **No HTML mockups. No fake installer PNGs.**

## Capture (Linux / CI)

```bash
node pr-evidence/34/capture.mjs
```

Starts `pnpm dev:web` on port 1420, screenshots, then stops dev.

| Capture                         | How                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------- |
| C5, C7–C9, errors, empty panels | `?evidence=34-install&frame=…&theme=light\|dark`                              |
| **C6** second launch            | `?evidence=34-c6` → sets `swarmdraft.welcomed`, redirects into real `App.vue` |
| **C8** save failure             | `frame=c8-editor-save-failure` — full editor shell + banner                   |

## Evidence index C1–C10

| ID      | What                                    | Status                                           |
| ------- | --------------------------------------- | ------------------------------------------------ |
| **C1**  | Installer Welcome (ob1)                 | **Manual — Brett, Windows**                      |
| **C2**  | Installer Progress (ob2)                | **Manual — Brett, Windows**                      |
| **C3**  | Installer Finish (ob3)                  | **Manual — Brett, Windows**                      |
| **C4**  | Desktop + Start menu shortcuts          | **Manual — Brett, Windows**                      |
| **C5**  | First-run welcome + focus ring          | **Captured** — `c5-first-run-welcome-*.png`      |
| **C6**  | Second launch (real App, welcomed flag) | **Captured** — `c6-second-launch-open-light.png` |
| **C7**  | Empty review panel                      | **Captured** — `c7-empty-review-light.png`       |
| **C8**  | Save-failure in editor shell            | **Captured** — `c8-save-failure-*.png`           |
| **C9**  | “Saved just now” status                 | **Captured** — `status-saved-just-now-light.png` |
| **C10** | Taskbar / title-bar icon                | **Manual — Brett, Windows**                      |

## Brett — Windows: build, UAC, C1–C4, C10

On a **clean non-admin Windows** account:

```powershell
cd path\to\swarmDraft
pnpm install
pnpm tauri build
```

Installer: `apps\desktop\src-tauri\target\release\bundle\nsis\swarmDraft_*_x64-setup.exe`

1. Run setup; confirm **no UAC prompt** (per-user install; this PR does not change `tauri.conf.json`).
2. **C1–C3:** Screenshot Welcome (**Install swarmDraft**), Progress, Finish (**Open swarmDraft now** checked).
3. **C4 / C10:** Shortcuts and optional taskbar/title-bar shots.
4. Post **UAC result** on the PR; attach installer PNGs to the PR only (do not commit here).

NSIS header/sidebar BMPs use the **simplified three-hex mark** (`icons/source/generate.py`). Per-user install skips license, directory, and components pages.
