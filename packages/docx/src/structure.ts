/**
 * The manuscript outline in Yjs: the manuscript doc (`manuscriptDocId`) holds a `structure`
 * Y.Array of section refs in reading order, one Y.Map per section with `id`, `kind`, `title`,
 * `docId` and (when nested) `parentId`. Section text lives in each section's own doc.
 *
 * Readers (the sidebar, the MCP server) list sections in array order. Writes go through
 * `writeStructure`, which applies the whole new outline in one Yjs transaction.
 */
import * as Y from 'yjs';
import { isSectionKind, type Section } from '@coauthor/schema';
import type { ImportedManuscript } from './import';
import { docToYDoc } from './ydoc';

export const STRUCTURE_FIELD = 'structure';
export const META_FIELD = 'meta';
export const STRUCTURE_ORIGIN = 'coauthor:structure';

type Ref = Y.Map<unknown>;
const structureOf = (doc: Y.Doc) => doc.getArray<Ref>(STRUCTURE_FIELD);

/**
 * Sections in stored order. Entries that are not a section ref (wrong shape, unknown kind,
 * missing id) are skipped; structural repair (cycles, nesting) is the outline's job.
 */
export function readStructure(doc: Y.Doc): Section[] {
  const out: Section[] = [];
  for (const m of structureOf(doc).toArray()) {
    if (!(m instanceof Y.Map)) continue;
    const id = m.get('id');
    const kind = m.get('kind');
    const docId = m.get('docId');
    if (typeof id !== 'string' || !id || typeof kind !== 'string' || !isSectionKind(kind)) continue;
    if (typeof docId !== 'string') continue;
    const title = m.get('title');
    const parentId = m.get('parentId');
    out.push({
      id,
      kind,
      title: typeof title === 'string' ? title : '',
      docId,
      ...(typeof parentId === 'string' && parentId ? { parentId } : {}),
    });
  }
  return out;
}

function setFields(m: Ref, s: Section) {
  for (const [k, v] of [
    ['id', s.id],
    ['kind', s.kind],
    ['title', s.title],
    ['docId', s.docId],
  ] as const)
    if (m.get(k) !== v) m.set(k, v);
  if (s.parentId === undefined) {
    if (m.has('parentId')) m.delete('parentId');
  } else if (m.get('parentId') !== s.parentId) m.set('parentId', s.parentId);
}

function refFor(s: Section): Ref {
  const entries: [string, unknown][] = [
    ['id', s.id],
    ['kind', s.kind],
    ['title', s.title],
    ['docId', s.docId],
  ];
  if (s.parentId !== undefined) entries.push(['parentId', s.parentId]);
  return new Y.Map<unknown>(entries);
}

/**
 * Store `sections` as the outline, in one transaction. When the rows are unchanged (same length
 * and the same docId at each index) every field, including a repaired id, is updated on the
 * existing Y.Map in place, so it merges with concurrent edits field by field (a rename on another
 * peer survives a duplicate-id repair here). When the order changes the array is rewritten with
 * fresh refs; a concurrent reorder on another peer
 * then resolves by Yjs ordering and readers repair duplicates (see the outline's normalize).
 */
export function writeStructure(doc: Y.Doc, sections: readonly Section[]): void {
  const arr = structureOf(doc);
  doc.transact(() => {
    const current = arr.toArray();
    const sameRows =
      current.length === sections.length &&
      current.every((m, i) => m instanceof Y.Map && m.get('docId') === sections[i]!.docId);
    if (sameRows) {
      current.forEach((m, i) => setFields(m, sections[i]!));
      return;
    }
    arr.delete(0, arr.length);
    arr.insert(0, sections.map(refFor));
  }, STRUCTURE_ORIGIN);
}

/** Call `cb` with the outline whenever it changes; returns an unsubscribe function. */
export function observeStructure(
  doc: Y.Doc,
  cb: (sections: Section[], origin: unknown) => void,
): () => void {
  const arr = structureOf(doc);
  const h = (_e: unknown, tr: Y.Transaction) => cb(readStructure(doc), tr.origin);
  arr.observeDeep(h);
  return () => arr.unobserveDeep(h);
}

export interface ManuscriptYDocs {
  /** The manuscript doc: `meta` (title, author) and `structure`. */
  manuscript: Y.Doc;
  /** One doc per section, keyed by docId. */
  sections: Map<string, Y.Doc>;
}

/** Build the manuscript doc (meta + structure) and the per-section docs for an import. */
export function importedToYDocs(m: ImportedManuscript): ManuscriptYDocs {
  const manuscript = new Y.Doc();
  manuscript.transact(() => {
    const meta = manuscript.getMap(META_FIELD);
    meta.set('title', m.title);
    if (m.author) meta.set('author', m.author);
  });
  writeStructure(
    manuscript,
    m.sections.map(({ id, kind, title, docId, parentId }) => ({
      id,
      kind,
      title,
      docId,
      ...(parentId ? { parentId } : {}),
    })),
  );
  return {
    manuscript,
    sections: new Map(m.sections.map((s) => [s.docId, docToYDoc(s.content)])),
  };
}
