# RAD-160 format-change evidence

Designer screenshots for the review format card and inline `format_change` mark styling.

- `format-card-light.png` — light theme (`format-card.html` with default tokens)
- `format-card-dark.png` — dark theme (`data-theme="dark"` on `<html>`)

Regenerate:

```sh
google-chrome --headless --disable-gpu --window-size=448,320 \
  --screenshot=docs/pr-evidence/rad-160/format-card-light.png \
  file://$PWD/docs/pr-evidence/rad-160/format-card.html
```
