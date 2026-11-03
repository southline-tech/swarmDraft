/**
 * Story notes Y.Doc (issue #38): ordered entries with metadata and a collaborative body fragment
 * per note (`body:{id}`), stored at `manuscript/{id}/notes`.
 */
import * as Y from 'yjs';

export const ORDER_KEY = 'order';
export const ENTRIES_KEY = 'entries';

export type NoteAuthorKind = 'human' | 'agent';

export type NoteType = 'character' | 'place' | 'plot' | 'research' | 'other';

export const NOTE_TYPES: readonly NoteType[] = [
  'character',
  'place',
  'plot',
  'research',
  'other',
] as const;

export interface NoteMeta {
  id: string;
  title: string;
  sectionId: string | null;
  sectionIds: string[];
  noteType: NoteType;
  tags: string[];
  authorKind: NoteAuthorKind;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

export function bodyField(noteId: string): string {
  return `body:${noteId}`;
}

export function createNotesDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getArray<string>(ORDER_KEY);
  doc.getMap<Record<string, unknown>>(ENTRIES_KEY);
  return doc;
}

function entryMap(doc: Y.Doc, id: string): Y.Map<unknown> | undefined {
  const raw = doc.getMap(ENTRIES_KEY).get(id);
  return raw instanceof Y.Map ? raw : undefined;
}

function parseNoteType(raw: unknown): NoteType {
  if (typeof raw === 'string' && (NOTE_TYPES as readonly string[]).includes(raw)) {
    return raw as NoteType;
  }
  return 'other';
}

function readStringArray(m: Y.Map<unknown>, key: string): string[] {
  const raw = m.get(key);
  if (raw instanceof Y.Array) {
    return raw.toArray().filter((x): x is string => typeof x === 'string' && x.length > 0);
  }
  return [];
}

function readSectionIds(m: Y.Map<unknown>): string[] {
  const fromArray = readStringArray(m, 'sectionIds');
  if (fromArray.length) return fromArray;
  const sectionRaw = m.get('sectionId');
  if (sectionRaw == null || sectionRaw === '') return [];
  return [String(sectionRaw)];
}

function ensureStringArray(m: Y.Map<unknown>, key: string, values: string[]): Y.Array<string> {
  let arr = m.get(key);
  if (!(arr instanceof Y.Array)) {
    arr = new Y.Array<string>();
    m.set(key, arr);
  }
  const yarr = arr as Y.Array<string>;
  yarr.delete(0, yarr.length);
  if (values.length) yarr.push(values);
  return yarr;
}

export function readNoteMeta(doc: Y.Doc, id: string): NoteMeta | undefined {
  const m = entryMap(doc, id);
  if (!m) return undefined;
  const title = String(m.get('title') ?? '');
  const sectionIds = readSectionIds(m);
  const sectionId = sectionIds[0] ?? null;
  return {
    id,
    title,
    sectionId,
    sectionIds,
    noteType: parseNoteType(m.get('noteType')),
    tags: readStringArray(m, 'tags'),
    authorKind: m.get('authorKind') === 'agent' ? 'agent' : 'human',
    authorId: String(m.get('authorId') ?? ''),
    authorName: String(m.get('authorName') ?? ''),
    createdAt: String(m.get('createdAt') ?? ''),
    updatedAt: String(m.get('updatedAt') ?? ''),
  };
}

export function listNotes(doc: Y.Doc): NoteMeta[] {
  const order = doc.getArray<string>(ORDER_KEY);
  const out: NoteMeta[] = [];
  for (let i = 0; i < order.length; i++) {
    const id = order.get(i);
    if (typeof id !== 'string') continue;
    const meta = readNoteMeta(doc, id);
    if (meta) out.push(meta);
  }
  return out;
}

export function newNoteId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `note-${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export interface NewNoteAuthor {
  kind: NoteAuthorKind;
  id: string;
  name: string;
}

export function addNote(
  doc: Y.Doc,
  author: NewNoteAuthor,
  title = 'Untitled note',
  opts?: { noteType?: NoteType; tags?: string[]; sectionIds?: string[] },
): NoteMeta {
  const id = newNoteId();
  const now = new Date().toISOString();
  const entry = new Y.Map<unknown>();
  entry.set('title', title);
  entry.set('noteType', opts?.noteType ?? 'other');
  entry.set('authorKind', author.kind);
  entry.set('authorId', author.id);
  entry.set('authorName', author.name);
  entry.set('createdAt', now);
  entry.set('updatedAt', now);
  const sectionIds = opts?.sectionIds ?? [];
  ensureStringArray(entry, 'sectionIds', sectionIds);
  entry.set('sectionId', sectionIds[0] ?? null);
  ensureStringArray(entry, 'tags', opts?.tags ?? []);
  doc.getMap(ENTRIES_KEY).set(id, entry);
  doc.getArray<string>(ORDER_KEY).push([id]);
  doc.getXmlFragment(bodyField(id));
  return readNoteMeta(doc, id)!;
}

export function updateNoteTitle(doc: Y.Doc, id: string, title: string): void {
  const m = entryMap(doc, id);
  if (!m) return;
  m.set('title', title);
  m.set('updatedAt', new Date().toISOString());
}

export function updateNoteSectionLink(doc: Y.Doc, id: string, sectionId: string | null): void {
  updateNoteSectionIds(doc, id, sectionId ? [sectionId] : []);
}

export function updateNoteSectionIds(doc: Y.Doc, id: string, sectionIds: string[]): void {
  const m = entryMap(doc, id);
  if (!m) return;
  ensureStringArray(m, 'sectionIds', sectionIds);
  m.set('sectionId', sectionIds[0] ?? null);
  m.set('updatedAt', new Date().toISOString());
}

export function updateNoteType(doc: Y.Doc, id: string, noteType: NoteType): void {
  const m = entryMap(doc, id);
  if (!m) return;
  m.set('noteType', noteType);
  m.set('updatedAt', new Date().toISOString());
}

export function updateNoteTags(doc: Y.Doc, id: string, tags: string[]): void {
  const m = entryMap(doc, id);
  if (!m) return;
  ensureStringArray(m, 'tags', tags);
  m.set('updatedAt', new Date().toISOString());
}

/** Copy collaborative body from one fragment field to another on the same doc. */
export function copyNoteBody(doc: Y.Doc, fromNoteId: string, toNoteId: string): void {
  const src = doc.getXmlFragment(bodyField(fromNoteId));
  const dst = doc.getXmlFragment(bodyField(toNoteId));
  dst.delete(0, dst.length);
  for (let i = 0; i < src.length; i++) {
    const child = src.get(i);
    if (child instanceof Y.AbstractType) dst.insert(i, [child.clone()]);
  }
}

export function deleteNote(doc: Y.Doc, id: string): void {
  const order = doc.getArray<string>(ORDER_KEY);
  const ids = order.toArray();
  const idx = ids.indexOf(id);
  if (idx >= 0) order.delete(idx, 1);
  doc.getMap(ENTRIES_KEY).delete(id);
  const frag = doc.getXmlFragment(bodyField(id));
  frag.delete(0, frag.length);
}

export function observeNotes(doc: Y.Doc, cb: () => void): () => void {
  const order = doc.getArray(ORDER_KEY);
  const entries = doc.getMap(ENTRIES_KEY);
  const onOrder = () => cb();
  const onEntries = (e: Y.YMapEvent<unknown>) => {
    if (e.keysChanged.size) cb();
  };
  order.observe(onOrder);
  entries.observe(onEntries);
  return () => {
    order.unobserve(onOrder);
    entries.unobserve(onEntries);
  };
}
