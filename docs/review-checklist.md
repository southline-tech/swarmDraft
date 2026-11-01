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
- [ ] UI copy and layout match the issue (and linked mockup when the issue has one); otherwise match `docs/design-system.md` patterns. _Why: design review is checklist + review bot, not a separate Designer gate on every PR._

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

## Ready gate (before every “ready for review / re-review”)

Run this consolidated pass in order; do not hand off until every line that applies is checked.

- [ ] Latest `main` merged or rebased; full command suite green on the commit you push.
- [ ] Linked issue body **and all issue comments** read; PM/Designer decisions copied into the PR (“Decisions applied”).
- [ ] Each acceptance criterion ticked in the PR with evidence (test file/name, behavior asserted, or manual step).
- [ ] Mockup links on the issue or comments opened and matched (frame ids listed), or “N/A”.
- [ ] Open PR file overlap checked; rebase or call out shared paths with other open PRs.
- [ ] Review bot run on the PR diff; findings either fixed or explicitly deferred with reason (prefer fix).
- [ ] After any review round: **one push** fixes all findings + Review learnings lines; then re-run checks before re-review.

## Review learnings

Implementor: add one line here for every review, design or QA finding, in the same PR, before asking for re-review. Reviewer/review bot: when a new kind of finding shows up a second time, promote it into a checklist item above.

- 2026-10-31 · #220 comment 6551469680 · #211 comment selected wash only under `.manuscript-editor` · mirror `.comments li` / `li.selected` under `.continuous-review-rail` when review teleports to the rail
- 2026-10-31 · #200 · name save errors used muted `.st-status` and no invalid input a11y · validation errors use `var(--ct-danger)`, `role="alert"`, and `aria-invalid`/`aria-describedby` on the name field
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
- 2026-10-28 · #115 · CI: Escape in Find focus-mode test flaky under parallel vitest · handle Esc on the find input (shell skips fields); panel div alone is not enough when focus is in the input
- 2026-10-28 · #115 · Windows `port_listener_pids` used `?` in a `Vec` return · platform-specific helpers must compile on every target CI skips; use explicit early returns instead of `?` outside `Option`/`Result` fns
- 2026-10-28 · #127 · cfg(windows) never built on Linux CI · add mingw + `cargo check --target x86_64-pc-windows-gnu` on the existing job; cache the extra target
- 2026-10-28 · #107 · continuous view put review/status inside the scroll stack · teleported chrome to a fixed rail beside the scroll column (height/layout of stacked sections deferred to PM)
- 2026-10-28 · #128 · #107 PM review · outline row needs `:hover`; add tests for scroll/focus/title; arrow keys should `activate` like click; document perf in `docs/perf-107.md`
- 2026-10-28 · #129 · #111 first pass · shipped wrong default and incomplete setting placement · read issue comments before coding; defaults and UI placement in comments are binding AC
- 2026-10-28 · #130 · overlapped #129 on `ContinuousManuscript.vue` · before ready, list open PRs on shared files and rebase onto main to avoid surprise conflict loops
- 2026-10-28 · #133 · Wave 1 PM loops · “ready” means AC checklist + issue comments + mockups + open-PR overlap in one gate (see Ready gate above)
- 2026-10-28 · #107 · continuous view mounts many editors; tests must scope to lead slice · use `[data-test="lead-editor"]` helpers, not first `.tiptap` in the DOM
- 2026-10-28 · #111 · numbering is computed from outline order, not stored in section titles · persist only `numbering_style` on the manuscript row; default `chapter_arabic` with roman part labels; style picker in outline and Settings
- 2026-10-28 · #129 · PM re-review · SQLite ADD COLUMN default and INSERT must both use `chapter_arabic`; mock/sample outline titles live in `outline-display-titles.ts`; test Settings + outline picker and label recompute
- 2026-10-29 · #54 · Designer review · style submenu needs checkmark + menuitemradio; ask-bot sparkle; disabled `.sh-mi` must not hover-highlight; forward `ask-bot` through ContinuousManuscript to App
- 2026-10-29 · #104 · PM review · app menu must match issue comment (New, Open, Recent, Settings, Quit), not legacy Open another + Settings only · wire `manuscripts_list` / `manuscript_load` and list mockup frame ids in the PR
- 2026-10-29 · #108 · PM review · Add sibling + post-delete undo are binding; drag 2px line stays Part-of until tracked; PR mockup section must list Drive frame links, not N/A
- 2026-10-29 · #104 · Designer review · 16px leading icons + `.sh-k` shortcuts only when wired (Ctrl+N/O/,/Q); use `sh-mi` menu pattern
- 2026-10-29 · #104 · PR Genie · book menu must not close on Recent toggle; dismiss after recent pick; hide Ctrl+N while importing; no global shortcuts in shell preview
- 2026-10-29 · #108 · Designer review · outline context menu icons + `aria-disabled` move rows like #137; trash icon in danger color
- 2026-10-29 · #108 · PR Genie · undo delete must rehydrate evicted section Y.Docs; keep undo banner until restore save succeeds
- 2026-10-29 · #108 · review bot · flat-list “after” on a part row must skip descendants; recompute drop edge on drop; clear undo banner on any other outline edit · use tree walk in `dropTargetFor`, pass DragEvent into `onDrop`, `preserveUndoBanner` only for delete/undo commits
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
- 2026-10-26 · #84 · moving the toolbar out of the editor (Teleport) also moved it out of the editor's keydown handler, so Ctrl+F from a toolbar button stopped working · when DOM moves out of a component, re-attach its listeners on the moved root and test a shortcut from inside it
- 2026-10-26 · #90 · the review column grew to fit its widest child (the comments empty state, 471px at 1024px) and squeezed the page to 217px · give side panels a fixed width from a named token (`--ct-panel-w`, `--ct-panel-w-narrow` below 1200px) with children at `width: 100%`, and exempt collapsed rails
- 2026-10-26 · #87 · the toolbar host's keydown also ran on the inline path, inside the editor's own handler, so shortcuts fired twice (Ctrl+Shift+F toggled focus mode on and back off) · attach a re-attached listener only when the DOM is actually teleported, and test both paths for exactly-once
- 2026-10-26 · #87 · starting focus mode from a toolbar button hid the focused button, so focus fell to <body> and Ctrl+Shift+F / Escape (handled only on the editor root) could no longer exit · when a mode hides the focused control, move focus somewhere real (the page), and give the mode's exit keys a window listener while it is active, skipping events the root handler already saw
- 2026-10-26 · #85 · SaveFailureBanner used `outline: 2px solid var(--ct-focus-ring)`, a box-shadow value, so no focus ring showed · use --ct-focus-ring only in box-shadow; a test scans every .vue/.css file
- 2026-10-26 · #89 · load-error banner showed raw parser text (`Unknown node type: ...`) and a browser-default Reload button · banner copy comes from map-error with PRODUCT_NAME, raw text to console only; banner buttons use .sh-btn
- 2026-10-26 · #87 · in focus mode, Escape on the open context menu closed the menu and also bubbled to the focus-mode exit · an overlay that handles Escape must stopPropagation, and outer Escape handlers must check every open overlay (menu, sheet) before acting
- 2026-10-26 · #92 · the page kept a fixed 576px width and the review column sized to its content (471–675px), so 1024–1280px windows clipped the page and scrolled sideways · size the page with clamp-style min/max from tokens, pin side panels to token widths, and measure scrollWidth vs clientWidth for every scroller at each target width in light and dark
- 2026-10-26 · #93 · the open-book toast was centred on the window, so at 1024px it covered the review panel's 'No comments yet' card · overlays that belong to the manuscript sit on the desk (centred on it, capped to its width); QA measures every overlay's rect against side panels
- 2026-10-27 · #93 · toggleByHand() set the manual flag even with the review panel closed, so a later narrow review open never auto-closed the outline and the page fell below 440px · state that overrides an automatic rule is only recorded while that rule is in force; test the toggle-then-trigger sequence
- 2026-10-26 · #94 · FindPanel was v-if'd off in focus mode, so Ctrl+F silently set state that popped Find up after exit · don't hide a panel by mode while its open-state can still be set; give every overlay's Escape priority over the mode exit
- 2026-10-27 · #95 · closeFind() returned focus to the page but no test covered it, so dropping the refocus would strand keyboard focus on <body> after Find closed · every overlay close path (Escape and close button) gets a test asserting document.activeElement lands back in .ProseMirror, proven to fail with the refocus removed
- 2026-10-27 · #96 · with the outline forced open at 1024px the page kept its 440px floor inside a 368px desk, so it overflowed and the desk scrolled sideways · a writer override may relax a minimum but never break containment: give the override state its own floor (token) and padding, keep the gutters, and measure page vs desk edges in that state
- 2026-10-27 · #97 · merging main dropped nothing from #95: Find and Escape handling and all its tests kept · merge main, keep every test from both sides
- 2026-10-27 · #97 · a forced-open outline left 320px page + 104px notes in a 368px desk · even a forced outline yields when page + margin notes can't fit; reopen when the panel closes or notes hide; never clip a note
- 2026-10-27 · #97 · focus mode cleared the writer's hand-opened outline · focus-mode layouts must not reset outline choices; the outline comes back as the writer left it
- 2026-10-27 · #97 · margin note cards touched the review panel border · notes keep --ct-space-4 to the review panel like the page; shrink the page toward 320px, then auto-close the outline (320 + 2×24 + 104 + 16)
- 2026-10-27 · #99 · splitting Settings into sections could unmount live regions and break tests that type into restore-path right after opening · switch sections with v-show, keep every section and live region mounted; test that only one is visible
- 2026-10-27 · #99 · Escape in the restore confirm would also close Settings behind it · a nested modal stops Escape propagation, traps Tab and returns focus to its opener
- 2026-10-27 · #99 · writer copy said "token" · UI says "key", code keeps "token"; a test scans rendered text for "token"
- 2026-10-27 · #99 · swatch colors went through a local --c custom property and failed the token sweep · per-item colors go inline via :style; never add non --ct-* vars
- 2026-10-27 · #99 · theme/profile read back from localStorage unchecked · validate stored prefs and fall back to defaults; tests seed broken data
- 2026-10-27 · #101 · an auto-closed outline only came back when the review panel closed, so hiding the margin notes at 1152–1280px left it closed for good · every auto-close names the condition that lifts it and reopens when that condition clears (unless the writer chose by hand); test that toggling the cause flips state exactly once each way
- 2026-10-27 · #101 · at 1024px with notes showing, Chapters opened and instantly re-closed the outline, so the click did nothing visible · when a control can't act, don't open-then-revert: keep its state (aria-expanded=false) and say why in the existing polite toast region, with an action that makes room
- 2026-10-27 · #101 · deleting the `notesHidden` guard in the editor still passed every test, because the App tests only checked the prop, never the rendered notes · for a prop that hides UI, assert the DOM element is gone and the emitted layout reflects it, at the component that renders it
- 2026-10-27 · #101 · the no-restart toast test advanced past 8s in one jump, so it couldn't tell "closes at 8s" from "closes later" · test a timer boundary on both sides (still visible at T−1ms, gone at T) after the event that must not reset it
- 2026-10-27 · #101 · the cue's clearTimeout-on-unmount had no test · spy on setTimeout/clearTimeout and assert the exact timer id is cleared on unmount
- 2026-10-27 · #100 · save-a-copy skipped the busy lock and wasn't modal · every file-writing dialog takes the shared lock and a parent window
- 2026-10-27 · #102 · restore confirm had the danger button first · PM: Cancel first, danger second, focus starts on Cancel; a test asserts the button order
- 2026-10-27 · #102 · the startup theme was applied inline in main.ts with no test · put boot logic in an exported function (bootTheme) and test both the stored value and the ?theme= override
- 2026-10-27 · #102 · loadProfile's typeof-string name check had no test, so String(p.name) would have let "[object Object]" through · seed non-string JSON in tests for every stored-value guard
- 2026-10-27 · #102 · the PR body's test counts (447) didn't match the log (462) after merging main · regenerate the checks log and revert table from the pushed head and copy counts from that run
- 2026-10-29 · #47 · review sidebar trapped scroll in ReviewPanel while comments sat below the flex child · one `overflow-y: auto` on `.review`, `flex: none` on the panel, comments full width below
- 2026-10-29 · branding · Linux taskbar showed a generic/settings-style icon while in-app logo was updated · enable `app.enableGTKAppId`, apply `default_window_icon()` on the main window at startup, sync `public/favicon.svg` from `generate.py`
- 2026-10-29 · #141 · PM review · taskbar `set_icon` must not fail startup · log to stderr and continue if the window icon cannot be applied
- 2026-10-29 · #141 · Designer review · favicon link must not remove `<title>swarmDraft</title>` in `index.html` · keep both; test in `icons-logo.test.ts`
- 2026-10-29 · #53 · Designer review · find navigation must not `focus()` the editor or set native selection (steals find-field focus and hides decoration highlights) · `scrollFindMatchIntoView` only
- 2026-10-29 · #53 · Designer review · find prev/next/close use `AppIcon` (`chevron-up`, `chevron-down`, `x` on the 16px grid), not literal ‹ › ×
- 2026-10-28 · #35 · save-failure test unmounted before a successful save could clear the banner (RAD-265) · after mocking recovery, drive one more edit and assert the banner is gone and status shows Saved
- 2026-10-28 · #113 · read-only restore test used `isEditable` only · assert `contenteditable="false"`, toolbar read-only title, and `typeThroughDom` leaves the doc unchanged
- 2026-10-28 · #113 · `saveStatusShown` survived `open()` on another book · reset it in `open()` and test the status line is empty until the next successful persist
- 2026-10-28 · #52 · New chapter row was a disabled shell · wire it to the same add flow as More sections and test outline + session doc creation
- 2026-10-29 · #80 · Designer review (#150) · ob6 card sizes (560 / 44 / 48 / xl / 10px bar); opening error in assertive `data-test="opening-error"` wrapper, not on ErrorCard
- 2026-10-29 · #80 · Designer/PM review (#150) · cold reopen ob6 title from `listManuscripts`, never PRODUCT_NAME; Try again re-runs stored `OpeningRetry`
- 2026-10-29 · #57 · Designer review (#149) · off toggle must not show "· Off"; status bar needs tc1 off line and tc2 "Your changes show as …" with default hint when on
- 2026-10-29 · #57 · Designer review (#149) · tc3 NamePrompt uses role=status with focus on open, Esc close, focus return to the track toggle
- 2026-10-29 · #57 · PM review (#149) · "We used your computer's name" only when `app_info.computerName` is wired through App → editor; alternate copy in browser/tests
- 2026-10-29 · #76 · PM review (#151) · `create_agent` cleared primary when a new agent matched the default display name · assign primary only when no active primary row exists; never clear primary in `create_agent`
- 2026-10-29 · #50 · author filter hid review cards but inline suggestion marks stayed visible · wire `authorVisibleInFilter` into AuthorSuggestionColors and AuthorLabels, refresh decorations on filter change, neutral `.suggestion-filter-hidden` CSS (#50)
- 2026-10-29 · #50 · PM review (#154) · mixed-author suggestion text hidden whenever any author filter was active · show when `authors.some(authorVisible)`; neutral token when author ids disagree
- 2026-10-29 · #50 · Designer review (#154) · filtered-out deletes looked like normal body text · `suggestion-filter-hidden-delete` uses `--ct-text-muted`; inserts stay `color: inherit`
- 2026-10-29 · #50 · Designer review (#154) · filter listbox lacked Space/arrow keyboard · roving focus on `[role=option]` like ContextMenu; Space activates focused row
- 2026-10-29 · #50 · Designer re-review (#154) · hidden delete still showed author strike · `:has(.suggestion-filter-hidden-*) [data-suggester]` overrides after per-author paint; focus first option when filter menu opens
- 2026-10-30 · #51 · PM review (#155) · async `manuscript_review_decisions` could overwrite in-flight accepts · merge loaded rows with current per section when the log changed since load started; drop unused `section_review_meta.decisions`
- 2026-10-30 · #60 · Designer review (#156) · ReasonLine sat above the diff; evidence used shells preview · card order who→change→reason→actions (tc4/tc6); real ReviewPanel evidence via `?evidence=rad60-review`; rationales from meta only (`withSuggestionReasons`); browser `setWebSectionReviewMeta`; `groupChanges` merges replace-pair reasons
- 2026-10-30 · #67 · Designer re-review (#157) · sr-only split still focusable; PR shots used rad60-review not App shell · gate chapter add behind `OUTLINE_CHAPTER_ADD_UI`; disabled `<button>` for + New chapter; `?evidence=rad67` App-shell evidence; review rail tooltip + “N open changes” badge copy; `OUTLINE_RAIL_ROOM` tied to `--ct-rail-w`
- 2026-10-30 · #67 · Designer re-review (#157) · disabled New chapter plain text; dual author filter UI; review rail a11y; wp1 evidence invalid mark · reuse `outline-new__btn` on disabled chapter button; one “Show changes from” checkbox popover (`All` / `N of M`); `aria-expanded`/`aria-controls` on review expand and Hide; evidence uses `comment_anchor` (load error was harness-only)
- 2026-10-30 · #67 · Designer re-review (#157) · collapsed review rail removed `#review-changes-region` · keep a `review-region-anchor` node with the same id while the panel is rail-only so `aria-controls` stays valid
- 2026-10-30 · #67 · Designer re-review (#157) · Esc on wp8 author filter left focus in the closed popover · `closeFilterMenu(true)` refocuses `[data-test=filter-toggle]` (overflow-menu pattern)
- 2026-10-30 · #67 · Designer re-review (#157) · PR wp1/wp6/wp8 shots stale or load-error · re-capture from `?evidence=rad67&frame=…&theme=…` App shell after harness fix
- 2026-10-30 · #55 · Designer review (#158) · pill × exit dropped focus to body; Ctrl+Shift+F hides chrome with no SR cue; evidence was editor-only · focus page on exit; polite `focus-mode-live`; `.shell--focus-mode` drops status-bar padding; re-capture wp5 from App `?evidence=rad55`
- 2026-10-30 · #159 · review (#171) · Spellcheck debounce invoked real `invoke` under `isTauri: true` mocks · try/catch in `lintBlockText`/`spellLintParagraph`/`runLint`; stub `spellLintParagraph` in continuous App tests
- 2026-10-30 · #159 · review (#171) · placeholder pr-evidence PNGs · capture sc1–sc6 from `docs/pr-evidence/159/evidence.html` + `capture.sh`
- 2026-10-30 · #159 · review (#171) · SpellMenu order/focus vs sc2/sc3 · suggestions → sep → Add to dictionary (spelling only) → Ignore; first suggestion + Enter hint; `sh-menu`/`sh-mi`; Dictionary switches + add-word field
- 2026-10-30 · #159 · review (#171) · plugin update dirtied selection not change range · mark dirty blocks from `tr.mapping` in plugin `apply` when `tr.docChanged`
- 2026-10-31 · #187 · Designer review (#190) · one-time key card used "You won't see it again" · ap3 copy: "Copy this key now. This key won't be shown again."; assert in `AgentsSettings.test.ts`
- 2026-10-31 · #187 · review (#190) · createToken failure after create left no agent row refresh · refresh list and surface mapped error; keep **New key** for retry (`shows an error and keeps New key when mint fails after create`)
- 2026-10-31 · #187 · Designer (#190) · key card heading empty until refresh; no focus on mint · store `agentName` on `shownToken`; `focusKeyCard()` after create/mint (`#187: mints and reveals a key`)
- 2026-10-31 · #188 · UI lane · pairing prompt must not mount in vitest when `getAppInfo` is mocked · `<PairingPrompt v-if="info && isTauri()" />`; inject `PairingApi` in unit tests
- 2026-10-31 · #188 · Design (#194) · ap1 title/copy/chips/hint; ap2 MCP connected text color; no global z-index 50 scrim · `Allow … to connect?`; `st-dlg-scrim`/`st-dlg` in `settings.css`; `--ct-success` on connected label
- 2026-10-31 · #185 · Design (#203) · Saved state used `--ct-success`; save hooks named `notes-save-*` · ap5 `data-test=note-save` / `note-save-retry`; Saving/Saved text + checkmark `--ct-text-muted` only
- 2026-10-31 · #203 · Windows smoke · notes header stuck on Saving after successful flush · non-reactive save status on Y.Doc: subscribe in `persist.ts` and bump a Vue ref; normalize doc with `toRaw` for listener WeakMap keys; panel tests assert DOM `data-state`, not only doc phase
- 2026-10-31 · #204 · Designer review (#206) · footer save error showed mapError title · `FOOTER_SAVE_ERROR_LABEL` (`Couldn't save. Retrying…`) in `save-status.ts`; banner keeps mapError
- 2026-10-31 · #204 · Designer review (#206) · Retry was an underlined link · `status-bar__retry` uses `--ct-danger` border/text and `--ct-danger-bg` (ap5)
- 2026-10-31 · #204 · Designer review (#206) · footer track changes was a second toggle · read-only `<span>`; toolbar owns `aria-pressed` and toggle
- 2026-10-31 · #204 · Designer review (#206) · whole word-count line was muted · base count `--ct-text-muted`; ` · N selected` suffix `--ct-text`
- 2026-10-31 · #204 · Designer review (#206) · Story notes footer toggle lacked pressed accent · `aria-pressed:bg-selected` + `aria-pressed:text-accent`; test when open
- 2026-10-31 · #204 · Designer review (#206) · zoom on toolbar not Word-style footer · `StatusBarZoom` after Story notes (`status-zoom-*`); − / % / + only; toolbar control removed
- 2026-10-31 · #219 · review 5725177562 · Track changes visible when Story notes closed · gate `status-track-changes` on `storyNotesOpen && !centerNarrow` (fb4)
- 2026-10-31 · #219 · review 5725177562 · footer two-track nested center|right · flat three grid tracks + `--ct-story-notes-w` side column in App workspace (fb1)
- 2026-10-31 · #219 · review 5725177562 · Story notes toggle 28px from window edge · drop `.shell__status` padding-right; keep 12px on `status-seg-right`
- 2026-10-31 · #219 · review 5725177562 · missing `status-chapter-count` · on `{n} chapters` readout in left segment
- 2026-10-31 · #219 · review 5725177562 · compact zoom menu missing popup hint · `aria-haspopup="menu"` on compact `<summary>` in `StatusBarZoom`
- 2026-10-31 · #219 · review 5725177562 · workspace gap-4 misaligned center footer divider · `gap-0` workspace; `OUTLINE_ROOM` without gap (#207)
- 2026-10-31 · #219 · review 5725177562 · page stuck at 1 before caret click · scroll-center estimate in `ContinuousManuscript` until `caret-placed` (#216)
- 2026-10-31 · #219 · review 5725395533 · collapsed nav omitted left footer cell but kept three tracks · explicit `grid-column` 2|3 on center|right when `columnTracks` set (#207)
- 2026-10-31 · #219 · review 5725395533 · workspace `p-4` right inset misaligned writing|notes footer divider · `pr-0` workspace; Story notes toggle stays 12px via `status-seg-right`
- 2026-10-31 · #220 · review 5725517731 · `.card.current` box-shadow hid `.card.active` inset bar · `::before` accent bar stacks with selected ring
- 2026-10-31 · #220 · review 5725517731 · list `@pointerdown` / leave paused follow on #213 card click · wheel + list scroll + arrow keys only; leave clears `pointerOverList` only
- 2026-10-31 · #220 · review 5725517731 · `pickActiveManuscriptMark` neighbor gap hysteresis · 8px band around +64px line; closest-below-line candidate when none at line
- 2026-10-31 · #220 · review 5725517731 · comment rows missing `aria-selected` / selected wash · track `selectedCommentId`; `--ct-comment-bg` mix + inset ring; focus stays on row
- 2026-10-31 · #220 · review 5725517731 · sync suppress timeout-only · `scrollend` on continuous root with 600ms fallback; list sync uses sticky head height + 8
- 2026-10-31 · #220 · review 5725517731 · `MARK_SELECTOR` omitted comments · include `span.comment-anchor[data-id]` in scroll-sync anchors
- 2026-10-31 · #220 · CI · App #36 outline loop timeout on runner · 15s timeout on full-outline click tests (Batch B nav cost)
