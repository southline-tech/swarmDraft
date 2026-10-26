/**
 * ProseMirror JSON shapes for the shared document schema (docs/mvp-spec.md §7).
 * Additions needed for faithful import: `hard_break` and inline `footnote`.
 */
export type ParagraphStyle = 'body' | 'first' | 'block_quote' | 'epigraph' | 'verse' | 'centered';

export type Mark =
  | { type: 'italic' }
  | { type: 'bold' }
  | { type: 'smallcaps' }
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
export interface FootnoteNode {
  type: 'footnote';
  attrs: { id: string; text: string };
}
export type InlineNode = TextNode | HardBreakNode | FootnoteNode;

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

const MARK_ORDER = [
  'bold',
  'italic',
  'smallcaps',
  'link',
  'comment_anchor',
  'suggestion_insert',
  'suggestion_delete',
];

export function sortMarks(marks: Mark[]): Mark[] {
  return [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

function sameMarks(a: Mark[] = [], b: Mark[] = []): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Merge adjacent text nodes with identical marks and drop empty ones. */
export function normalizeInline(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      if (!n.text) continue;
      const prev = out[out.length - 1];
      if (prev && prev.type === 'text' && sameMarks(prev.marks, n.marks)) {
        prev.text += n.text;
        continue;
      }
      const copy: TextNode = { type: 'text', text: n.text };
      if (n.marks && n.marks.length) copy.marks = sortMarks(n.marks);
      out.push(copy);
    } else out.push(n);
  }
  return out;
}

export function plainText(nodes: InlineNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => (n.type === 'text' ? n.text : n.type === 'hard_break' ? '\n' : ''))
    .join('');
}
