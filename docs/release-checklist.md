# Release checklist (#34 pilot gate)

Designer and PM sign-off before the author receives a pilot build. Record sign-off in this file (date, commit SHA, installer link). Do not tag the release in git; Brett tags the pilot release.

## Pre-flight

- [ ] Latest `main` merged; `pnpm lint`, `format:check`, `typecheck`, `test`, `build`, and Rust checks green on the release commit.
- [ ] `pnpm copy:check` (jargon gate) passes.
- [ ] Copy deck reviewed: `apps/desktop/src/copy-deck.ts` matches mockups and issue copy decisions.

## Screen and flow checks (1280×800 or larger, real app — `pnpm tauri dev`)

Capture one screenshot per row in `pr-evidence/34-41/` (no mockups). Compare each screen to its mockup frame where the issue links one.

| #   | Check                                  | Evidence                         |
| --- | -------------------------------------- | -------------------------------- |
| 1   | Home welcome (first run)               | `welcome.png`                    |
| 2   | Import / open book                     | `import.png`                     |
| 3   | Opening progress while import runs     | `opening-progress.png`           |
| 4   | Editor with manuscript loaded          | `editor.png`                     |
| 5   | Autosave / save status in footer       | `save-status.png`                |
| 6   | Reopen last book after restart         | `reopen.png` (manual note in PR) |
| 7   | Save and reopen a `.draft`             | `draft.png` (manual note in PR)  |
| 8   | In-app update prompt (#310)            | `update-prompt.png`              |
| 9   | Error cards (plain language, ob9)      | `error-card.png`                 |
| 10  | Empty states (review, comments, notes) | `empty-states.png`               |
| 11  | Settings › Export (EPUB / Word)        | `export-settings.png`            |
| 12  | Pairing / Agents settings              | `agents.png`                     |

## Install and data safety

- [ ] Clean **non-admin** Windows account: installer completes (Batch B ob1–ob3).
- [ ] First run welcome → import real Word manuscript; **original Word file unchanged** on disk.
- [ ] Autosave and reopen last book behave per `docs/qa/install-first-run-checklist.md`.

## Sign-off

| Role     | Name | Date | Commit | Installer / artifact link |
| -------- | ---- | ---- | ------ | ------------------------- |
| Designer |      |      |        |                           |
| PM       |      |      |        |                           |

**Notes:**

- Code signing / SmartScreen: tracked separately on #34 if not in this build.
- KDP print PDF + EPUB preflight: see pilot gaps in `docs/pilot-flow.md` if not on `main`.
