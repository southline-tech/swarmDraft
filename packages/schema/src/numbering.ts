/** Book-wide section numbering display (#111). Numbers are computed from outline order, not stored. */
export const NUMBERING_STYLES = [
  'chapter_arabic',
  'chapter_words',
  'chapter_upper',
  'number_only',
] as const;
export type NumberingStyle = (typeof NUMBERING_STYLES)[number];

/** Book-wide default (#111): arabic chapters with roman part labels in the editor. */
export const DEFAULT_NUMBERING_STYLE: NumberingStyle = 'chapter_arabic';

export function isNumberingStyle(value: string): value is NumberingStyle {
  return (NUMBERING_STYLES as readonly string[]).includes(value);
}
