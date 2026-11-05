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
