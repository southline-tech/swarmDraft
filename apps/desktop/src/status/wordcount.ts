/**
 * Word counts for the status bar (RAD-256). A word is a run of letters or digits, optionally
 * joined by an apostrophe or hyphen ("don't", "well-worn"), so punctuation and scene-break
 * asterisks never count.
 */
import * as Y from 'yjs';
import type { Section } from '@coauthor/schema';

const WORD = /[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu;

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/** Plain text of a Yjs XML tree, with a space between blocks so words never run together. */
function xmlText(node: Y.XmlFragment | Y.XmlElement | Y.XmlText, out: string[]): void {
  if (node instanceof Y.XmlText) {
    for (const op of node.toDelta() as { insert: unknown }[]) {
      if (typeof op.insert === 'string') out.push(op.insert);
    }
    return;
  }
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText || child instanceof Y.XmlElement) xmlText(child, out);
    out.push(' ');
  }
}

/** Words in one section doc (the ProseMirror fragment the editor binds to). */
export function docWordCount(doc: Y.Doc, field = 'prosemirror'): number {
  const out: string[] = [];
  xmlText(doc.getXmlFragment(field), out);
  return countWords(out.join(''));
}

/** Words across every section doc of the manuscript. */
export function bookWordCount(docs: Iterable<Y.Doc>, field = 'prosemirror'): number {
  let n = 0;
  for (const d of docs) n += docWordCount(d, field);
  return n;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Live book count: recounts (debounced, so typing is never blocked) whenever any section doc
 * changes. Returns a stop function that removes the observers.
 */
export function watchBookWords(
  docs: Iterable<Y.Doc>,
  onCount: (n: number) => void,
  delayMs = 300,
): () => void {
  const list = [...docs];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const recount = () => onCount(bookWordCount(list));
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(recount, delayMs);
  };
  recount();
  for (const d of list) d.on('update', schedule);
  return () => {
    clearTimeout(timer);
    for (const d of list) d.off('update', schedule);
  };
}

/**
 * The docs that make up a section and everything under it (a chapter and its scenes), in outline
 * order, so "words in chapter" covers the whole chapter, not just its heading doc.
 */
export function sectionTreeDocs(
  outline: readonly Section[],
  id: string | undefined,
  docs: ReadonlyMap<string, Y.Doc>,
): Y.Doc[] {
  if (!id) return [];
  const inTree = new Set([id]);
  const out: Y.Doc[] = [];
  for (const s of outline) {
    if (s.id !== id && !(s.parentId && inTree.has(s.parentId))) continue;
    inTree.add(s.id);
    const d = docs.get(s.docId);
    if (d) out.push(d);
  }
  return out;
}
