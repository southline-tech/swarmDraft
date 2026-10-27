# Self-review checklist

Built from review, design and QA findings on PRs #1–#46. Most common first. Tick every item that applies before asking for review.

## 1. Persistence and data safety (≈20 PRs)

- [ ] Typed text survives **save → reload → app restart** and a section switch away and back. Test through the real stored path, not just the in-memory Y.Doc. _Why: QA's most frequent fail; text has been silently lost before._
- [ ] Error banners show writer copy from `errors/map-error.ts` (with `PRODUCT_NAME`), never parser/developer text; raw detail goes to the console only, and a test asserts the raw text is absent. Banner buttons use `.sh-btn`. _Why: #89 showed `Unknown node type: ...` to writers._
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
- [ ] `--ct-focus-ring` is a box-shadow value: use it only in `box-shadow` (`:focus-visible`); for outline/border/color use `--ct-focus-ring-color` or `--ct-focus-outline`. _Why: #85 had no visible focus ring; `focus-ring-usage.test.ts` enforces it._

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
- 2026-10-26 · #65 · mapError threw on odd error shapes (null-prototype message, throwing toString) · error handlers never throw; guard every coercion and test hostile shapes
- 2026-10-26 · #65 · PR said "Closes" while 3 of 5 issue boxes were open · use "Part of #N" unless every acceptance box is done
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
- 2026-10-26 · #43 · `makensis -WX` failed on main (unused choowHowToInstall label) · run `makensis -WX` on the generated script for every installer change, not only a plain compile
- 2026-10-26 · #43 · uninstaller could delete the old identifier's data after a rename · uninstall delete paths must only name the current identifier; guard old ids at compile time
- 2026-10-26 · #71 · a failed rename copy was never retried because the app then created an empty new folder · mark a completed migration with a marker written last; an unmarked or empty target is not migrated
- 2026-10-26 · #71 · the db and its -wal/-shm were copied raw while the old app might be running · copy SQLite only as a consistent snapshot (VACUUM INTO or backup API), read-only on the source; if locked, tell the user to close the other app and retry next launch
- 2026-10-26 · #71 · old and renamed apps both defaulted to MCP port 7337, so agents could write to the old data · detect a taken port at startup and show a visible message naming the app to close
- 2026-10-26 · #71 · user-facing notices said 'database' and 'port 7337' · user-visible text stays plain for writers; technical details go to logs
- 2026-10-26 · #71 · a read-only SQLite open of the old db after a crash created -shm in the old folder · never open the source db with SQLite in a folder you must not touch; copy db + -wal byte for byte to staging and snapshot from the copy; prove it with tests that hash names, bytes and mtimes before and after
- 2026-10-26 · #71 · the snapshot test still passed with the fix replaced by a raw copy · before handoff, revert each fix, confirm its test fails, then restore
- 2026-10-26 · #71 · PM QA: migration also copied the LOCALAPPDATA folder (only the WebView2 EBWebView cache); WebView2 recreated it unmarked and in use, so the copy failed and warned on every launch · don't migrate caches the runtime recreates; treat a source with no database as nothing to copy, and test repeated launches after success are silent
- 2026-10-26 · #71 · PM QA: migration notices went through the restore-recovery channel, so they showed under "A restore was interrupted" · keep notice channels separate per feature (own command, payload and UI block); test one feature's notice never renders in another's
- 2026-10-26 · #65 · PM QA: App.vue still rendered raw error text (String(err), err.message) in open, import, save, backup and restore alerts · every UI catch goes through mapError/errorLine; raw text goes to console only, and tests assert the raw text is absent
- 2026-10-26 · #65 · PM QA: save-failure banner and a working 'Save a copy' were missing, so only 1 of 5 acceptance boxes was met · self-check every acceptance box against the running UI before handoff, not just the helper module
- 2026-10-26 · #65 · PM QA: user-facing copy hard-coded the product name · use PRODUCT_NAME from lib/brand.ts for every user-facing mention of the app
- 2026-10-26 · #65 · hardcoded product name left in recovery notice · grep for the old product name in every touched file before handoff
- 2026-10-26 · #65 · save_manuscript_copy took both path and bytes from JS, so any webview script could write any file · a path plus bytes from JS to a write command is an arbitrary write; pick paths in Rust (dialog opened in the command)
- 2026-10-26 · #65 · replacing the atomic write with a direct write left every test passing · revert-proof atomic writes with a test that fails the write halfway and checks the original is unchanged and no temp file is left
- 2026-10-26 · #65 · data-folder guard passed `C:\x\nope\..\..\<data>\coauthor.db` · path guards reject `.`/`..`, canonicalize the existing parent, and check every app data folder (roaming and local), case-insensitively on Windows
- 2026-10-26 · #65 · Save a copy kept comment markers but exported no comments, losing comment text and risking a Word repair · exporters must not drop data silently: export it, or strip it and tell the user, with a test
- 2026-10-26 · #65 · SectionNav and AgentsSettings still showed raw error text · grep every catch in the app for String(e)/e.message reaching the UI; only show backend text that is written for users and allowlisted
- 2026-10-26 · #44 · comment tag and tooltips said "Agent" while the pill says "Bot" · use one word for bots everywhere a person sees it
- 2026-10-26 · #44 · built from ticket text without opening the mockups · find and compare the Designer's mockup files before review
- 2026-10-26 · #44 · Brett asked for a dropdown defaulting to All; mockup showed a list · Brett's stated UI wording wins over mockup variants
- 2026-10-26 · #44 · hashed hsl author colors could collide and ignored themes · assign authors --ct-collab-N tokens, Grok Bot = collab-1
- 2026-10-26 · #44 · accept/reject shortcuts fired while focus mode hid the review panel · every shortcut that acts on panel content must check the same visibility conditions as the panel
- 2026-10-26 · #73 · create_backup took a destination path from the webview (same arbitrary-write class as #65) · every write command picks its path in Rust and builds its bytes in Rust when it can; grep all commands for path params when one is found
- 2026-10-26 · #78 · unused unattended write path callable from window · remove write paths nothing uses; every webview-triggered write needs a user gesture/dialog
- 2026-10-26 · #79 · error banners created their role=alert region together with the text · keep an assertive region mounted and insert error text a frame later
- 2026-10-26 · #79 · live-region tests passed on the component while parents v-if'd it, so the region still mounted with its text · test live regions at the parent level: region exists before the content, same node after it appears and after it clears
- 2026-10-26 · #81/#77 · live region wrapped in parent v-if so it mounted with its text · test live regions at the parent level: same node before open, after open, after dismiss
- 2026-10-26 · #77 · "Nothing to review"/"No comments yet" showed while the section failed to load · empty states must not show while a load error is set (looks like data loss)
- 2026-10-26 · #77 · toast clear on a later failure and on open() was untested · test every toast clear path with fake timers, inside the auto-close window
- 2026-10-26 · #72 · comments panel used its own hashed hsl author colors, separate from the review panel · author color comes from one shared author-to-slot map (`author-colors.ts`) used by every panel
- 2026-10-26 · #72 · module-level author slot map carried numbering over from the last manuscript opened · reset per-document caches when a manuscript opens, with an App-level test that opens a second book
- 2026-10-26 · #75 · Grok Bot color keyed by display name allowed impostors and broke on rename · never key identity by display name; use stable ids
- 2026-10-26 · #71 · migration notice placeholder used one v-if'd role=status block for both info and warn · keep separate always-mounted live regions per urgency (status for info, alert for warn), v-if only on inner content, with a same-node test
- 2026-10-26 · #71 · a "below the title bar" test passed with the banner moved, because the elements between were all v-if'd off · position tests must render the neighbors they compare against
- 2026-10-26 · #86 · moving a sync command to async + spawn_blocking with an unparented dialog let two restores/backups run at once over one journal · take a process-wide op lock before the dialog and hold it to the end; parent dialogs to the calling window
- 2026-10-26 · #86 · a failed rollback was reported like a clean failure ("try again") and the stale editor stayed open · give "storage may be mid-swap" its own code; the window closes the session on it, and only claim "nothing changed" for codes that guarantee it
- 2026-10-26 · #86 · newer-version backups and corrupt zip entries surfaced as "not a backup" / "try again" · map each error variant to its own UI code, with a test per variant
- 2026-10-26 · #82 · removing external-load-error from App.vue still passed every test, and the error was then announced twice · test parent-hosted live regions with the real child component and assert exactly one role=alert holds the text
- 2026-10-26 · #82 · useDeferredValue had no tests for a value cleared before its frame or an unmount mid-frame · cover every deferred/timer helper with fake-timer tests for cancel and unmount
- 2026-10-26 · #82 · branch conflicted with main when review was requested · merge main and re-run all checks right before each review request
- 2026-10-26 · #82 · re-importing while the book-open toast was up cleared and set its text in one tick, so the region never changed and nothing was re-announced · to re-announce the same message, clear the region, set the text on nextTick, and test the remove-then-add DOM mutations on the same node
- 2026-10-26 · #82 · after merging #77, its load-error test failed because #82 defers error text one frame · after merging main, re-run the full suite and fix semantic conflicts in the tests, not only text conflicts
- 2026-10-26 · #86 · Designer: notices must say why the book closed and that nothing changed · state the consequence plainly
- 2026-10-26 · #78 · old app-ID folders must be refused as backup destinations · refuse legacy data dirs too
- 2026-10-26 · #85 · SaveFailureBanner used `outline: 2px solid var(--ct-focus-ring)`, a box-shadow value, so no focus ring showed · use --ct-focus-ring only in box-shadow; a test scans every .vue/.css file
- 2026-10-26 · #89 · load-error banner showed raw parser text (`Unknown node type: ...`) and a browser-default Reload button · banner copy comes from map-error with PRODUCT_NAME, raw text to console only; banner buttons use .sh-btn
