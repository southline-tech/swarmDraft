# Overlay, portal, remount, and focus audit

**Repo:** `southline-tech/swarmDraft`  
**PR:** #273 (`audit/overlay-remount-inventory`)  
**Date:** 2026-11-02 (audit); **landed:** 2026-11-02 (overlay implementation)

## What landed in #273

Shared overlay layer and regression fixes for **#263**, **#264**, **#267**, **#269**, **#270** (not **#268** overflow logic).

| Deliverable           | Implementation                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlay root          | `#app-overlay-layer` on `document.body` (`overlay/layer.ts`, `main.ts`); global styles in `styles/app.css`.                                                                        |
| Z-index tokens        | `--ct-z-panel`, `--ct-z-chrome`, `--ct-z-dropdown`, `--ct-z-flyout`, `--ct-z-modal`, `--ct-z-toast` in `styles/tokens.css`; review rail and chrome use tokens instead of literals. |
| Anchored menus        | `OverlayAnchoredMenu.vue` + `anchor-position.ts` (flip/clamp, resize/scroll).                                                                                                      |
| Portaled UI           | Export, Draft picker, More (⋯), book menu, Recent flyout (separate overlay, `right-start`), review view filter, open-book / no-room toast, batch pairing dialog.                   |
| Focus (#264)          | `review/review-focus-policy.ts`; `activateChangeRow` skips composers; reply form `@click.stop`; no `focusReviewRow` while composer focused.                                        |
| Pairing (#269)        | `PairingPrompt.vue` — one dialog, row per request, Allow/Deny + Allow all / Deny all; live queue updates.                                                                          |
| Duplicate name (#270) | `pairing-errors.ts` → clear copy in `PairingPrompt`.                                                                                                                               |
| Tests                 | `overlay-regressions.test.ts` — normal `it()` for #264, #267, #269, #270; `overlay/queries.ts` scopes queries to the layer; `vitest.setup.ts` resets overlay children.             |

**Stable mounts (unchanged intent):** `#toolbar-slot`, `#continuous-review-rail`; `reloadToken` still only bumps on explicit Reload.

**Still inline / follow-ups:** spell/overlap editor overlays, `SectionNav` body Teleport (already top-level), Settings/Agents scrims, **#268** toolbar overflow product work.

---

## Executive summary (original audit)

Several QA issues shared a pattern with **#261** (toolbar vanished): UI anchored in a **DOM subtree that is emptied, reparented, or painted under a sibling**, plus **focus handlers that run on card activation** and steal focus from nested inputs. #261 was **confirmed** and fixed with a stable `#toolbar-slot` host and scroll/focus guards (`App.toolbar-261.test.ts`).

| Priority | Finding                             | Issue | Status after #273                   |
| -------- | ----------------------------------- | ----- | ----------------------------------- |
| 1        | Toolbar Teleport target unstable    | #261  | **Fixed** (#271)                    |
| 2        | Toolbar dropdowns under desk/review | #267  | **Fixed** (overlay + tokens)        |
| 3        | Reply input focus steal             | #264  | **Fixed** (focus policy + tests)    |
| 4        | One pairing modal per bot           | #269  | **Fixed** (batch dialog)            |
| 5        | Recent nested in main menu          | #263  | **Fixed** (separate flyout overlay) |
| —        | Duplicate pairing name copy         | #270  | **Fixed**                           |
| —        | More menu not true overflow         | #268  | **Open** (orthogonal)               |

Regression specs: `apps/desktop/src/overlay-regressions.test.ts` (all passing).

---

## 1. Portal / Teleport / floating UI inventory (post-#273)

| Component                     | Mount target                               | Notes                                |
| ----------------------------- | ------------------------------------------ | ------------------------------------ |
| Toolbar Export / Draft / More | `#app-overlay-layer`                       | `OverlayAnchoredMenu`                |
| Book menu + Recent            | `#app-overlay-layer`                       | Two overlays; Recent `right-start`   |
| Review view filter            | `#app-overlay-layer`                       | Outside-click checks teleported menu |
| Open-book / no-room toast     | `#app-overlay-layer`                       | Same live region behavior (#79, #98) |
| Pairing                       | `#app-overlay-layer`                       | Batch `alertdialog`                  |
| Editor toolbar / review rail  | `#toolbar-slot`, `#continuous-review-rail` | Stable Teleport targets              |
| Outline context menu          | `body`                                     | Unchanged                            |
| Spell / overlap / find        | Editor-local                               | Unchanged                            |

---

## 2. Remount / keys

`ContinuousManuscript` `:key="\`${sec.docId}#${reloadToken}\`"` — reload only on explicit Reload. Comment meta refresh does not change section key.

---

## 3. Focus policy (landed)

- Skip row/editor refocus when activation target is input, textarea, button, `[contenteditable]`, or reply composer.
- Reply form stops propagation on click.
- Overflow menu: **Esc** handled on teleported menu (`EditorToolbar.onMenuKey`).

---

## 4. Tests

| Test                        | File                                                   | Status |
| --------------------------- | ------------------------------------------------------ | ------ |
| Toolbar survives navigation | `App.toolbar-261.test.ts`                              | Pass   |
| Reply focus (#264)          | `overlay-regressions.test.ts`                          | Pass   |
| Export in overlay (#267)    | `overlay-regressions.test.ts`                          | Pass   |
| Batch pairing (#269)        | `overlay-regressions.test.ts`, `PairingPrompt.test.ts` | Pass   |
| Duplicate name (#270)       | `overlay-regressions.test.ts`, `PairingPrompt.test.ts` | Pass   |

---

## 5. Original recommended rollout (reference)

Steps 1–5 from the pre-implementation audit are **done in #273** except **#268** (overflow toolbar logic). Step 6 (#268) remains a separate PR.
