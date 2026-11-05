# PR #292 — swarmdraft.ai landing evidence

Full-page captures (`./capture.sh` serves `site/` on port 8770, then crops empty tail with `crop-screenshots.py`):

| File                         | Size (after crop) | Theme                                         |
| ---------------------------- | ----------------- | --------------------------------------------- |
| `landing-desktop-light.png`  | 1280×1315         | `#light`                                      |
| `landing-desktop-dark.png`   | 1280×1315         | `#dark`                                       |
| `landing-mobile-light.png`   | 390×2492          | `#light`                                      |
| `landing-mobile-dark.png`    | 390×2492          | `#dark`                                       |
| `landing-download-focus.png` | 1280×720          | `#light`, `?focus=download` (header viewport) |

Lighthouse JSON and `lighthouse-scores.txt` document accessibility runs.

Hero install note: body text uses `--ct-text` on `--ct-warning-bg` (~4.7:1 in light theme).
