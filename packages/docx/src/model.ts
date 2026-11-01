/** Helpers over the shared content model in @swarmdraft/schema. */
import type { DocNode, NoteKind, InlineNode, Mark, TextNode } from '@swarmdraft/schema';
import { MARK_TYPES } from '@swarmdraft/schema';

export type * from '@swarmdraft/schema';

export function sortMarks(marks: Mark[]): Mark[] {
  const rank = (m: Mark) => (MARK_TYPES as readonly string[]).indexOf(m.type);
  const key = (m: Mark) => ('attrs' in m ? JSON.stringify(m.attrs) : '');
  return [...marks].sort(
    (a, b) => rank(a) - rank(b) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0),
  );
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

export interface ReadView {
  /** Section text, one block per line; footnotes appear as `[^id]`, endnotes as `[^eid]`, images as `[image: alt]`. */
  text: string;
  footnotes: { id: string; kind: NoteKind; text: string }[];
}

/**
 * Read-side representation of a section for agents (MCP `read_section`, RAD-209 consumes this).
 * Footnotes are exposed inline as `[^id]` markers plus a `footnotes` list.
 */
export function readView(doc: DocNode): ReadView {
  const footnotes: ReadView['footnotes'] = [];
  const line = (nodes: InlineNode[] | undefined) =>
    (nodes ?? [])
      .map((n) => {
        if (n.type === 'text') return n.text;
        if (n.type === 'hard_break') return '\n';
        if (n.type === 'image') return `[image: ${n.attrs.alt}]`;
        footnotes.push({ id: n.attrs.id, kind: n.attrs.kind, text: n.attrs.text });
        return n.attrs.kind === 'endnote' ? `[^e${n.attrs.id}]` : `[^${n.attrs.id}]`;
      })
      .join('');
  const lines = doc.content.map((b) =>
    b.type === 'scene_break'
      ? b.attrs.marker || '* * *'
      : b.type === 'page_break'
        ? ''
        : line(b.content),
  );
  return { text: lines.join('\n'), footnotes };
}
