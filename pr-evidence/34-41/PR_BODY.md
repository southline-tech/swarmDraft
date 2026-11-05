## Summary

- Centralize writer-facing strings in `apps/desktop/src/copy-deck.ts`; key Vue surfaces import the deck (#34).
- Add `scripts/check-copy-jargon.mjs`, `pnpm copy:check`, CI step, and tests that prove the gate fails on banned jargon (`.docx`, sync, database, MCP — **not** “import”).
- Add `docs/release-checklist.md`, `docs/pilot-flow.md` (#41 pilot scope), and real-app screenshots in `pr-evidence/34-41/`.
- Review follow-ups: opening progress track token + 10px height, `home__secondary` focus ring, pairing dialog titles in deck, toolbar export “Open folder” from deck, file picker `accept` uses Word MIME (not `.docx` in templates).

## Linked issues

Part of #34 (copy deck, jargon CI, release checklist, and pilot evidence; code signing / SmartScreen remains on #34)

Part of #41 (pilot flow + release gate docs; **template marketplace** and **self-hosted relay** remain After MVP — leave #41 open for those)

## #34 / #41 item status vs `main`

| Item                                                       | Status                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Copy deck centralized                                      | **Done here** — `copy-deck.ts` + scope test; shortcuts sheet chrome strings still deferred      |
| Banned list (`.docx`, sync, database, MCP; import allowed) | **Done here** — `docs/copy-deck-banned.txt`                                                     |
| Jargon CI                                                  | **Done here** — `pnpm copy:check`, workflow step, `copy-jargon.test.mjs`                        |
| Release checklist                                          | **Done here** — `docs/release-checklist.md`                                                     |
| Evidence PNGs (1280×800+)                                  | **Done here** — ten files under `pr-evidence/34-41/` via `node scripts/copy-34-41-evidence.mjs` |
| Pilot flow doc                                             | **Done here** — `docs/pilot-flow.md`                                                            |
| Code signing / SmartScreen                                 | **Left out** — tracked on #34 separately                                                        |
| #41 bot templates / self-host                              | **Out of scope (After MVP)** — #41 stays open                                                   |

## Acceptance criteria

### #34 — copy deck & release gate

| Item                        | Status                       | Evidence                                                                                  |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| Banned jargon list          | Done                         | `docs/copy-deck-banned.txt`                                                               |
| Writer strings in copy deck | Done (gate + batch surfaces) | `copy-deck.ts`; `copy-deck-scope.test.ts`                                                 |
| Jargon CI gate              | Done                         | `.github/workflows/ci.yml`, `scripts/copy-jargon.test.mjs`, `ci/copy-jargon-gate.test.ts` |
| Release checklist           | Done                         | `docs/release-checklist.md`                                                               |
| Evidence screenshots        | Done                         | `pr-evidence/34-41/*.png` (10 files)                                                      |
| No real person names        | Done                         | review of changed files                                                                   |
| Full Vue string migration   | Partial                      | shortcuts sheet chrome deferred                                                           |

### #41 — pilot

| Item                            | Status       | Evidence                        |
| ------------------------------- | ------------ | ------------------------------- |
| Pilot flow documented           | Done         | `docs/pilot-flow.md`            |
| KDP PDF / EPUB gaps for Brett   | Done         | `docs/pilot-flow.md` gaps table |
| Bot templates / self-host relay | Out of scope | this PR + leave #41 open        |

- [x] **AC:** Jargon check passes in CI — `pnpm copy:check`, test `copy jargon check (#34)`
- [x] **AC:** Jargon check fails on banned word — test `fails when a banned word appears in copy-deck.ts`
- [x] **AC:** Release checklist rows have PNG evidence — ten PNGs in `pr-evidence/34-41/` (rows 1–5, 8–12); rows 6–7 manual below
- [x] **AC:** Pilot happy path documented — `docs/pilot-flow.md`

## Decisions from issue comments

- “Import” is allowed for Word files (#301); not in banned list.
- Banned terms: `.docx`, sync, database, MCP.
- No real person names in strings, docs, or tests (#307).
- #41 template marketplace and self-hosted relay: After MVP.
- `exportCopy.pandocIntro` still mentions PATH for advanced Pandoc override — intentional technical settings copy; defer softer wording unless Designer requests.

## Mockups

Screenshot rows compared to merged batch evidence (34, 36, 299, 310, 39, 192). Designer sign-off row in `docs/release-checklist.md` pending human review of deck + PNGs.

## Test plan

Commands on pushed head (`feat/34-41-pilot-gate`):

- [x] `pnpm install --frozen-lockfile`
- [x] `node scripts/check-copy-jargon.mjs` / `pnpm copy:check`
- [x] `pnpm lint`
- [x] `pnpm format:check` (Prettier on changed sources)
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` in `apps/desktop/src-tauri`

**Test counts:**

| Package / area                     | Tests                   |
| ---------------------------------- | ----------------------- |
| root (`node --test` + site vitest) | 42 + 26 site            |
| `@swarmdraft/desktop`              | 1058 passed, 10 skipped |
| `@swarmdraft/editor`               | 181                     |
| `@swarmdraft/schema`               | 11                      |
| `@swarmdraft/docx`                 | 67                      |
| Rust (`cargo test --locked`)       | 287 passed, 2 ignored   |

## Open PR overlap

Checked via `gh pr list --state open` before push — coordinate if another PR touches `HomeScreen.vue` / install QA before pilot tag.

## Checklist

- [x] Applicable `docs/review-checklist.md` items satisfied on pushed head
- [ ] Designer sign-off recorded in `docs/release-checklist.md` (awaiting review)

## Manual evidence (checklist rows 6–7)

- **Reopen last book after restart:** per `docs/qa/install-first-run-checklist.md` on pilot build.
- **Save and reopen `.draft`:** same on pilot build.

## Pilot gaps for Brett (not built here)

- KDP-ready print PDF may be “coming later” in UI.
- EPUB export / EPUBCheck pipeline may be incomplete — confirm before pilot tag.

## Follow-ups (non-blocking)

- Shortcuts sheet chrome strings still outside `copy-deck.ts`.
