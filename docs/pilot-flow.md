# Pilot flow (#41)

Pilot scope for the first novelist: import an existing Word manuscript, work with named writing assistants, and route feedback into GitHub. Template marketplace and self-hosted relay are **After MVP** — out of scope for this pilot gate (leave #41 open for those items).

## Before the author starts

1. Ship a signed desktop build Brett tagged for pilot (see `docs/release-checklist.md` sign-off).
2. Complete `docs/release-checklist.md` (screenshots in `pr-evidence/34-41/`, install QA on a clean non-admin Windows account).
3. Create at least **two named bots** in **Settings → Agents** (revoke/regenerate tokens as needed; never share tokens in issues or email).

## Author session (happy path)

1. **First launch** — Welcome screen → **Get started** → import Word manuscript (file picker or drag-drop). Confirm the **original Word file on disk is unchanged**.
2. **Write and revise** — Author edits in the editor; assistants connect via the in-app assistant link (localhost pairing flow, #188). Only **suggestions and comments** appear until the author accepts.
3. **Two assistants** — Pair two distinct bots; each shows a distinct name/marker. Author accepts/rejects suggestions and uses comments normally.
4. **Feedback** — Author uses in-app feedback (#297) for bugs and UX issues; triage creates or updates GitHub issues (no tokens or personal data in issue bodies).
5. **Persistence** — Close and reopen the app; last book reopens; autosaved text is intact; `.draft` save/open if used in the session.

## Gaps for Brett (not blocking this docs/copy PR)

| Item                            | Status on `main`                                                                  | Pilot impact                                                |
| ------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| KDP-ready print PDF export      | Toolbar/settings show PDF as coming later                                         | Author cannot run KDP Print Previewer from this build       |
| EPUB export + EPUBCheck worker  | Settings EPUB action exists; full preflight pipeline per MVP P4 may be incomplete | Confirm whether pilot needs ebook export before tagging     |
| Bot templates / self-host relay | #41 After MVP                                                                     | Use manual bot setup (`docs/bot-setup-prompt.md`) for pilot |

## After the session

- PM collects Designer sign-off on copy deck + screenshots (`docs/release-checklist.md`).
- File pilot feedback as GitHub issues; link duplicates; do not paste assistant tokens or manuscript excerpts unless the author opts in via the feedback UI.
