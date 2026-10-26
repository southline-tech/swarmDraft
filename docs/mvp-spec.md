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
- If granted, I apply paragraph styles (e.g. scene break, epigraph) and trigger an export and get a download link.
- I cannot accept my own suggestions unless the human explicitly granted that.

## 5. Architecture
```
Browser (Vue 3 + Tiptap/ProseMirror + y-prosemirror)
        │  WebSocket (Yjs sync + awareness)
        ▼
Collab server (Hocuspocus, Node/TS) ── persistence ──► Postgres (Yjs updates/snapshots, metadata)
        ▲                                          └──► Object storage (exports, fonts, imports)
        │ in-process Yjs doc access
API server (Fastify/TS): REST + **MCP server** (Streamable HTTP)  ◄── Agents (Grok Bot, Claude, etc.)
        │ job queue (pg-boss)
        ▼
Export worker: ProseMirror JSON → manuscript AST → Typst (PDF) / Pandoc (EPUB3, .docx)
```
- Single Yjs doc per manuscript; one Y.XmlFragment per chapter (keeps chapters loadable independently and reduces bot-edit blast radius).
- Bots edit via a server-side Yjs client so their changes flow through the same CRDT path as humans (with origin = agent id).
- Suggestions are ProseMirror marks (`suggestion_insert`, `suggestion_delete`) with author/id attributes, stored in the CRDT; accept/reject is a transaction.

## 6. Stack choices
| Area | Choice | Rationale |
|---|---|---|
| Frontend | Vue 3 + Vite + TS | Brett's strength; Tiptap has first-class Vue 3 bindings. |
| Editor | Tiptap 2/3 (ProseMirror) | Schema control, marks for suggestions, ecosystem. |
| CRDT | Yjs + y-prosemirror | Mature, ProseMirror binding, awareness for cursors. |
| Collab server | Hocuspocus | Yjs server with auth hooks, persistence, server-side doc access. |
| API + MCP | Node/TS, Fastify, official `@modelcontextprotocol/sdk` (Streamable HTTP) | Same language as collab server; shared schema code. |
| DB | Postgres (+ pg-boss for jobs) | One datastore for metadata, Yjs state, and the queue. |
| Storage | S3-compatible (local MinIO/disk in dev) | Exports, fonts, imports. |
| PDF typesetting | **Typst** | See below. |
| EPUB3 / .docx | Pandoc | Best-in-class converters; reference.docx and EPUB CSS for theming. |
| Auth | Email magic link / single-owner for pilot; per-agent tokens | Minimal for pilot. |
| Hosting | Single VPS / Fly.io with Docker Compose | Cheap, simple. |

**Typst vs Paged.js → Typst.** Typst is a deterministic, fast (sub-second for a novel), single-binary typesetter with native support for page sizes, inside/outside (mirrored) margins, odd/even running headers, page-number control, embedded OTF fonts, and widow/orphan handling; it produces PDF directly with no headless browser. Paged.js depends on Chromium print, whose PDF output, font embedding, and fragmentation (widows/orphans, blank-verso insertion, drop caps across page breaks) are less predictable and slower for 300+ page books. Trade-off: Typst themes aren't CSS, so preview uses Typst-rendered page images (or Typst's SVG output) rather than DOM; we accept that because the preview then exactly matches the print file. Revisit if theme authoring in Typst proves too costly.

## 7. Data model
- **User**(id, name, email, color)
- **Agent**(id, name, color, avatar, owner_user_id, created_at, revoked_at)
- **AgentToken**(id, agent_id, hashed_token, scopes[], manuscript_ids[] | all, last_used_at)
- **Manuscript**(id, title, subtitle, author_name, owner_id, theme_id, trim_size, settings json, yjs_doc_id)
- **Membership**(manuscript_id, principal_type user|agent, principal_id, role: owner|editor|suggester|commenter|viewer, can_self_accept=false)
- **Yjs doc** (per manuscript): `meta` Y.Map; `structure` Y.Array of sections {id, kind: front_matter|chapter|part|back_matter, subtype: title|copyright|dedication|toc|epigraph|acknowledgments|about_author, title, fragmentKey}; one Y.XmlFragment per section.
- **ProseMirror schema**: doc > section blocks: paragraph(style: body|first|block_quote|epigraph|verse|centered), heading(level), scene_break, page_break; marks: italic, bold, smallcaps, link, `comment_anchor(id)`, `suggestion_insert(id, author, ts)`, `suggestion_delete(id, author, ts)`, `format_change(id, author, attrs)`.
- **Comment**(id, manuscript_id, section_id, anchor (Yjs relative positions), author principal, body, thread_id, resolved_at)
- **Suggestion** index (id, manuscript_id, section_id, author principal, kind, status: open|accepted|rejected, decided_by, decided_at, summary) — CRDT marks are source of truth; table is a queryable index.
- **Theme**(id, name, typst_template, epub_css, reference_docx, fonts[], options json: drop_caps, scene_break_glyph, chapter_heading_style, header/footer content)
- **ExportJob**(id, manuscript_id, format pdf|epub|docx, trim, theme_id, requested_by principal, status, artifact_url, log, created_at)
- **AuditEvent**(id, manuscript_id, principal, action, payload, ts) — every agent tool call.

## 8. Native MCP server (first-class MVP feature)
coAuthor ships its own MCP server at `https://<host>/mcp` (Streamable HTTP, MCP spec 2025-06-18+). Agents connect to it like any connector.

**Identity.** Each agent gets its own token (created by the human in Settings → Agents; shown once; hashed at rest; revocable). The token maps to an Agent principal with name and cursor color, so all edits, comments, and suggestions are attributed to that agent, visible in awareness (presence/cursor) and in the audit log. OAuth 2.1 (MCP auth spec) is a post-MVP upgrade; bearer tokens are MVP.

**Permissions.** Scopes: `read`, `comment`, `suggest`, `edit_direct`, `style`, `export`, `decide`. Default for a new agent: read+comment+suggest. `decide` (accept/reject) is human-gated by default: an agent can only accept/reject when the owner explicitly grants `decide`, and never its own suggestions unless `can_self_accept` is set.

**Tools.**
| Tool | Purpose | Scope |
|---|---|---|
| `list_documents` | Manuscripts the agent can access | read |
| `list_chapters(manuscript_id)` | Ordered sections with ids, kinds, titles, word counts | read |
| `read_chapter(manuscript_id, section_id, format=markdown|json)` | Text with stable block ids/anchors, plus open suggestions and comments | read |
| `search_text(manuscript_id, query)` | Find passages; returns anchors | read |
| `add_comment(section_id, anchor, body, thread_id?)` | Anchored comment/reply | comment |
| `suggest_edit(section_id, anchor/range, replacement, rationale)` | Tracked insert/delete suggestion; never applies silently | suggest |
| `list_suggestions(manuscript_id, status?, author?)` | Review queue | read |
| `accept_suggestion` / `reject_suggestion(id)` | Decide; human-gated by default | decide |
| `apply_style(section_id, block_id, style)` | Paragraph/section styles (scene_break, epigraph…) — recorded as a format suggestion unless `edit_direct` | style |
| `trigger_export(manuscript_id, format pdf|epub|docx, trim?, theme?)` | Queues export; returns job id | export |
| `list_notes` / `write_note(manuscript_id, title, body)` | Planning/working notes | read / comment |
| `list_story_bible` / `upsert_story_bible_entry(kind, name, aliases, fields, body)` | Story bible entries | read / suggest |
| `insert_image(section_id, anchor, image_url|upload, role=inline|chapter_opener|scene_break)` | Images, as a suggestion unless edit_direct | suggest |
| `run_preflight(manuscript_id, target)` | KDP preflight report | export |
| `create_revision(label)` / `list_revisions` | Named snapshots | read / suggest |
| `get_export(job_id)` | Status + signed download URL | export |

Resources: `coauthor://manuscript/{id}/chapter/{sid}` (read-only text). Anchors use quoted text + block id so they survive concurrent edits; server resolves to Yjs relative positions and errors if ambiguous/stale. Rate limits per token; every call written to AuditEvent.

A small REST API mirrors the same operations for non-MCP bots and for the frontend.

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
- **M0 — Repo & scaffold**: monorepo (pnpm), Vue app, collab server, API, CI, Docker Compose, Postgres.
- **M1 — Editor + Yjs**: Tiptap editor, Yjs sync via Hocuspocus, persistence, human presence/cursors.
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
- **P4 — ~11/20:** KDP preflight + EPUBCheck, message bubbles, templates, self-host packaging, polish, pilot. (RAD-223, 225, 228)


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
1. Hosting/tenancy: single-user self-hosted pilot only, or multi-user accounts from day one?
2. Typst over Paged.js OK, given preview is page images rather than live DOM? (React or Vue — confirm Vue.)
3. Should any agent ever get `edit_direct` or `decide` in the pilot, or strictly suggest-only?
4. Which agents must work at launch (Grok Bot, Claude Desktop, ChatGPT)? Bearer token OK vs OAuth?
5. What does your wife's manuscript look like today (Word? Google Docs), and which trim/theme does she want first?
6. Need ebook-only features (KDP Kindle via EPUB) for pilot, or print first?

## 14. Differentiators
- Unlimited named agent collaborators, each with own identity, color, live cursor (Yjs real-time).
- Human-approval gating by scope (comment/suggest/decide), per agent, with audit log.
- Native MCP server as a first-class product surface.
- Open source and self-hostable (Docker Compose).
- KDP print PDF + EPUB 3 + .docx from one model, with print preflight and EPUBCheck validation.
