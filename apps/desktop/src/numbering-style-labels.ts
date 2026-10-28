import { NUMBERING_STYLES, type NumberingStyle } from '@coauthor/schema';

/** Human labels for the book-wide numbering style picker (#111). */
export const NUMBERING_STYLE_LABELS: Record<NumberingStyle, string> = {
  chapter_arabic: 'Chapter 1',
  chapter_words: 'Chapter One',
  chapter_upper: 'ONE',
  number_only: '1 only',
};

export { NUMBERING_STYLES };
