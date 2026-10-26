# coAuthor — MVP Spec

Owner: Brett Humphreys · Org: radiancelux · Status: Draft v1 (2026-10-25)

## 1. Summary

coAuthor is a bot-native collaborative word processor. Humans and AI agents co-write manuscripts asynchronously without overwriting each other, and coAuthor outputs publication-ready manuscripts: Amazon KDP print PDF, EPUB 3, and .docx. First user: a novelist prepping a manuscript.

## 2. Goals

- **MVP scope:** a complete drafting-to-publishing writing app (drafting editor, revisions, story notes and story bible, images, book design, reader-ready export) plus multi-agent real-time collaboration.
- Real-time/async co-editing with conflict-free merging (CRDT).
- Bots are first-class, named collaborators (identity, cursor color, comments, suggestions).
- **Native MCP server ships in the MVP**: any agent (e.g. Grok Bot) connects like a connector, with per-agent identity.
- Bots never silently overwrite: changes by default are suggestions a human accepts/rejects.
- Structured manuscript model (front matter, chapters, scenes, styles).
- One-click export to KDP-ready PDF (6x9, 5.5x8.5), EPUB 3, .docx.
- Professional book themes with page preview.

## 3. Non-goals (MVP)

- Multi-tenant SaaS billing, teams/orgs admin, public sign-up.
- Built-in LLM hosting (agents bring their own model via MCP/API).
- Cover design, ISBN management, direct KDP upload.
- Mobile apps, offline-first desktop app.
- Image-heavy layouts (picture books, comics), footnote-heavy nonfiction.
- Full Word-style track-changes fidelity on .docx import.

## 4. User stories

**Novelist (human)**

- As a novelist, I import my existing .docx and see it split into chapters and scenes.
- I write and edit while a bot works on another chapter, and nothing I type gets lost.
- I see bot suggestions inline (insert/delete marks, attributed and colored) and accept or reject each, or all from one bot.
- I read and reply to bot comments in a sidebar.
- I choose a theme and trim size, preview real pages, and export a KDP PDF that passes KDP's previewer, plus EPUB and .docx.
- I control which bots can access the manuscript and what they may do (comment-only, suggest, edit).

**Bot (agent via MCP)**

- As an agent, I connect with my own token and appear as "Grok Bot" with my own color.
- I list documents and chapters and read chapter text with stable anchors.
- I leave a comment anchored to a passage.
- I propose an edit as a tracked suggestion; the human decides.
- I suggest paragraph styles (e.g. scene break, epigraph) and can trigger a local export.
- I can never accept or reject suggestions; only the human can.

## 5. Architecture

coAuthor is a local-first Tauri desktop app (Windows first). Everything runs on the author's
machine; there is no hosted server.

```
Tauri window: Vue 3 + Tiptap/ProseMirror + y-prosemirror
        │  Tauri commands / events
        ▼
Rust backend (in-process)
  ├─ storage: SQLite in the app data dir (metadata, Yjs updates/snapshots, comments, audit log)
  │           + files (imports, exports, backups, fonts)
  ├─ MCP server: Streamable HTTP on 127.0.0.1 only  ◄── local agents (bearer token per agent)
  └─ export: ProseMirror JSON → manuscript AST → Typst (PDF) / Pandoc (EPUB3, .docx)
Optional: Yjs sync provider for multi-device / remote collaboration (post-P1).
```

- One Yjs doc per section (chapter/scene), addressed as `manuscript/{id}/section/{sid}`, plus a
  manuscript doc for metadata and outline. Sections load, persist and sync independently, which
  also limits the blast radius of agent activity.
- Agent activity flows through the same Yjs path as human edits (origin = agent id), but agents can
  only add comments and suggestions; they never change accepted text.
- Suggestions are ProseMirror marks (`suggestion_insert`, `suggestion_delete`, `format_change`)
  with author/id attributes, stored in the CRDT. Accepting or rejecting is a human-only action in
  the UI.

## 6. Stack choices

| Area            | Choice                                             | Rationale                                                    |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| Shell           | Tauri v2 (Rust)                                    | Small native installer (.msi/NSIS), local file + SQLite I/O. |
| Frontend        | Vue 3 + Vite + TS                                  | Brett's strength; Tiptap has first-class Vue 3 bindings.     |
| Editor          | Tiptap (ProseMirror)                               | Schema control, marks for suggestions, ecosystem.            |
| CRDT            | Yjs + y-prosemirror                                | Mature, ProseMirror binding, offline-first.                  |
| Storage         | SQLite (rusqlite) + files in the app data dir      | Local-first, single file DB, easy backup.                    |
| MCP             | In-app server on 127.0.0.1 (Streamable HTTP)       | Local agents connect like any MCP connector.                 |
| PDF typesetting | **Typst**                                          | See below.                                                   |
| EPUB3 / .docx   | Pandoc                                             | Mature converters; reference.docx and EPUB CSS for theming.  |
| Auth            | Single local user; per-agent bearer tokens         | Minimal for P1.                                              |
| Distribution    | Unsigned Windows installer built in GitHub Actions | Signing deferred.                                            |

**Typst vs Paged.js → Typst.** Typst is a deterministic, fast, single-binary typesetter with native
support for page sizes, mirrored margins, odd/even running headers, page-number control, embedded
OTF fonts, and widow/orphan handling; it produces PDF directly with no headless browser. Paged.js
depends on Chromium print, whose PDF output and fragmentation are less predictable and slower for
300+ page books. Trade-off: preview uses Typst-rendered page images or SVG rather than DOM, so the
preview exactly matches the print file.

## 7. Data model (SQLite + Yjs)

- **Agent**(id, name, color, created_at, revoked_at)
- **AgentToken**(id, agent_id, hashed_token, scopes, last_used_at). Scopes are a subset of
  `read`, `comment`, `suggest`.
- **Manuscript**(id, title, subtitle, author_name, theme_id, trim_size default 6x9, settings json)
- **Section**(id, manuscript_id, kind: front_matter, part, chapter, scene, back_matter; parent_id,
  position, title, doc_id)
- **Yjs docs**: manuscript doc (`meta` Y.Map, `structure` Y.Array of section refs); one doc per
  section holding a Y.XmlFragment. Updates and snapshots are stored in SQLite.
- **ProseMirror schema**: paragraph (style: body, first, block_quote, epigraph, verse, centered),
  heading, scene_break, page_break; inline: hard_break, `footnote(id, kind, text, content)`
  (footnote or endnote with rich paragraphs), `image(alt)` placeholder; marks: italic, bold,
  smallcaps, underline, strike, link, `comment_anchor(id)`, `suggestion_insert(id, author, ts)`,
  `suggestion_delete(id, author, ts)`, `format_change(id, author, attrs)`. Types live in
  `@coauthor/schema` (`content.ts`). In Yjs, comment and suggestion marks are keyed `type--hash`
  so overlapping ranges don't clobber each other. Agent reads expose notes as `[^id]` markers
  plus a notes list (`readView`).
- **Comment**(id, section_id, anchor, author principal, body, thread_id, resolved_at)
- **Suggestion** index (id, section_id, author principal, kind, status: open, accepted, rejected;
  decided_at, summary). CRDT marks are the source of truth; the table is a queryable index.
  Decisions are always made by the human.
- **Theme**(id, name, typst_template, epub_css, reference_docx, fonts, options json)
- **Export**(id, manuscript_id, format, trim, theme_id, status, file_path, log, created_at)
- **AuditEvent**(id, manuscript_id, principal, action, payload, ts): every agent tool call.

## 8. Native MCP server (first-class MVP feature)

The app runs its own MCP server at `http://127.0.0.1:<port>/mcp` (Streamable HTTP), listening on
loopback only. Local agents connect to it like any connector.

**Identity.** Each agent gets its own bearer token, created by the author in Settings → Agents,
shown once, hashed at rest, revocable. The token maps to an Agent principal with name and color,
so every comment and suggestion is attributed to that agent and recorded in the audit log. P1
agent: Grok Bot.

**Permissions.** Agents can only `read`, `comment` and `suggest`. There is no scope for direct
edits or for deciding suggestions: accepting or rejecting a suggestion is human-only and is not
exposed over MCP.

**Tools.**

| Tool                                                                       | Purpose                                                        | Scope          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------- |
| `list_documents`                                                           | Manuscripts available locally                                  | read           |
| `list_chapters(manuscript_id)`                                             | Ordered parts/chapters/scenes with ids, kinds, word counts     | read           |
| `read_chapter(manuscript_id, section_id, format=markdown\|json)`           | Text with stable block ids, plus open suggestions and comments | read           |
| `search_text(manuscript_id, query)`                                        | Find passages; returns anchors                                 | read           |
| `list_suggestions(manuscript_id, status?, author?)`                        | Review queue                                                   | read           |
| `add_comment(section_id, anchor, body, thread_id?)`                        | Anchored comment or reply                                      | comment        |
| `suggest_edit(section_id, anchor, replacement, rationale)`                 | Tracked insert/delete suggestion; never applied silently       | suggest        |
| `suggest_style(section_id, block_id, style)`                               | Paragraph style change, recorded as a format suggestion        | suggest        |
| `trigger_export(manuscript_id, format=pdf\|epub\|docx, trim?)`             | Starts a local export; returns export id and file path         | read           |
| `list_notes` / `write_note(manuscript_id, title, body)`                    | Planning/working notes                                         | read / comment |
| `list_story_bible` / `suggest_story_bible_entry(kind, name, fields, body)` | Story bible entries; agent entries are suggestions             | read / suggest |

Resources: `coauthor://manuscript/{id}/section/{sid}` (read-only text). Anchors use quoted text +
block id so they survive concurrent edits; the server resolves them to Yjs relative positions and
errors if ambiguous or stale. Every call is written to AuditEvent.

**Implementation.** The server is Rust inside the Tauri process, built on `rmcp` (the official
MCP Rust SDK) with axum, on port 7337 by default. Reasons over a TypeScript sidecar: one process
and no Node runtime to bundle or supervise; it shares the app's SQLite connection and Yjs
documents directly instead of over IPC; tokens are checked in the same place they are stored.
The cost is a Rust reading of the Yjs content model (`src-tauri/src/content.rs`), which is kept
in step with the TypeScript encoder by the shared fixture in `fixtures/mcp/`. The server runs
stateless (JSON responses, no sessions). Before any token lookup it requires `Host` to be
exactly `127.0.0.1`, `localhost` or `[::1]` plus its port (DNS-rebinding guard). Any request
with an `Origin` header gets 403, so browser-based clients (web pages, browser extensions using
fetch) cannot connect; agents connect from a local process. Missing, malformed, unknown and
revoked tokens all get the same 401 (`WWW-Authenticate: Bearer`) after the same minimum delay.
Wrong tokens count toward a global throttle (429); requests without a token do not. Once the
wrong-token budget is spent, only tokens that authenticated before (plus one probe at a time for
others) are looked up, so a valid token keeps working. Token lookups are capped at 4 at a time and
authenticated requests at 64 in flight (extra requests wait). The `Bearer` scheme is matched
case-insensitively, and each valid token is rate limited. `list_chapters` / `read_chapter` return every section kind (front
matter, parts, chapters, scenes, back matter), not only chapters.

## 9. Export requirements (KDP)

**PDF (Typst)**

- Trims: 6x9 in and 5.5x8.5 in, no bleed (text-only interior).
- Margins: gutter (inside) scales with page count per KDP (24–150 pp: ≥0.375"; 151–300: ≥0.5"; 301–500: ≥0.625"; 501–700: ≥0.75"; 701–828: ≥0.875"); outside/top/bottom ≥0.25" (we default 0.5–0.75").
- Mirrored running heads: verso = author, recto = book title (or chapter title); none on chapter openers and front matter; folios outside or centered bottom; front matter roman/no numbers, body arabic from 1.
- Chapters open on recto (configurable), blank versos inserted, no header on blanks.
- Drop caps (and small-caps lead-in) on chapter openers; scene-break glyph or ornament; first paragraph after break not indented.
- Widow/orphan control; avoid hyphenation of last line on page; justified text with hyphenation (language-aware).
- All fonts embedded (OFL fonts bundled: e.g. EB Garamond, Crimson Pro, Libre Baskerville); PDF/X not required but no transparency issues; min font 7pt.
- Generated TOC optional (usually omitted for novels in print); title, copyright, dedication pages.
- Built-in **print preflight** (gutter vs actual page count, fonts embedded, min font size, missing images, front-matter placement, trim/bleed sanity) runs before every PDF export and is exposed via MCP.
- Acceptance: passes KDP Print Previewer with no errors for both trims.

**EPUB 3 (Pandoc)**: **every export validated with EPUBCheck in the worker (fail = export marked failed with report)**; nav TOC; semantic front matter (epub:type); theme CSS; embedded fonts optional; scene breaks as `<hr class="scene-break">` with accessible fallback; metadata (title, author, language, identifier).

**.docx (Pandoc)**: reference.docx styles mapped from manuscript styles (for agents/editors/Word users); page breaks between chapters; standard manuscript format option (12pt, double-spaced) as an alternative theme.

## 10. Milestones

- **M0 — Repo & scaffold**: pnpm monorepo, Tauri desktop shell, SQLite storage, CI with Windows build.
- **M1 — Editor + Yjs**: Tiptap editor, Yjs with local persistence and autosave, parts/chapters/scenes.
- **M2 — Bot collaborators + suggestions + native MCP server**: agent identity/tokens, suggestion marks & review UI, comments, MCP server with full tool surface, permissions, audit.
- **M3 — Manuscript structure**: sections/chapters model, front matter, scene breaks, styles, .docx import.
- **M4 — Export pipeline**: AST, Typst PDF (both trims), Pandoc EPUB3/.docx, export jobs (incl. MCP trigger_export).
- Story notes/story bible in M3, images and character messages in M3/M4, revisions in M2.
- **M5 — Themes, page preview & first-user pilot**: 3 themes, page preview, KDP previewer validation, pilot with first novelist.

## 10a. Phased timeline (Linear labels "coAuthor P1..P4")

Implementation is local (no cloud agents approved). First user is on **Windows**.

- **P1 — Fri 10/30: first usable build = unsigned Windows dev build (Tauri, .msi/NSIS)** with local sidecar: editor + Yjs, parts/chapters/scenes, autosave, .docx import, comments + tracked changes, native MCP with per-agent identity, backup download. (RAD-200–205, 209–212, 214, 218, 221, 224)
- **P2 — ~11/6:** Notes + Story Bible, human roles, images, revisions. (RAD-213, 215–217)
- **P3 — ~11/13:** book design (themes, drop caps, ornaments, headers), KDP 6x9/5.5x8.5 PDF + EPUB + .docx export, preview. (RAD-219, 222, 226, 227)
- **P4 — ~11/20:** KDP preflight + EPUBCheck, message bubbles, templates, signed desktop installer and auto-update, polish, pilot. (RAD-223, 225, 228)

## 11. Risks

- P1 in 5 days is very aggressive for MCP + tracked changes + Windows packaging; tracked changes may land as "basic" in P1.
- Suggestion marks + CRDT merge edge cases (overlapping suggestions, concurrent accept/reject).
- Anchor stability for agents editing text that humans are changing.
- Typst theme authoring effort; preview fidelity vs editor view.
- KDP gutter/page-count interplay requires two-pass layout.
- .docx import fidelity (italics, scene breaks, odd styles in real manuscripts).
- Security of agent tokens; agents spamming suggestions.
- Scope creep (MCP + typesetting + editor is a lot for one dev).

## 12. Open questions for Brett

1. Resolved: local-first single-user desktop app (Tauri, Windows first); optional Yjs sync later.
2. Resolved: Typst for print; Vue 3 for the UI.
3. Resolved: agents are strictly read/comment/suggest; accept/reject is human-only.
4. Resolved: Grok Bot for P1, with a bearer token per agent; other MCP clients later.
5. Resolved: the first author's manuscript is a .docx (or other) file; .docx import is P1-critical; default trim 6x9.
6. Need ebook-only features (KDP Kindle via EPUB) for pilot, or print first?

## 14. Differentiators

- Unlimited named agent collaborators, each with own identity, color, live cursor (Yjs real-time).
- Human approval of every agent change (agents comment/suggest only), per agent, with audit log.
- Native MCP server as a first-class product surface.
- Open source, local-first; runs entirely on the author's machine.
- KDP print PDF + EPUB 3 + .docx from one model, with print preflight and EPUBCheck validation.
