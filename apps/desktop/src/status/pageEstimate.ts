/** Estimated manuscript pagination for the status footer (#216). */
export const WORDS_PER_PAGE = 250;

export function estimatedPageTotal(bookWordCount: number): number {
  return Math.max(1, Math.ceil(bookWordCount / WORDS_PER_PAGE));
}

/** Current page from words before the caret in the whole book (caret at start → page 1). */
export function estimatedCurrentPage(
  wordsBeforeCaretInBook: number,
  bookWordCount: number,
): number {
  const total = estimatedPageTotal(bookWordCount);
  const raw = Math.ceil(wordsBeforeCaretInBook / WORDS_PER_PAGE);
  return Math.min(total, Math.max(1, raw || 1));
}

export const PAGE_ESTIMATE_TOOLTIP = 'Estimated manuscript page (~250 words). Not print layout.';

export function pageStatusLabel(
  current: number,
  total: number,
  narrow: boolean,
): { visible: string; ariaLabel: string } {
  const ariaLabel = `Estimated page ${current} of ${total}`;
  const visible = narrow ? `p. ${current}` : `Page ${current} of ${total}`;
  return { visible, ariaLabel };
}
