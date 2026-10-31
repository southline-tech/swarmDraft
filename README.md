# swarmDraft

A local-first desktop word processor for writing books with AI collaborators. Humans and named AI
agents work on the same manuscript; agent changes arrive as comments and suggestions that the
author approves.

- Platform: Tauri desktop app (Windows first), local SQLite and files, in-app MCP server on
  `127.0.0.1`, optional Yjs sync.
- Spec: [docs/mvp-spec.md](docs/mvp-spec.md) · Tracking: Linear project "coAuthor" (product renamed to swarmDraft)

## Getting started (authors, Windows)

Today the simplest path is the **dev build** from this repo. A signed installer is planned
([#196](https://github.com/southline-tech/swarmDraft/issues/196)); until then, run from source.

### Prerequisites

- Windows 10 or 11
- [Node.js 20+](https://nodejs.org/), [pnpm 9](https://pnpm.io/installation), and a stable
  [Rust](https://rustup.rs/) toolchain
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (WebView2 is usually already
  present on Windows 10/11)

Use **Command Prompt** (`cmd.exe`) for the commands below. In PowerShell, run each line on its
own (do not chain with `&&`).

### Before you start: one manuscript

Many authors juggle several versions (`final.docx`, `final_v2.docx`, edits in email…). Pick **one**
copy before you import anything:

1. Gather every copy into one folder. Do not delete anything yet.
2. Choose the most complete one — usually the file you last wrote in.
3. Import that copy into swarmDraft.
4. Anything you still want from the other copies can come in later as tracked changes, suggestions,
   or story notes, so nothing is lost and you approve each piece.
5. Move the leftovers into an “old versions” folder. From then on, swarmDraft is the single
   manuscript; backups are the safety net.

### Run the app

```
git clone https://github.com/southline-tech/swarmDraft.git
cd swarmDraft
pnpm.cmd install
pnpm.cmd dev
```

The first Rust build takes a few minutes. When the window opens, import your chosen manuscript
(Word `.docx` works). Unsigned Windows installers from CI are also documented in
[docs/install-windows.md](docs/install-windows.md).

### Working with suggestions

Bots can only **suggest**. Their edits show under their name in **Review changes**; you keep or
skip each one. Accepting or rejecting is always yours.

## Connect your AI bot

swarmDraft runs a local MCP server at `http://127.0.0.1:7337/mcp`. It is **loopback-only** — only
software on the same PC can reach it. A bot running on that PC (or a cloud bot that uses that PC as
an approved computer) pairs like this:

1. The bot calls `request_pairing` with `{ name, color?, scopes? }`.
2. You get an in-app prompt. Click **Allow** (or **Deny**).
3. The bot calls `poll_pairing` with `{ pairing_id, pairing_secret }` and receives its key.
4. The bot **saves the key to a file** on disk. The key is never pasted into chat and never printed.
5. In **Settings → Agents**, the bot appears with an MCP connected status. Revoke it there anytime.

A ready-to-paste setup prompt for your bot (pairing helpers included) is in
[docs/bot-setup-prompt.md](docs/bot-setup-prompt.md).

A future relay that connects bots without hand-managing keys is planned
([#195](https://github.com/southline-tech/swarmDraft/issues/195)); until then, pairing on the same
PC (or through that PC as an approved computer) is the path.

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

## Developer setup

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
