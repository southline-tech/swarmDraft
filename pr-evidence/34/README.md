# PR evidence — #34 Batch B (install + first-run shell)

Viewport **1280×800** (matches default app window). Capture in-app scenes with `./capture.sh` (Chromium headless).

| File                            | Frame                      |
| ------------------------------- | -------------------------- |
| `welcome-ob4-light.png`         | ob4 first-run welcome      |
| `save-failure-banner-light.png` | RAD-271 / ob9 save failure |
| `empty-review-ob8-light.png`    | ob8 review empty state     |

**Installer ob1–ob3 (Windows):** build `pnpm tauri build` on Windows, run the per-user setup exe, screenshot Welcome / Progress / Finish. Reference art from `pr-evidence/296/installer-header.png` (header strip) until Batch G attaches fresh ob1–ob3 PNGs here.

**Live app (optional):** `pnpm dev` in `apps/desktop`, cold profile (clear `swarmdraft.welcomed` in devtools), 1280×800 — welcome and open screen match `HomeScreen.vue`.
