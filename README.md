# swarmDraft

A local-first desktop word processor for writing books with AI collaborators. Humans and named AI
agents work on the same manuscript; agent changes arrive as comments and suggestions that the
author approves.

- Platform: Tauri desktop app (Windows first), local SQLite and files, in-app MCP server on
  `127.0.0.1`, optional Yjs sync.
- Spec: [docs/mvp-spec.md](docs/mvp-spec.md) · Tracking: Linear project "coAuthor" (product renamed to swarmDraft)

## Repository layout

```
apps/desktop/            Vue 3 + Vite UI, wrapped by Tauri
  src/                   UI shell (imports the packages below)
  src-tauri/             Rust backend
    src/storage.rs       data dir + SQLite (migrations via PRAGMA user_version)
    src/mcp/             in-app MCP server: tokens, transport, tools (RAD-205/209/210)
packages/schema/         shared types: sections, principals, trim sizes, Yjs doc ids
packages/editor/         Tiptap editor, Yjs binding, autosave, outline (RAD-202/203/214)
packages/docx/           Word .docx import/export (RAD-218)
fixtures/                synthetic test corpus only (no real manuscript text)
docs/                    spec and design notes
```

Each chapter/scene has its own Yjs document (`sectionDocId(manuscriptId, sectionId)`), so
sections load, persist and are exposed over MCP independently.

Agents can read, comment and suggest. Accepting or rejecting a suggestion is human-only.

## Setup

Prerequisites: Node 20+, pnpm 9, Rust stable, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (WebView2 on Windows).

```
pnpm install
pnpm dev          # desktop app (Tauri + Vite)
pnpm dev:web      # UI only in a browser
pnpm lint && pnpm typecheck && pnpm test
cd apps/desktop/src-tauri && cargo test
pnpm tauri build  # installers (on Windows: .msi and NSIS)
```
