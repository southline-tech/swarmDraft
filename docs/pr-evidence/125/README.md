# PR evidence — #125 Scene break display

Designer screenshots: centered `* * *` on the manuscript page (`--ct-text` on `--ct-paper`), with tracked-change marks on the paragraph above (sample doc excerpt).

- `scene-break-light.png` — light theme (default tokens)
- `scene-break-dark.png` — dark theme (`data-theme="dark"` on `<html>`)

Source harness: `scene-break.html` (mirrors `ManuscriptEditor` `.tiptap .scene-break` and suggestion paint).

Regenerate:

```sh
cd /path/to/repo
google-chrome --headless --disable-gpu --window-size=640,720 \
  --screenshot=docs/pr-evidence/125/scene-break-light.png \
  file://$PWD/docs/pr-evidence/125/scene-break.html
google-chrome --headless --disable-gpu --window-size=640,720 \
  --screenshot=docs/pr-evidence/125/scene-break-dark.png \
  'file://'"$PWD"'/docs/pr-evidence/125/scene-break.html?theme=dark'
```
