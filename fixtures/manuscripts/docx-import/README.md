Original synthetic manuscripts (invented text, no real manuscript content) for the
`@swarmdraft/docx` import/export tests. `EXPECTED.md` is the ground truth the tests parse.

- `mock-manuscript.docx`: front matter, 3 parts, 12 chapters (heading-styled and direct-formatted),
  19 scene breaks in five forms, back matter, tracked changes, a comment and a footnote.
- `outline-display-titles.ts`: optional outline names for UI/tests (#111); import tests keep raw titles.
- `edge-no-headings.docx`, `edge-false-positives.docx`, `edge-soft-breaks-only.docx`: detection traps.
