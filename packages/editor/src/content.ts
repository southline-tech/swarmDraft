/**
 * Content node and mark names the editor works with (docs/mvp-spec.md section 7).
 * The shared model lives in `@coauthor/schema`; this file adds editor-only helpers.
 */
import type { ParagraphStyle } from '@coauthor/schema';

export type { ParagraphStyle } from '@coauthor/schema';
export {
  BLOCK_NODE_TYPES,
  INLINE_NODE_TYPES,
  MARK_TYPES,
  NON_EXCLUSIVE_MARKS,
} from '@coauthor/schema';

export const PARAGRAPH_STYLES = [
  'body',
  'first',
  'block_quote',
  'epigraph',
  'verse',
  'centered',
] as const satisfies readonly ParagraphStyle[];

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
export const REVIEW_MARKS = [
  'comment_anchor',
  'suggestion_insert',
  'suggestion_delete',
  'format_change',
] as const;
export const SUGGESTION_MARKS = [
  'suggestion_insert',
  'suggestion_delete',
  'format_change',
] as const;
export type ReviewMarkType = (typeof REVIEW_MARKS)[number];

export interface JSONMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export {
  markIdHash,
  markKey,
  markKeys,
  markTypeFromKey,
  MARK_ID_HASH_TEST_VECTOR,
} from '@coauthor/schema';
