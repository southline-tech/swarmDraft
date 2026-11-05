# swarmdraft.ai static site

Plain HTML/CSS for [Cloudflare Pages](https://developers.cloudflare.com/pages/). No build step.

## Cloudflare Pages settings

| Setting           | Value                         |
| ----------------- | ----------------------------- |
| Production branch | `main`                        |
| Root directory    | `site`                        |
| Build watch paths | `site/**`                     |
| Build command     | _(empty — static files only)_ |
| Build output dir  | `/` (site root)               |

Custom domain: attach `swarmdraft.ai` (and optional `www` → apex redirect) on the Pages project.

Installers are linked from GitHub Releases, not hosted here (Pages 25 MB file limit).

## Technical notes (not on the public page)

- Manuscripts and settings are stored locally (SQLite under `%APPDATA%\com.radiancelux.swarmdraft\`).
- Editor bots connect through the in-app localhost MCP server; each agent has its own token (never shown in the UI or API list responses).
- UI uses shared `--ct-*` design tokens from the desktop app (`docs/design-system.md`).
- Install link targets `docs/install-kim.md` until batch C renames it to `docs/install-author.md` (#307).

## Evidence captures

Serve `site/` locally (e.g. `python3 -m http.server` inside `site/`) and run `pr-evidence/292/capture.sh`. Uses `#light` / `#dark` and `?focus=download` for theme and focus-ring shots.
