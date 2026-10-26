/**
 * ProseMirror JSON <-> Yjs, using the same encoding as y-prosemirror
 * (Y.XmlFragment named "prosemirror"; nodes are Y.XmlElement, marks are
 * Y.XmlText format attributes keyed by mark type, or `type--<8 hex>` (see
 * markKeys in @coauthor/schema) for marks that may overlap another of the same type).
 */
import * as Y from 'yjs';
import { markKeys, markTypeFromKey } from '@coauthor/schema';
import { sortMarks, type DocNode, type InlineNode, type Mark } from './model';
import type { ImportedManuscript } from './import';

export const FRAGMENT_NAME = 'prosemirror';

export { markKey, markTypeFromKey } from '@coauthor/schema';

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: Mark[];
}

function fill(parent: Y.XmlFragment | Y.XmlElement, nodes: PMNode[]): void {
  const items: (Y.XmlElement | Y.XmlText)[] = [];
  let pendingText: PMNode[] = [];
  const flushText = () => {
    if (!pendingText.length) return;
    const t = new Y.XmlText();
    let offset = 0;
    for (const n of pendingText) {
      const attrs: Record<string, unknown> = {};
      const marks = n.marks ?? [];
      markKeys(marks).forEach((k, i) => {
        const m = marks[i]!;
        attrs[k] = 'attrs' in m ? m.attrs : {};
      });
      t.insert(offset, n.text ?? '', attrs);
      offset += (n.text ?? '').length;
    }
    items.push(t);
    pendingText = [];
  };
  const children: [Y.XmlElement, PMNode][] = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      pendingText.push(n);
      continue;
    }
    flushText();
    const el = new Y.XmlElement(n.type);
    items.push(el);
    children.push([el, n]);
  }
  flushText();
  parent.insert(0, items);
  for (const [el, n] of children) {
    for (const [k, v] of Object.entries(n.attrs ?? {})) el.setAttribute(k, v as string);
    if (n.content?.length) fill(el, n.content);
  }
}

export function docToYDoc(doc: DocNode, ydoc: Y.Doc = new Y.Doc()): Y.Doc {
  ydoc.transact(() => fill(ydoc.getXmlFragment(FRAGMENT_NAME), doc.content as PMNode[]));
  return ydoc;
}

function read(el: Y.XmlFragment | Y.XmlElement): PMNode[] {
  const out: PMNode[] = [];
  for (const c of el.toArray()) {
    if (c instanceof Y.XmlText) {
      for (const d of c.toDelta() as { insert: string; attributes?: Record<string, unknown> }[]) {
        const marks = Object.entries(d.attributes ?? {}).map(([key, attrs]) => {
          const type = markTypeFromKey(key);
          return attrs && typeof attrs === 'object' && Object.keys(attrs).length
            ? ({ type, attrs } as Mark)
            : ({ type } as Mark);
        });
        out.push(
          marks.length
            ? { type: 'text', text: d.insert, marks: sortMarks(marks) }
            : { type: 'text', text: d.insert },
        );
      }
    } else if (c instanceof Y.XmlElement) {
      const node: PMNode = { type: c.nodeName };
      const attrs = c.getAttributes();
      if (Object.keys(attrs).length) node.attrs = attrs;
      const content = read(c);
      if (content.length) node.content = content;
      out.push(node);
    }
  }
  return out;
}

export function yDocToDoc(ydoc: Y.Doc): DocNode {
  return { type: 'doc', content: read(ydoc.getXmlFragment(FRAGMENT_NAME)) as DocNode['content'] };
}

function texts(el: Y.XmlFragment | Y.XmlElement, out: Y.XmlText[] = []): Y.XmlText[] {
  for (const c of el.toArray()) {
    if (c instanceof Y.XmlText) out.push(c);
    else if (c instanceof Y.XmlElement) texts(c, out);
  }
  return out;
}

/**
 * Re-key mark attributes written in an older form (e.g. `comment_anchor--c1` from RAD-218) to
 * the current `type--<8 base64>` keys, keeping each mark's attrs (and so its id). Idempotent:
 * returns the number of text runs changed, 0 when the doc is already current. Runs in one
 * transaction with origin `REKEY_ORIGIN`.
 */
export const REKEY_ORIGIN = 'coauthor:rekey-marks';
export function rekeyMarks(ydoc: Y.Doc): number {
  const ops: [Y.XmlText, number, number, Record<string, unknown>][] = [];
  for (const t of texts(ydoc.getXmlFragment(FRAGMENT_NAME))) {
    let index = 0;
    for (const d of t.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
      const len = typeof d.insert === 'string' ? d.insert.length : 1;
      const entries = Object.entries(d.attributes ?? {});
      const marks = entries.map(([k, attrs]) => ({
        type: markTypeFromKey(k),
        attrs: (attrs && typeof attrs === 'object' ? attrs : {}) as Record<string, unknown>,
      }));
      const keys = markKeys(marks);
      if (entries.some(([k], i) => k !== keys[i])) {
        const fmt: Record<string, unknown> = {};
        for (const [k] of entries) fmt[k] = null;
        entries.forEach(([, v], i) => (fmt[keys[i]!] = v));
        ops.push([t, index, len, fmt]);
      }
      index += len;
    }
  }
  if (ops.length)
    ydoc.transact(() => ops.forEach(([t, i, l, f]) => t.format(i, l, f)), REKEY_ORIGIN);
  return ops.length;
}

/** One Y.Doc per section, keyed by the section's docId. */
export function manuscriptToYDocs(m: ImportedManuscript): Map<string, Y.Doc> {
  return new Map(m.sections.map((s) => [s.docId, docToYDoc(s.content)]));
}

export type { InlineNode };
