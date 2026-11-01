# Issue 177 — per-author view switcher

Mockup folder: [ov1 switcher](https://drive.google.com/drive/folders/1e1Nqr2yXBuJuDcDb6bmFK4mMsxkcazrT) (frames ov1–ov4; this PR implements ov1 only).

## Screenshots (light + dark)

Capture from `evidence.html` in a browser or from the running app with ≥2 authors’ suggestions:

- `switcher-all-light.png` / `switcher-all-dark.png` — radiogroup with **All (N)** selected
- `switcher-one-author-light.png` / `switcher-one-author-dark.png` — single author selected; other authors hidden in manuscript

Set `data-theme="dark"` on `<html>` for dark captures (see other `docs/pr-evidence/*/evidence.html` patterns).

## Manual smoke (Windows)

1. Open a manuscript with suggestions from at least two authors.
2. Confirm **Show changes from** radiogroup: All + each author with chip and count.
3. Select one author — other marks hidden in text and margin; **Accept all from …** label updates.
4. **Alt+]** / **Alt+[** cycle views; live region announces scope.
