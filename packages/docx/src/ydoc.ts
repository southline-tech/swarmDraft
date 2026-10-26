/**
 * ProseMirror JSON <-> Yjs, using the same encoding as y-prosemirror
 * (Y.XmlFragment named "prosemirror"; nodes are Y.XmlElement, marks are
 * Y.XmlText format attributes keyed by mark type, or `type--<8 hex of id>` for marks
 * that may overlap with another of the same type, as y-prosemirror does).
 */
import * as Y from 'yjs';
import { NON_EXCLUSIVE_MARKS } from '@coauthor/schema';
import { sortMarks, type DocNode, type InlineNode, type Mark } from './model';
import type { ImportedManuscript } from './import';

export const FRAGMENT_NAME = 'prosemirror';

/** 8 hex chars of 32-bit FNV-1a over the id's UTF-8 bytes (y-prosemirror reads `--` + 8 chars as an overlap hash). */
export function markIdHash(id: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(id)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export function markKey(m: Mark): string {
  // Comment and suggestion ids are unique, so `type--hash(id)` is unique per item; the 8-char suffix is what y-prosemirror parses.
  return NON_EXCLUSIVE_MARKS.includes(m.type) && 'attrs' in m && 'id' in m.attrs
    ? `${m.type}--${markIdHash(String(m.attrs.id))}`
    : m.type;
}

export function markTypeFromKey(key: string): string {
  const i = key.indexOf('--');
  return i < 0 ? key : key.slice(0, i);
}

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
      for (const m of n.marks ?? []) attrs[markKey(m)] = 'attrs' in m ? m.attrs : {};
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

/** One Y.Doc per section, keyed by the section's docId. */
export function manuscriptToYDocs(m: ImportedManuscript): Map<string, Y.Doc> {
  return new Map(m.sections.map((s) => [s.docId, docToYDoc(s.content)]));
}

export type { InlineNode };
