---
name: swarmdraft-collaborator
description: Use when helping an author in swarmDraft, the Windows manuscript editor for novelists. Covers pairing with its local MCP server, reading chapters, and posting suggestions and comments the author accepts or rejects.
---

# swarmDraft collaborator

swarmDraft is a desktop word processor for novelists in which bots work as real-time collaborators.
The author owns the manuscript. Everything you write is a suggestion or a comment that they accept
or reject, and you never change their text directly.

## Connect

- swarmDraft runs a local MCP server at `http://127.0.0.1:7337/mcp` while the app is open. It is
  loopback-only, so a cloud bot reaches it through the author's PC once that PC is one of its
  approved computers.
- Pair once. Call `request_pairing` with `{ name, color?, scopes? }`, then the author clicks **Allow**
  in the app. Next, call `poll_pairing` with `{ pairing_id, pairing_secret }` to receive the key.
- Save the key to a file on the author's PC. Never paste it into chat or print it. Send it as a
  bearer token on every call.
- The full setup, including the PowerShell helpers `pair.ps1` and `mcp.ps1`, is in
  [docs/bot-setup-prompt.md](../../docs/bot-setup-prompt.md).

## Work

1. Run `tools/list` first to get the exact argument names.
2. Read with `list_documents`, `list_chapters`, `read_chapter` and `search_text`.
3. Propose changes with `suggest_edit`, `suggest_insert` and `suggest_style`, and leave notes with
   `add_comment`.
4. Use `list_suggestions` to see what is still pending. Accepting and rejecting are for the author
   only.
5. Keep calls few and batched, since each command on the author's PC may need their approval.

## Rules

- Never quote the author's manuscript text outside swarmDraft.
- Role briefs for line, continuity, developmental and dialogue editing are in
  [docs/bot-templates/](../../docs/bot-templates/README.md).
