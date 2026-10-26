# coAuthor design system

Tokens live as CSS custom properties in `apps/desktop/src/styles/tokens.css` and are exposed as a Tailwind v4 theme with `@theme inline` in `apps/desktop/src/styles/app.css` (imported once in `main.ts`). Tailwind is added with `@tailwindcss/vite`, using only its theme and utilities layers. Preflight is skipped so existing component CSS keeps working. All raw tokens use the `--ct-` prefix; the Tailwind theme maps them to utility names. Utilities: `bg-paper`, `text-muted`, `font-manuscript`, `shadow-2`, `rounded-md`, `p-4` (4px grid), and `dark:` for `[data-theme=dark]`. Because the utilities read the variables, switching themes needs no rebuild.

## Type

- **Manuscript:** Literata (`--ct-font-manuscript`) 400, 400 italic, 700. Body `--ct-text-page` (18px), `--ct-leading-body` 1.6, measure `--ct-measure-page` 66ch.
- **UI:** Inter (`--ct-font-ui`) 400 / 500 / 600.
- **Scale:** modular 1.2 ratio: `xs .694` · `sm .833` · `md 1` · `lg 1.2` · `xl 1.44` · `2xl 1.728` · `3xl 2.074` rem.
- Fonts ship as local woff2 Latin subsets with their OFL licenses in `apps/desktop/src/styles/fonts/literata/` and `fonts/inter/` (each with `OFL.txt`, sourced from the `@fontsource/literata` and `@fontsource/inter` npm packages, v5.3.0). No network font loading. Add a weight only when a token uses it.

## Color

- Light: warm paper (`--ct-paper #FBF8F3`) on a slightly darker chrome (`--ct-bg`). Text 14:1, muted 5.7:1.
- Dark: set `data-theme="dark"` on `<html>`. Every token has a dark value, so components need no changes.
- Semantic: `accent`, `selected-bg`, `danger`, `warning`, `success` (each with `-bg`), `comment-bg`.

## Spacing, radius, elevation

- Spacing is a 4px grid: `--ct-space-1` (4) … `--ct-space-16` (64).
- Radius: `sm 4` (controls) · `md 8` (cards, menus) · `lg 12` (dialogs) · `full`.
- Elevation: `1` page/cards · `2` menus/popovers · `3` modals (with `--ct-scrim`).

## Focus

`:focus-visible` gets a 2px `--ct-focus-ring-color` outline with a 2px offset (6.1:1 on paper, 8:1 in dark). Use `--ct-focus-ring` (box-shadow) on rounded controls. Never remove focus without a visible replacement.

## Collaborators

Eight colors, `--ct-collab-1` (the author) to `--ct-collab-8` (bots, assigned in order). Each meets 4.5:1 against the page in its theme, so it can be used for underlines, swatches and names. Always show a name or initials next to the color.

| token                | light   | dark    |
| -------------------- | ------- | ------- |
| ct-collab-1 (author) | #2F5DA8 | #8DB2F2 |
| ct-collab-2          | #A1452A | #F0A07F |
| ct-collab-3          | #2E7D4F | #7FD1A0 |
| ct-collab-4          | #7A4BB0 | #C7A6F2 |
| ct-collab-5          | #A8336B | #F29BC4 |
| ct-collab-6          | #8A6200 | #E3C066 |
| ct-collab-7          | #1F7A85 | #7FD3DC |
| ct-collab-8          | #5C6670 | #B4BDC6 |

## Suggestions

Set `--ct-suggester: var(--collab-N)` on the mark element.

- **Insert:** `background: var(--ct-suggest-insert-bg)` plus `text-decoration: underline 2px var(--ct-suggest-insert-underline)`.
- **Delete:** `text-decoration: line-through var(--ct-suggest-delete-strike)`, `color: var(--ct-suggest-delete-text)`, `background: var(--ct-suggest-delete-bg)`.
- Never color-only: the underline and strikethrough carry the meaning, and hover or focus shows the suggester's name and the change type.

## Voice

Plain, kind language for a novelist. No file paths or internal IDs in the main UI; put them behind "Details".
