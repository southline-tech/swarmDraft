/** Book-wide section numbering display (#111). Numbers are computed from outline order, not stored. */
export const NUMBERING_STYLES = [
  'chapter_arabic',
  'chapter_words',
  'chapter_upper',
  'number_only',
] as const;
export type NumberingStyle = (typeof NUMBERING_STYLES)[number];

/** Provisional default until Brett confirms on #111; matches pre-#111 UI (Chapter One, …). */
export const DEFAULT_NUMBERING_STYLE: NumberingStyle = 'chapter_words';

export function isNumberingStyle(value: string): value is NumberingStyle {
  return (NUMBERING_STYLES as readonly string[]).includes(value);
}
