/**
 * Content node and mark names the editor works with (docs/mvp-spec.md section 7).
 *
 * These mirror the shared content model. Main's `@coauthor/schema` does not ship the
 * ProseMirror JSON types yet (they arrive with the .docx import work), so the editor keeps
 * the names it needs here. Once they land in the schema package, this file should re-export
 * from there instead.
 */
export const PARAGRAPH_STYLES = [
  'body',
  'first',
  'block_quote',
  'epigraph',
  'verse',
  'centered',
] as const;
export type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number];

export const PARAGRAPH_STYLE_LABELS: Record<ParagraphStyle, string> = {
  body: 'Body',
  first: 'First paragraph',
  block_quote: 'Block quote',
  epigraph: 'Epigraph',
  verse: 'Verse',
  centered: 'Centered',
};

/** Marks a writer applies while drafting. */
export const FORMAT_MARKS = ['bold', 'italic', 'smallcaps', 'underline', 'strike', 'link'] as const;
/** Review marks: comments and tracked changes. Shown in the editor, never edited there. */
export const REVIEW_MARKS = ['comment_anchor', 'suggestion_insert', 'suggestion_delete'] as const;
export const SUGGESTION_MARKS = ['suggestion_insert', 'suggestion_delete'] as const;
export type ReviewMarkType = (typeof REVIEW_MARKS)[number];

export interface JSONMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/**
 * Key a mark is stored under in Yjs text attributes. Review marks can overlap with another
 * mark of the same type, so they are keyed `type--id` (same rule as packages/docx ydoc.ts);
 * every other mark is keyed by its type.
 */
export function markKey(m: JSONMark): string {
  const id = m.attrs?.id;
  return (REVIEW_MARKS as readonly string[]).includes(m.type) && typeof id === 'string' && id
    ? `${m.type}--${id}`
    : m.type;
}

export function markTypeFromKey(key: string): string {
  const i = key.indexOf('--');
  return i < 0 ? key : key.slice(0, i);
}
