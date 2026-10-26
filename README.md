# coAuthor

A bot-native collaborative word processor. Humans and any number of named AI agents co-write manuscripts in real time (Yjs CRDT) without overwriting each other. Agents connect through coAuthor's **native MCP server** with their own identity, and their edits arrive as comments and tracked changes that the author approves.

coAuthor exports publication-ready books: **Amazon KDP print PDF** (6x9, 5.5x8.5, via Typst), **EPUB 3** (validated with EPUBCheck), and **.docx** (via Pandoc).

- Stack: Vue 3 + Tiptap/ProseMirror + Yjs/Hocuspocus, Node/TS (Fastify + MCP SDK), Postgres, Typst, Pandoc, Tauri (Windows build)
- Status: planning. See [docs/mvp-spec.md](docs/mvp-spec.md)
- Tracking: Linear project "coAuthor" (radiancelux)
