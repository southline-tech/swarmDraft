# PR evidence — #245 Wave 6a toolbar

Designer mockups: [drafts-toolbar-mockups](https://drive.google.com/drive/folders/1QJR03VtMlU8pYIu9nJwLn6QtesS7NkUY) (tb1–tb3, light+dark).

## Checked frames

| Frame   | What we verified                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| **tb1** | Toolbar L→R: draft picker, formatting cluster, Track, Review, spacer, Export, Agents, theme, Settings gear |
| **tb3** | Export menu lists Word (.docx), PDF, Markdown                                                              |

## Theme

Automated tests assert `data-theme` toggles via `[data-test="toolbar-theme"]` in light and dark (`apps/desktop/src/toolbar/wave6-toolbar.test.ts`). Manual screenshots were not captured in this environment; re-run `pnpm dev` and grab light/dark captures of the toolbar row if Designer wants PNGs here.

## Settings

Export section removed from Settings nav; Appearance and Agents (keys) remain. Toolbar gear is always visible on the manuscript toolbar row (#232).
