# AGENTS.md — swarmDraft

Windows-first Tauri desktop manuscript editor: Vue 3 + Tiptap + Yjs frontend, Rust backend with local SQLite and an in-app localhost MCP server for agents (per-agent tokens). Read `docs/review-checklist.md` before asking for review.

## Project map

| Path                                                   | Area                                                                                                       | Owner               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------- |
| `apps/desktop/src/`                                    | Vue app: editor, outline (`SectionNav`), `review/`, `comments/`, `toolbar/`, `desk/`, `status/`, `styles/` | Frontend            |
| `apps/desktop/src/backend.ts`, `manuscript-session.ts` | IPC wrapper and session/save wiring (shared; owner set per issue)                                          | Frontend by default |
| `apps/desktop/src-tauri/src/`                          | Rust: `storage.rs`, `manuscripts.rs`, `agents.rs`, `mcp/`, `backup.rs`, `content.rs`, `anchor.rs`          | Backend             |
| `packages/editor`                                      | Tiptap extensions, review marks, trusted accept/reject (`@swarmdraft/editor/trusted`)                      | Frontend            |
| `packages/schema`                                      | Shared document schema                                                                                     | Shared              |
| `packages/docx`                                        | .docx import/export                                                                                        | Backend             |
| `docs/design-system.md`                                | Tokens, components, themes (source of truth for UI)                                                        | Shared              |
| `docs/mvp-spec.md`                                     | Product scope                                                                                              | PM                  |

Only edit files in your area unless the issue says otherwise. Shared files: confirm no open PR touches them first.

## Commands (repo root, pnpm 9, Node ≥ 20)

```sh
pnpm install
pnpm lint            # eslint
pnpm format:check    # prettier
pnpm typecheck       # vue-tsc (desktop) / tsc (packages)
pnpm test            # vitest in every package
pnpm build
cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
pnpm dev             # tauri dev app; pnpm dev:web for browser only
```

All of these must pass before review. Report test counts per package in the PR.

## PR flow

1. Branch off latest `main`. One issue (or a batch of small related fixes) per PR. **No stacked PRs.**
2. **Ready gate** — do not mark a PR ready for review or re-review until every step passes (details mirror `docs/review-checklist.md` § Ready gate):
   - Merge or rebase onto latest `main`; run every command in **Commands** above; report test counts from the pushed head.
   - Read the linked issue body **and all issue comments** (and PM/Designer notes on the PR). Treat comment decisions as binding AC (defaults, copy, placement, mockup calls).
   - Self-check **every** acceptance criterion; tick each in the PR body with pass evidence (test name, manual step, or quote). Do not mark ready if any AC is open or only partly met.
   - For each behavior AC, name the test that proves it through real wiring; confirm new tests fail with the fix reverted (see checklist §3).
   - If the issue or comments link mockup frames, compare before coding and again before ready; list frame ids checked (or N/A).
   - List **open PRs** that touch the same files (`gh pr list` + diff paths). Rebase or note coordination if overlap exists (e.g. continuous view / outline).
   - UI: `docs/design-system.md`; tick applicable items in `docs/review-checklist.md`.
3. **PR body:** use the skeleton in `.github/PULL_REQUEST_TEMPLATE.md` (summary, AC checklist, issue-comment decisions, mockups, tests, open-PR overlap). `Closes #N` only when every issue AC is done; `Part of #N` for epics or partial work.
4. **Review:** run the automated review bot on the PR diff; fix findings and re-run until clear. Human reviewer optional for tricky areas. Routine UI PRs do **not** wait on a separate Designer pass — treat `docs/design-system.md` plus issue copy as the design spec. Epic **release gates** (e.g. #34 installer sign-off) may still need PM/author QA before shipping a build.
5. **One consolidated fix pass per review:** when PM, Designer, or the review bot leaves findings, fix **all** of them in one push (plus a Review learnings line per finding) before asking for re-review; do not drip-feed.
6. Re-run all checks after fixes. Re-review covers only what changed since the last cleared commit.
7. After review bot clear and CI green, hand off for merge. Implementors never merge.

## Product rules that are never negotiable

- **Bots are suggest-only.** Agent edits arrive as suggestion/comment marks; only a human accept (through `review/apply.ts` → trusted path) changes text. Nothing silently edits manuscript text.
- **No lost text.** Every edit must survive save, section switch, reload and app restart. Remote/agent updates use `Y.applyUpdate(doc, u, REMOTE_ORIGIN)`; never replace a snapshot.
- **Tokens are secrets.** Never log, return or render agent tokens; `agents_list` returns no token.
- **No competitor product names, parity lists or competitive analysis** in code, docs, commits, branch names, issues or PRs.
- No personal data (real names) hard-coded.
