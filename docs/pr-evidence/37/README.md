# Issue #37 — residual hard-coded colors → `--ct-*` tokens

Designer checklist (issue comment): outline selected row (`--ct-selected-bg` / `--ct-accent`), focus-visible (`--ct-focus-outline`), CommentsPanel `.warn` (`--ct-warning`) and quote background (`--ct-comment-bg`).

## Screenshots (light + dark)

Generated from `evidence.html` via `./capture.sh`:

- `outline-selected-light.png` / `outline-selected-dark.png`
- `comments-quote-light.png` / `comments-quote-dark.png`
- `focus-ring-light.png` / `focus-ring-dark.png`

Toggle theme with `?theme=dark` on the evidence page (same pattern as other `docs/pr-evidence/*/evidence.html` files).

## Automated audit

`apps/desktop/src/styles/design-tokens-sweep.test.ts` walks every shipped `.vue` / `.css` under `apps/desktop/src` (except `tokens.css` definitions) and asserts no hex/rgb font stacks and only defined `--ct-*` variables.
