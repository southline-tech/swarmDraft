# Self-review checklist

Built from review, design and QA findings on PRs #1–#46. Most common first. Tick every item that applies before asking for review.

## 1. Persistence and data safety (≈20 PRs)

- [ ] Typed text survives **save → reload → app restart** and a section switch away and back. Test through the real stored path, not just the in-memory Y.Doc. _Why: QA's most frequent fail; text has been silently lost before._
- [ ] Saves and errors surface to the user ("Not saved, retrying"); no `catch` that swallows a failure. _Why: silent failures hid data loss (≈15 PRs)._
- [ ] Backend reads used for validation happen inside the same transaction as the write. _Why: race between check and write._
- [ ] Editor/session wiring changes: tests type, then reload via a real remount from saved state, assert the text persists, and switch sections. Cover every section kind (front matter, chapter, part, back matter).
- [ ] App.vue actually writes the editor\'s changes into the section\'s Y.Doc; test it through App, not only ManuscriptEditor. _Why: #20 lost text._
- [ ] Remote/agent updates are never saved back; polling stops before the session closes.

## 2. Yjs, undo and review integrity (≈24 PRs)

- [ ] Agent/remote updates applied with `REMOTE_ORIGIN`; the saver skips them. _Why: echo loops and duplicate marks._
- [ ] Rust: create yrs docs only with content::new_doc (UTF-16 offsets); no bare Doc::new() or with_client_id. Add a non-ASCII cross-language (TS ↔ Rust) round-trip test.
- [ ] Navigation, focus and selection changes don't modify the doc or add an undo step (`addToHistory: false`; assert doc `eq` and undo depth). _Why: moving around must not edit the book._
- [ ] Accept/reject only via `review/apply.ts` → `@coauthor/editor/trusted`; undo/redo keeps the decision log in step. _Why: human-approval gating of bot edits._
- [ ] Accept/reject are human-only and keyed on the raw agent id (never a display name).
- [ ] Review-guard or trust changes: a real two-client test (two mounted editors on synced Y.Docs). Accept and reject on A show on B, and bot suggestions appear on B. Remote Yjs transactions that touch review marks are never dropped; local untrusted mark edits are still blocked.
- [ ] Concurrent cases tested: typing mid-word while an agent update lands, edits in another section, non-ASCII text (`naïve café — 😀`). _Why: repeatedly requested._
- [ ] Bulk Accept all / Reject all lock their targets when the confirm opens; changes that arrive later are not included.

## 3. Tests (≈17 PRs flagged missing/weak tests)

- [ ] Every acceptance criterion has a test through real wiring (mounted component / mocked `invoke` with exact args), not a stub of the thing under test.
- [ ] Assert the behavior, not a proxy (e.g. read-only: assert `isEditable === false` and typing leaves doc unchanged, not just `childCount`).
- [ ] Two-window/two-editor sync tested when state is shared. _Why: QA tests with two windows open._
- [ ] Component default props and functions are exercised by a test, not only the injected seams.
- [ ] Each new test fails without the fix: revert the fix locally and confirm it fails, and say so in the PR.

## 4. Design tokens, theme and contrast (≈18 PRs)

- [ ] Colors, spacing and radii use `var(--ct-*)` tokens from `docs/design-system.md`; no hex values, no undefined vars (e.g. `--color-muted`). _Why: most common Designer finding._
- [ ] Checked in **light and dark** themes; text and selected states meet WCAG AA contrast. _Why: dark-mode highlights and selected rows have failed._
- [ ] Layout checked at a narrow window (≈900px) and short window (500px), and zoom 50–200%: nothing clipped, all panels scroll to the end.
- [ ] Matches the Designer's mockup/spec copy exactly (button text, confirm wording, order).

## 5. Focus, keyboard and accessibility (≈16 PRs)

- [ ] Dialogs take focus, close on Esc, return focus to the opener; Cancel first in destructive confirms.
- [ ] Global shortcuts do nothing while focus is in an input/textarea/select/other contenteditable or when the panel is hidden.
- [ ] Every enabled control works; tooltips/`aria-keyshortcuts` list only shortcuts that are actually bound; disabled controls are `aria-disabled`.
- [ ] Interactive regions have roles and labels.

## 6. MCP server and agent tokens (≈18 PRs)

- [ ] Tokens never appear in logs, errors, IPC responses or UI.
- [ ] MCP tokens are re-checked inside the same DB lock/transaction as each write (not only once per request).
- [ ] No new MCP tool can accept/reject or write text directly.
- [ ] Agent names render as text only (mustache, no `v-html`).

## 7. Unicode and names (≈7 PRs)

- [ ] Name checks in the backend: strip zero-width/bidi controls, NFKC + case fold (ß→ss), trim; reject reserved and duplicate names.
- [ ] Duplicate-name checks include revoked agents.
- [ ] The agent marker shows everywhere a name shows (headings, lists, comment author line, tooltips); author colors are keyed by agent id, not name.
- [ ] Render user/agent names in `<bdi dir=auto>`; long/RTL names truncate without hiding adjacent pills.
- [ ] Word counts and regexes handle combining marks (`\p{M}`) and non-Latin scripts.

## 8. Process (≈17 PRs needed a main merge or conflict fix)

- [ ] `main` merged in; lint, format, typecheck, tests, build, clippy, cargo test all pass.
- [ ] `Closes #N` only when the PR finishes the issue; `Part of #N` for epics.
- [ ] Lockfile changes limited to what the PR needs. Cargo.lock keeps its format version (currently version = 3).
- [ ] Async reloads deduped/throttled; stale replies dropped; timers and listeners cleared on unmount.
- [ ] No competitor names, parity lists or competitive analysis in code, docs, commits, branch names, issues or PRs.
- [ ] No hard-coded personal data.

## Review learnings

Implementor: add one line here for every review, design or QA finding, in the same PR, before asking for re-review. Reviewer/Designer: when a new kind of finding shows up a second time, promote it into a checklist item above.

Format: `YYYY-MM-DD · #PR · finding · rule`

- 2026-10-26 · #33 · reserved/duplicate name check bypassed with zero-width and fullwidth chars · normalize (strip invisibles, NFKC, fold) before comparing names
- 2026-10-26 · #33 · `--color-muted` not defined, notes not muted · use only `--ct-*` tokens that exist in tokens.css
- 2026-10-26 · #44 · review shortcuts fired while typing in settings · scope global shortcuts to the panel and editor focus
- 2026-10-26 · #46 · outline click inserted a paragraph (doc edit + undo step) · navigation never changes the document
- 2026-10-26 · #63 · checklist had wrong typecheck tool and bulk-lock timing · verify every doc claim against the code before review
- 2026-10-26 · #64 · installer art mixed the v5 "oA" logo BMPs with the Ribbon art the installer currently uses (putting the v5 logo back is a tracked follow-up) · take logo assets from the logo-final set and check which mark each page shows
- 2026-10-26 · #64 · finish page copy promised a desktop shortcut the user may untick · copy states only what always happens, or matches the option shown
- 2026-10-26 · #64 · uninstall docs pointed to a Start menu uninstall entry Tauri doesn't create · document only UI paths verified in the actual build
- 2026-10-26 · #64 · docs said app data is kept, but the uninstaller can delete it via a checkbox · docs describe the real behavior, including opt-in deletes and which folders they remove
- 2026-10-26 · #64 · progress page was the stock MUI page (header strip, log, Next click) · every installer page matches its mockup layout and advances on its own when work ends
- 2026-10-26 · #64 · Cancel sat right of the primary button · Cancel on the left, primary action on the right
- 2026-10-26 · #64 · finish page had a desktop-shortcut checkbox not in the mockup · no options beyond the mockup; do the default always, in every install mode
- 2026-10-26 · #64 · titles were sans and the accent button wasn't attempted · try each mockup style; bundle only OFL-type fonts with the license in the repo, and list what isn't feasible as a gap
- 2026-10-26 · #64 · copied Tauri template with a caret CLI range · pin @tauri-apps/cli exactly to the template's version
- 2026-10-26 · #33 · agent marker missing in some places a name shows · show the agent marker everywhere a name renders
- 2026-10-26 · #46 · persistence tested only in memory · persistence tests reopen from saved state
- 2026-10-26 · #46 · Tiptap commands bypass read-only, so command-based tests passed falsely · test read-only via DOM input
- 2026-10-26 · #46 · tests passed with the fix removed · prove each new test fails with its fix reverted
- 2026-10-26 · #66 · outline showed per-row type labels and five add buttons · hide type labels (aria-label only); one "+ New chapter" row; group front matter
- 2026-10-26 · #66 · chapter heading off-spec · H1 in manuscript font, weight 400, centered, with a display-only small-caps chapter label
- 2026-10-26 · #66 · toolbar end overcrowded · toolbar right end keeps only Track changes + Review; the rest goes in the … menu
- 2026-10-26 · #66 · title bar crowded with actions · title bar shows the book/chapter path; secondary actions live in a small menu
- 2026-10-26 · #66 · hard-coded #b00020/#1a7f37 · use danger/success tokens, never hex
- 2026-10-26 · #66 · screenshots missing for some screens · attach light + dark screenshots for every screen changed
- 2026-10-26 · #66 · screenshots labeled with mockup ids showed the same state (wp1=wp6=tc1, ob4=ob5) · every shot named after a mockup id must reproduce that mockup's distinct state; use ?preview sample data when the app can't
- 2026-10-26 · #66 · 'doc unchanged' test built a Y.Doc the component never received · (and the click loop never reached Save) · a no-mutation test must pass the real doc into the component and actually trigger every write path
- 2026-10-26 · #66 · settings defaults hard-coded real-looking names · use neutral sample names in defaults and fixtures
- 2026-10-26 · #66 · inline card marked role=dialog without modal behavior · use role=dialog only with aria-modal, focus in, Tab trap, Esc and focus return; otherwise an inline card
- 2026-10-26 · #69 · in-app logo used the superseded plain-c masters, not the c-with-caret pack · take logo assets from the Designer's latest pack and test the exact asset per size
- 2026-10-26 · #44 · comment tag and tooltips said "Agent" while the pill says "Bot" · use one word for bots everywhere a person sees it
- 2026-10-26 · #44 · built from ticket text without opening the mockups · find and compare the Designer's mockup files before review
- 2026-10-26 · #44 · Brett asked for a dropdown defaulting to All; mockup showed a list · Brett's stated UI wording wins over mockup variants
- 2026-10-26 · #44 · hashed hsl author colors could collide and ignored themes · assign authors --ct-collab-N tokens, Grok Bot = collab-1
- 2026-10-26 · #44 · accept/reject shortcuts fired while focus mode hid the review panel · every shortcut that acts on panel content must check the same visibility conditions as the panel
- 2026-10-26 · #72 · comments panel used its own hashed hsl author colors, separate from the review panel · author color comes from one shared author-to-slot map (`author-colors.ts`) used by every panel
