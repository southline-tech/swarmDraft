# Performance notes — continuous manuscript (#107)

## What we ship

One Tiptap + Yjs binding per section, all mounted in a single scroll container (`ContinuousManuscript`). There is no list virtualization.

## Fixtures checked (Oct 2026)

| Fixture                                                 | Sections (approx.) | Editors mounted |
| ------------------------------------------------------- | ------------------ | --------------- |
| `fixtures/manuscripts/docx-import/mock-manuscript.docx` | 16 outline rows    | 16              |

A full novel (dozens of chapters plus front/back matter) scales **linearly** with section count: memory and initial mount time grow with N editors.

## Recommendation

- **MVP / mock-manuscript scale:** acceptable without virtualization.
- **Full-length novel (50+ sections):** profile on a representative import before release; if mount or scroll jank appears, open a follow-up for **section list virtualization** (keep one active “lead” editor for toolbar/find, or virtualize ProseMirror mounts only).

No virtualization in #107; reassess when a large synthetic or author QA manuscript is available.
