# PR evidence — #299 import progress + #301 Import wording

Designer review: import loading card (ob6), home Import copy, book menu Import vs Open, cancel and error states.

**Real captures** at **1280×800** from the running app (`pnpm dev:web` or `pnpm tauri dev`) via Chrome DevTools (`scripts/evidence-299-real.mjs`), importing `fixtures/manuscripts/large-synthetic/large-synthetic.docx` (350+ chapter sections).

| File                        | Scene                                  |
| --------------------------- | -------------------------------------- |
| `home-import-wording.png`   | Home “Import Word manuscript”          |
| `progress-mid-big-file.png` | Indeterminate import progress + Cancel |
| `cancel-result.png`         | Home restored after cancel             |
| `error-state.png`           | Opening error card with Try again      |
| `book-menu-import-open.png` | Book menu: Open vs Import…             |

Re-capture:

1. `node fixtures/manuscripts/large-synthetic/build-docx.mjs` (if the fixture is missing)
2. Start the app: `pnpm dev:web` (or `pnpm tauri dev`)
3. `node scripts/evidence-299-real.mjs` (requires Chrome)
