# PR evidence — #55 Focus mode (wp5)

Designer screenshots for wp5 focus mode. Captured from the production App shell with a manuscript open (not shells preview or editor-only):

```text
pnpm --filter @coauthor/desktop dev
# light: http://localhost:1420/?evidence=rad55&theme=light
# dark:  http://localhost:1420/?evidence=rad55&theme=dark
```

Files:

- `wp5-light.png` — focus pill, manuscript page, word count; no top bar, outline, toolbar, review, or status bar; no empty strip below the page (`.shell--focus-mode` drops the 1.75rem status-bar reserve)
- `wp5-dark.png` — same layout in dark theme

Re-capture after any change to focus-mode chrome (`sh-esc`, `sh-fwc`, App focus-mode layout, or shell padding).
