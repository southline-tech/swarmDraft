# AGENTS.md — swarmDraft

Windows-first Tauri desktop manuscript editor: Vue 3 + Tiptap + Yjs frontend, Rust backend with local SQLite and an in-app localhost MCP server for agents (per-agent tokens). Read `docs/review-checklist.md` before asking for review.

## Project map

| Path                                                   | Area                                                                                                       | Owner               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------- |
| `apps/desktop/src/`                                    | Vue app: editor, outline (`SectionNav`), `review/`, `comments/`, `toolbar/`, `desk/`, `status/`, `styles/` | Frontend            |
| `apps/desktop/src/backend.ts`, `manuscript-session.ts` | IPC wrapper and session/save wiring (shared; owner set per issue)                                          | Frontend by default |
| `apps/desktop/src-tauri/src/`                          | Rust: `storage.rs`, `manuscripts.rs`, `agents.rs`, `mcp/`, `backup.rs`, `content.rs`, `anchor.rs`          | Backend             |
| `packages/editor`                                      | Tiptap extensions, review marks, trusted accept/reject (`@coauthor/editor/trusted`)                        | Frontend            |
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
2. Before asking for review:
   - merge `main` in and resolve conflicts;
   - run every command above;
   - self-check against the issue's acceptance criteria, `docs/design-system.md` (UI), any mockup link on the issue, and `docs/review-checklist.md`.
3. PR body: what changed, how it was tested, which checklist items apply. Use `Closes #N` for a small fix that finishes an issue, `Part of #N` for an epic or partial work.
4. **Review:** run the automated review bot on the PR diff; fix findings and re-run until clear. Human reviewer optional for tricky areas. Routine UI PRs do **not** wait on a separate Designer pass — treat `docs/design-system.md` plus issue copy as the design spec. Epic **release gates** (e.g. #34 installer sign-off) may still need PM/author QA before shipping a build.
5. **Every review, design or QA finding → add a lessons-learned line** to the "Review learnings" section of `docs/review-checklist.md` in the same PR, before asking for re-review (format: `YYYY-MM-DD · #PR · finding · rule`).
6. Fix, re-run all checks, push. Re-review covers only what changed since the last cleared commit.
7. After review bot clear and CI green, hand off for merge. Implementors never merge.

## Product rules that are never negotiable

- **Bots are suggest-only.** Agent edits arrive as suggestion/comment marks; only a human accept (through `review/apply.ts` → trusted path) changes text. Nothing silently edits manuscript text.
- **No lost text.** Every edit must survive save, section switch, reload and app restart. Remote/agent updates use `Y.applyUpdate(doc, u, REMOTE_ORIGIN)`; never replace a snapshot.
- **Tokens are secrets.** Never log, return or render agent tokens; `agents_list` returns no token.
- **No competitor product names, parity lists or competitive analysis** in code, docs, commits, branch names, issues or PRs.
- No personal data (real names) hard-coded.
