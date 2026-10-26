# EXPECTED — mock-manuscript.docx (ground truth for RAD-218 import tests)

## Front matter (in order, separated by page breaks)

1. Title page: "THE LANTERNS OF HOLLOW REACH" / "A Novel" / author "Rowan Ashby Vale" (direct formatting, not Title style)
2. Copyright page (4 paras, 10pt)
3. Dedication: "For the ones who kept the lamps lit." (italic, centered)
4. Epigraph (italic, centered) + attribution line with em dash
5. Table of contents: plain typed paragraphs with tabs (NOT a TOC field) — should be detected as front matter, not as chapters

A NEW_PAGE section break follows the front matter. Body section has header text and a centered PAGE field footer.

## Parts and chapters (12 chapters)

Chapter markers: `h1` = Heading 1 style; `bold` = plain centered bold 18pt line; `words` = plain centered 16pt Georgia line, number spelled out.

### Part One: The Bell That Stopped (centered bold 20pt paragraph, direct formatting)

- Ch 1: `Chapter 1: Low Tide` [h1] — 3 scenes; breaks: '***', '#'
- Ch 2: `Chapter 2` [bold] — 3 scenes; breaks: '* * *', 'BLANK2'
- Ch 3: `CHAPTER THREE` [words] — 3 scenes; breaks: '❦', '***'
- Ch 4: `Chapter 4: The Ledger` [h1] — 3 scenes; breaks: '#', '* * *'

### Part Two: Salt and Lamplight (centered bold 20pt paragraph, direct formatting)

- Ch 5: `Chapter 5` [bold] — 2 scenes; breaks: 'BLANK2'
- Ch 6: `CHAPTER SIX` [words] — 2 scenes; breaks: '❦'
- Ch 7: `Chapter 7` [bold] — 3 scenes; breaks: '***', '#'
- Ch 8: `CHAPTER EIGHT` [words] — 2 scenes; breaks: '* * *'

### Part Three: The Twelfth Boat (centered bold 20pt paragraph, direct formatting)

- Ch 9: `Chapter 9: Blue Flame` [h1] — 3 scenes; breaks: 'BLANK2', '❦'
- Ch 10: `CHAPTER TEN` [words] — 3 scenes; breaks: '***', '#'
- Ch 11: `Chapter 11` [bold] — 2 scenes; breaks: '* * *'
- Ch 12: `Chapter 12: Morning, Finally` [h1] — 2 scenes; breaks: 'BLANK2'

Back matter: `Acknowledgments` (Heading 1) — must NOT be counted as chapter 13.

## Scene break forms

- `'***'` literal paragraph (left aligned)
- `'#'` centered
- `'* * *'` centered
- `BLANK2` = two consecutive empty paragraphs (note: empty paragraphs also appear after every chapter heading as spacing and must NOT be read as breaks)
- `'❦'` (U+2766) centered ornament

Total scene breaks: 19

## Inline / special content (end of Chapter 12, before Acknowledgments)

- Letter: italic paragraph with 1in left/right indents (direct formatting)
- Block quote: `Quote` style paragraph
- Text-message exchange: 4 paras, sender names bold + small caps, one emoji
- Small caps run "the keeper’s knot" and bold "not"
- Tracked change: paragraph "The boats were counted at dawn by the harbormaster." has insertion " Twice." and deletion " Once was never enough." (author Fixture Editor)
- Footnote id 1 attached after "harbormaster."
- Comment on "Fenwick swore the lamp..." paragraph: present

## Messiness present throughout body

- Normal style hard-overridden to Garamond 12pt; runs randomly in Times New Roman / Calibri / Georgia
- Indents via leading tab, via 5 spaces, and via first-line-indent
- Manual line breaks (<w:br/>) inside paragraphs; page breaks as runs in empty paragraphs
- Italic thoughts mid-paragraph; mixed smart and straight quotes; em dash (—) and double hyphen (--) both used

## Edge-case files

- `edge-no-headings.docx`: 3 pages separated by page breaks, no chapter markers. Expect 0 detected chapters (importer should fall back to a single chapter/report, not invent chapters).
- `edge-false-positives.docx`: expect 1 chapter from Heading 1 "Chapter One"; empty Heading 1 ignored; "Notes to self" (H2) is not a chapter; inline "Chapter 2 ..." sentence is body text; bold 11pt "CHAPTER TWO" is ambiguous (acceptable as chapter 2 if flagged in import report); "*** not a break..." is body text, not a scene break.
- `edge-soft-breaks-only.docx`: a single paragraph whose lines are split by manual line breaks (<w:br/>), including "Chapter 1" and "* * *". Expect importer to preserve text and line breaks; detecting chapters/breaks inside one paragraph is optional but must not drop text.
