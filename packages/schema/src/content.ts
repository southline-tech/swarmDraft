/**
 * Shared document content model (docs/mvp-spec.md section 7): ProseMirror JSON shapes used by
 * the editor, the .docx importer/exporter and the MCP read tools.
 * `hard_break`, inline `footnote` (with rich note content), `image` placeholders, and
 * `underline`/`strike` marks were added for faithful Word import (RAD-218).
 */
export type ParagraphStyle = 'body' | 'first' | 'block_quote' | 'epigraph' | 'verse' | 'centered';

export type Mark =
  | { type: 'italic' }
  | { type: 'bold' }
  | { type: 'smallcaps' }
  | { type: 'underline' }
  | { type: 'strike' }
  | { type: 'link'; attrs: { href: string } }
  | { type: 'comment_anchor'; attrs: { id: string } }
  | { type: 'suggestion_insert'; attrs: { id: string; author: string; ts: string } }
  | { type: 'suggestion_delete'; attrs: { id: string; author: string; ts: string } };

export interface TextNode {
  type: 'text';
  text: string;
  marks?: Mark[];
}
export interface HardBreakNode {
  type: 'hard_break';
}
/** Inline note reference. `content` keeps the note's paragraphs and formatting; `text` is a plain copy. */
export interface FootnoteNode {
  type: 'footnote';
  attrs: { id: string; kind: NoteKind; text: string; content: ParagraphNode[] };
}
export type NoteKind = 'footnote' | 'endnote';
/** Placeholder for an image/object that is not imported yet (alt = description if any). */
export interface ImageNode {
  type: 'image';
  attrs: { alt: string };
}
export type InlineNode = TextNode | HardBreakNode | FootnoteNode | ImageNode;

export interface ParagraphNode {
  type: 'paragraph';
  attrs: { style: ParagraphStyle };
  content?: InlineNode[];
}
export interface HeadingNode {
  type: 'heading';
  attrs: { level: number };
  content?: InlineNode[];
}
export interface SceneBreakNode {
  type: 'scene_break';
  /** Original marker text ('***', '#', '❦', ...) or '' for a blank-line break. */
  attrs: { marker: string };
}
export interface PageBreakNode {
  type: 'page_break';
}
export type BlockNode = ParagraphNode | HeadingNode | SceneBreakNode | PageBreakNode;

export interface DocNode {
  type: 'doc';
  content: BlockNode[];
}

export const BLOCK_NODE_TYPES = ['paragraph', 'heading', 'scene_break', 'page_break'] as const;
export const INLINE_NODE_TYPES = ['text', 'hard_break', 'footnote', 'image'] as const;
export const MARK_TYPES = [
  'bold',
  'italic',
  'smallcaps',
  'underline',
  'strike',
  'link',
  'comment_anchor',
  'suggestion_insert',
  'suggestion_delete',
] as const satisfies readonly Mark['type'][];

/** Marks that may overlap with another mark of the same type (keyed `type--hash` in Yjs). */
export const NON_EXCLUSIVE_MARKS: readonly Mark['type'][] = [
  'comment_anchor',
  'suggestion_insert',
  'suggestion_delete',
];
