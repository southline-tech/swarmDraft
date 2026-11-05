# PR evidence — #302 git-backed `.draft` file

Capture from `pnpm tauri dev` at 1280×800 or larger (Designer review):

- File menu (New, Open, Save, Save As, Import Word manuscript, History)
- Save As dialog
- Open `.draft`
- History panel and Restore confirm
- Bot branch merge (accept a bot suggestion, history shows merge)
- Migration result (first launch after upgrade)
- `.draft` icon in Explorer (Windows installer)

Screenshots are non-blocking per Brett if the build environment lacks Windows; list captures taken or mark follow-up.

Checklist (code / tests):

- [x] Open `.draft` hydrates SQLite from git (`hydrate_open_draft_loads_git_chapter_text`)
- [x] History Restore hydrates SQLite (`restore_hydrates_sqlite_from_git`) + App reload
- [ ] File menu screenshot (Windows)
- [ ] History panel screenshot (Windows)
