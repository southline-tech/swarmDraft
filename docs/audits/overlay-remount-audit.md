# Overlay, portal, remount, and focus audit

**Repo:** `southline-tech/swarmDraft` @ `main` (post-#271 toolbar host fix)  
**Date:** 2026-11-02  
**Scope:** Desktop Vue app (`apps/desktop/src/`). Read-only investigation; fixes tracked in linked issues.

## Executive summary

Several QA issues share a pattern with **#261** (toolbar vanished): UI anchored in a **DOM subtree that is emptied, reparented, or painted under a sibling**, plus **focus handlers that run on card activation** and steal focus from nested inputs. #261 was **confirmed** and fixed with a stable `#toolbar-slot` host and scroll/focus guards (`App.toolbar-261.test.ts`).

| Priority | Finding                                                                  | Issue | Status                                   |
| -------- | ------------------------------------------------------------------------ | ----- | ---------------------------------------- |
| 1        | Toolbar Teleport target was unstable before #271                         | #261  | **Confirmed** (fixed #271)               |
| 2        | Toolbar dropdowns stay `position:absolute` in chrome; desk paints on top | #267  | **Hypothesis** (layout + QA)             |
| 3        | Review reply input: card `@click` → `select` → `focusReviewRow`          | #264  | **Confirmed** (code + `it.fails` test)   |
| 4        | Pairing UI shows `queue[0]` only; sequential modals on rapid requests    | #269  | **Confirmed** (code + `it.fails` test)   |
| 5        | Recent submenu nested in main menu list; QA flyout overlap on Windows    | #263  | **Hypothesis** (QA; happy-dom layout OK) |

**Proposed direction:** one **`#app-overlay-layer`** (or Teleport `body` with shared tokens), a **z-index scale** aligned to `docs/design-system.md` elevation, **stable mount IDs** for chrome/toolbar/review, **keys that do not remount on metadata refresh**, and a **focus policy** (input clicks stop propagation; no row focus after focus enters a control).

Regression specs (pre-fix, CI-green via `it.fails`): `apps/desktop/src/overlay-regressions.test.ts`.

---

## 1. Portal / Teleport / floating UI inventory

| Component                    | File                              | Mount target                                           | z-index / stacking                      | Can target unmount or re-render on…                                                                                               |
| ---------------------------- | --------------------------------- | ------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Editor toolbar               | `ManuscriptEditor.vue`            | `#toolbar-slot` (`App.vue`) via `toolbarTarget`        | Chrome `z-index: 40` (`App.vue`)        | **Section/draft:** lead handoff `#261` (stable slot). Teleport `defer`.                                                           |
| Review panel                 | `ManuscriptEditor.vue`            | `#continuous-review-rail` (`ContinuousManuscript.vue`) | Rail `z-index: 35`                      | **Chapter select:** Teleport disabled for non-lead slices; lead rail is stable DOM node. Panel content re-renders on review data. |
| Status bar                   | `ManuscriptEditor.vue`            | `statusTarget` or `body`                               | Footer / teleported                     | **Slice mode / focus mode** disables Teleport.                                                                                    |
| Outline context menu         | `SectionNav.vue`                  | `body` (Teleport)                                      | `.sh-menu` `z-index: 40` (`shells.css`) | **Outline refresh:** menu closes on nav; not tied to editor remount.                                                              |
| Book menu + Recent           | `App.vue`                         | Inline in `.topbar__menu` (no Teleport)                | `.topbar__menu-list` `z-index: 20`      | **Draft switch:** menu closes via `closeBookMenu`; submenu is **nested** in main list.                                            |
| Export dropdown              | `ToolbarExportMenu.vue`           | Inline `relative` / `absolute` in toolbar              | Tailwind `z-20` on menu                 | **Toolbar handoff:** content moves with Teleport host; menu not portaled. Spills into desk stack.                                 |
| Draft picker menu            | `DraftPicker.vue`                 | Inline in toolbar                                      | `z-20` pattern                          | Same as export.                                                                                                                   |
| More formatting (⋯)          | `EditorToolbar.vue`               | Inline in toolbar                                      | `z-10`                                  | Same; also **#268** product logic (overflow), not stacking.                                                                       |
| Author filter menu           | `ReviewPanel.vue`                 | Inline `absolute` in panel                             | `z-index: 10`                           | **Review list updates** re-render cards; menu closes on outside click.                                                            |
| Spell menu                   | `spellcheck/SpellMenu.vue`        | Fixed in editor overlay                                | Editor-local                            | **Section remount** (`reloadToken` key) destroys editor subtree.                                                                  |
| Overlap popover              | `review/OverlapPopover.vue`       | Fixed in editor                                        | `aria-modal` dialog                     | Closes on section change / editor remount.                                                                                        |
| Context menu                 | `shells/ContextMenu.vue`          | Fixed at cursor                                        | `shells.css` menu tokens                | Tied to active editor instance.                                                                                                   |
| Find panel                   | `shells/FindPanel.vue`            | In-editor overlay                                      | Editor chrome                           | Focus moves to find/replace inputs on open.                                                                                       |
| Open-book / no-room toast    | `App.vue` + `shells/AppToast.vue` | `.open-toast` in desk                                  | `z-index: 40`                           | **Layout** via `toastPlacement`; region stable.                                                                                   |
| Settings                     | `settings/SettingsScreen.vue`     | Full-screen scrim                                      | `settings.css` / `z-index: 5` scrim     | `v-if="settingsOpen"` — full remount each open.                                                                                   |
| Agents window                | `agents/AgentsWindow.vue`         | Modal scrim                                            | `z-index: 6`                            | `v-if="agentsOpen"`.                                                                                                              |
| Pairing prompt               | `PairingPrompt.vue`               | Modal scrim (`st-dlg-scrim`)                           | Settings dialog stack                   | Queue sync; **one dialog bound to `queue[0]`** (#269).                                                                            |
| Backup restore confirm       | `settings/BackupsSection.vue`     | Nested dialog                                          | `z-index: 10`                           | Inside Settings remount.                                                                                                          |
| Delete section dialog        | `SectionNav.vue`                  | Teleport `body` (pattern matches outline menu)         | `.sh-menu` scale                        | Outline / section ops.                                                                                                            |
| Migration / recovery banners | `App.vue`, `migration/*`          | In-flow                                                | Low                                     | Stable regions.                                                                                                                   |

**Design tokens:** elevation `1` page · `2` menus/popovers · `3` modals (`docs/design-system.md`). Implementation uses **ad hoc** numbers (10, 20, 35, 40, 50) across Vue scoped CSS and Tailwind utilities — no single overlay root.

---

## 2. Remount / unstable keys

| Location                   | Key / pattern                                   | Triggers remount             | Risk                                                                                                                                                  |
| -------------------------- | ----------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ContinuousManuscript.vue` | `` `:key="\`${sec.docId}#${reloadToken}\`"`` `` | `reloadToken` bump on Reload | **Entire section editor** (toolbar Teleport source, review Teleport, comment state) destroyed. Intentional for reload; must not bump on benign saves. |
| `ContinuousManuscript.vue` | `toolbarSectionId` handoff                      | Section select               | Old lead keeps Teleport until new lead ready (#261).                                                                                                  |
| `App.vue`                  | `:comment-meta-version` → continuous            | Comment IPC refresh          | Prop change refreshes meta **without** necessarily remounting section key — review list re-renders.                                                   |
| `ReviewPanel.vue`          | `:key="item.key"` on cards                      | Review list recompute        | Card DOM replaced when `item.key` changes; **reply draft** in parent `commentDrafts` survives, but **focus** lost on DOM replace.                     |
| `ReviewPanel.vue`          | `` `:key="\`view-${a}\`"`` ``                   | Author filter view           | Filter UI remount.                                                                                                                                    |
| `ManuscriptEditor.vue`     | `` `:key="\`m-${c.key}\`"`` ``                  | Margin notes                 | Margin note nodes remount when change set changes.                                                                                                    |
| Settings / Agents          | `v-if` open flags                               | Open/close                   | Expected full remount; focus return implemented.                                                                                                      |

**Comment / review (#264):** activating a card calls `activateChangeRow` → `select` → for comments `focusCommentByThreadId` → `focusReviewRow`, which focuses the `<li role="option">`. The reply `<input>` has **no `@click.stop`**; bubbling activation recenters focus on the row/editor.

---

## 3. Focus handling inventory

| Area                  | Mechanism                                                           | Steals focus on update?                      |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| Review card click     | `ReviewMixedCard` `@click` → `activateChangeRow` → `focus()` on row | **Yes** — conflicts with reply input (#264). |
| Comment select        | `focusCommentByThreadId` → scroll + `focusReviewRow`                | **Yes** when selecting comment threads.      |
| Pairing dialog        | `denyButton.focus()` on show; trap Tab                              | Deny focused by design (#188).               |
| Settings / Agents     | `trapTab`, restore opener on close                                  | Controlled.                                  |
| Overlap / spell menus | `onMounted` → focus first item; return focus to page                | On open only.                                |
| Toolbar menus         | `useToolbarMenu` / arrow focus in menu                              | Returns to trigger on close.                 |
| Section outline menus | Focus first `menuitem` on open                                      | Expected for menus.                          |
| Editor `landInBody`   | `focus({ preventScroll: true })`                                    | Section navigation (#261).                   |

---

## 4. Issue mapping

| Issue    | Summary                                  | Root cause                                                                 | Evidence                                                                                                        |
| -------- | ---------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **#261** | Toolbar vanished on chapter/draft switch | Window scroll + Teleport handoff to empty target                           | Fixed #271; `App.toolbar-261.test.ts`                                                                           |
| **#263** | Recent submenu covers main menu          | Nested submenu in same stacking context; possible platform/layout variance | QA Windows; CSS intends `left: 100%` (`App.vue`, `.sh-sub`)                                                     |
| **#264** | Reply input loses focus                  | Card activation focuses row / editor                                       | `ReviewMixedCard.vue` + `ReviewPanel.vue` + `ManuscriptEditor.select`; `overlay-regressions.test.ts` `it.fails` |
| **#267** | Export menu under review panel           | Dropdown in chrome; desk sibling paints over spill; rail `z-index: 35`     | QA Windows; structural test expects `#app-overlay-layer` (not implemented)                                      |
| **#268** | More menu not true overflow              | Product logic in `EditorToolbar.vue` — static overflow list                | **Separate** from overlay/remount class                                                                         |
| **#269** | Multiple pairing modals                  | `PairingPrompt` renders one `active()`; queue processed sequentially       | `PairingPrompt.vue` comment + template; `it.fails` multi-bot test                                               |

**NEW (no issue yet):** Ad hoc z-index across toolbar (`z-10`/`z-20`), chrome (`40`), review rail (`35`) without a shared overlay root — maintenance hazard for any future panel.

---

## 5. Shared approach (recommended)

### Overlay layer

1. Add **`#app-overlay-layer`** on `App.vue` (sibling after chrome, `pointer-events: none` on layer, `auto` on children) or Teleport floating UI to **`body`** with one wrapper.
2. Define **`--ct-z-*` tokens** (e.g. desk `10`, panel `20`, chrome `30`, menu `40`, modal scrim `50`, modal `60`) in `tokens.css` and migrate scattered literals.
3. Route **toolbar menus** (Export, Draft, More), **book menu / Recent flyout**, and **review author filter** through the layer (position with `floating-ui` or fixed + anchor rect).

### Stable mount points

4. Keep **`#toolbar-slot`**, **`#continuous-review-rail`**, status footer targets **always mounted** when a session is open (already mostly true post-#271).
5. Document which Teleports use **`defer`** and handoff rules in `AGENTS.md` or design-system.

### Keys and remount policy

6. Avoid bumping **`reloadToken`** except explicit Reload; audit `comment-meta-version` consumers so comment refresh does not reset section keys.
7. Prefer **stable `item.key`** on review cards; if row identity changes, preserve focus via `data-review-row-key` + `focusReviewRow` only when activation came from keyboard, not from input.

### Focus policy

8. **Interactive descendants** on review cards: `@click.stop` on reply form; `activate` skips refocus when `event.target` is an input/button/textarea.
9. Pairing (#269): single modal component listing pending rows; **no focus steal** when appending rows (maintain focus in list).
10. Central **`useOverlayMenu`** hook: open/close, Esc, return focus to trigger, single open menu at a time.

### PR-sized rollout (order)

| Step | PR scope                                                                                |
| ---- | --------------------------------------------------------------------------------------- |
| 1    | Docs + tokens: z-index scale, `#app-overlay-layer` shell (no migrations yet)            |
| 2    | Port toolbar dropdowns (#267) + flip `overlay-regressions` #267 from `it.fails` to pass |
| 3    | #264 focus policy on `ReviewMixedCard` / `ReviewPanel`                                  |
| 4    | #263 Recent submenu → overlay flyout + keyboard Right/Left                              |
| 5    | #269 batch pairing modal                                                                |
| 6    | #268 overflow toolbar (orthogonal; can parallel after step 2)                           |

---

## 6. Findings table

| Component                           | Problem                                               | Issue # | Confirmed / hypothesis       | Proposed fix                                     |
| ----------------------------------- | ----------------------------------------------------- | ------- | ---------------------------- | ------------------------------------------------ |
| `#toolbar-slot` Teleport            | Target emptied on section switch                      | #261    | **Confirmed** (fixed)        | Stable slot + handoff (#271)                     |
| `ToolbarExportMenu` / toolbar menus | Menus not in overlay layer; desk paints over dropdown | #267    | **Hypothesis** (QA + layout) | Teleport to `#app-overlay-layer` + z token       |
| `ReviewMixedCard` reply form        | Card click handler refocuses row                      | #264    | **Confirmed**                | `@click.stop` on form; guard `activateChangeRow` |
| `App.vue` Recent submenu            | Nested flyout; QA overlap                             | #263    | **Hypothesis**               | Port flyout to overlay; anchor to Recent row     |
| `PairingPrompt`                     | One bot per modal                                     | #269    | **Confirmed**                | Single modal, multi-row queue UI                 |
| `ContinuousManuscript` section key  | `reloadToken` remounts editors                        | NEW     | **Confirmed** (by design)    | Document; do not tie to comment refresh          |
| `ReviewPanel` list                  | Re-render on review updates                           | #264    | **Hypothesis** (secondary)   | Stable keys + focus guard                        |
| `EditorToolbar` ⋯ menu              | Static overflow list                                  | #268    | **Confirmed** (spec gap)     | ResizeObserver overflow (#268)                   |
| Ad hoc z-index                      | Inconsistent stacking                                 | NEW     | **Confirmed**                | Token scale + overlay manager                    |

---

## Tests

| Test                        | File                          | Notes                                  |
| --------------------------- | ----------------------------- | -------------------------------------- |
| Toolbar survives navigation | `App.toolbar-261.test.ts`     | **Passes** (regression guard for #261) |
| Reply focus                 | `overlay-regressions.test.ts` | `it.fails` until #264 fixed            |
| Export overlay layer        | `overlay-regressions.test.ts` | `it.fails` until #267 fixed            |
| Batch pairing copy          | `overlay-regressions.test.ts` | `it.fails` until #269 fixed            |

When fixing an issue, remove `it.fails` wrapper and assert normally (Ready gate).
