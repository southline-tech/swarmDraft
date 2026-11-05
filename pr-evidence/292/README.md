# PR #292 — swarmdraft.ai landing evidence

Full-page captures (serve `site/` locally; `./capture.sh` starts a temp server on port 8770):

| File                         | Viewport  | Theme                                        |
| ---------------------------- | --------- | -------------------------------------------- |
| `landing-desktop-light.png`  | 1280×3600 | `#light`                                     |
| `landing-desktop-dark.png`   | 1280×3600 | `#dark`                                      |
| `landing-mobile-light.png`   | 390×4200  | `#light`                                     |
| `landing-mobile-dark.png`    | 390×4200  | `#dark`                                      |
| `landing-download-focus.png` | 1280×720  | focus on header Download (`?focus=download`) |

Lighthouse JSON and `lighthouse-scores.txt` document accessibility runs.

Hero install note: body text uses `--ct-text` on `--ct-warning-bg` (~4.7:1 in light theme).
