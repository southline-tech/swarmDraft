/**
 * Story notes Y.Doc (issue #38): ordered entries with metadata and a collaborative body fragment
 * per note (`body:{id}`), stored at `manuscript/{id}/notes`.
 */
import * as Y from 'yjs';

export const ORDER_KEY = 'order';
export const ENTRIES_KEY = 'entries';

export type NoteAuthorKind = 'human' | 'agent';

export interface NoteMeta {
  id: string;
  title: string;
  sectionId: string | null;
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

export function readNoteMeta(doc: Y.Doc, id: string): NoteMeta | undefined {
  const m = entryMap(doc, id);
  if (!m) return undefined;
  const title = String(m.get('title') ?? '');
  const sectionRaw = m.get('sectionId');
  const sectionId = sectionRaw == null || sectionRaw === '' ? null : String(sectionRaw);
  return {
    id,
    title,
    sectionId,
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

export function addNote(doc: Y.Doc, author: NewNoteAuthor, title = 'Untitled note'): NoteMeta {
  const id = newNoteId();
  const now = new Date().toISOString();
  const entry = new Y.Map<unknown>();
  entry.set('title', title);
  entry.set('sectionId', null);
  entry.set('authorKind', author.kind);
  entry.set('authorId', author.id);
  entry.set('authorName', author.name);
  entry.set('createdAt', now);
  entry.set('updatedAt', now);
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
  const m = entryMap(doc, id);
  if (!m) return;
  m.set('sectionId', sectionId);
  m.set('updatedAt', new Date().toISOString());
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
