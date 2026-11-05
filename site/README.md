# swarmdraft.ai static site

Plain HTML/CSS for [Cloudflare Pages](https://developers.cloudflare.com/pages/). No build step.

## Cloudflare Pages settings

| Setting           | Value                                                                           |
| ----------------- | ------------------------------------------------------------------------------- |
| Production branch | `main`                                                                          |
| Root directory    | `site`                                                                          |
| Build watch paths | `site/**`                                                                       |
| Build command     | _(empty — static assets; Pages Functions in `functions/` deploy automatically)_ |
| Build output dir  | `/` (site root)                                                                 |

Custom domain: attach `swarmdraft.ai` (and optional `www` → apex redirect) on the Pages project.

Installers are linked from GitHub Releases, not hosted here (Pages 25 MB file limit).

## Pages secrets (production only)

Set in the Cloudflare Pages project for `swarmdraft` — never commit or embed in client code:

| Secret                     | Purpose                                        |
| -------------------------- | ---------------------------------------------- |
| `RESEND_API_KEY`           | Resend API key for outbound feedback email     |
| `SWARMDRAFT_FEEDBACK_TO`   | Inbox (e.g. feedback@yourdomain.com)           |
| `SWARMDRAFT_FEEDBACK_FROM` | Verified Resend sender (`Name <email@domain>`) |

`POST /api/feedback` is implemented in `functions/api/feedback.ts`.

## Technical notes (not on the public page)

- Manuscripts and settings are stored locally (SQLite under `%APPDATA%\com.radiancelux.swarmdraft\`).
- Editor bots connect through the in-app localhost MCP server; each agent has its own token (never shown in the UI or API list responses).
- UI uses shared `--ct-*` design tokens from the desktop app (`docs/design-system.md`).
- Install link targets `docs/install-author.md`.

## Evidence captures

Serve `site/` locally (e.g. `python3 -m http.server` inside `site/`) and run `pr-evidence/292/capture.sh`. Uses `#light` / `#dark` and `?focus=download` for theme and focus-ring shots.
