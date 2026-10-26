/**
 * An open manuscript in the UI: the manuscript Y.Doc (meta + `structure`) and its section docs.
 * The sidebar reads the outline from `structure` and saves edits back to it; changes from any
 * other writer (another window, an agent) show up through the structure observer.
 */
import { markRaw, shallowRef, type ShallowRef } from 'vue';
import * as Y from 'yjs';
import type { Section } from '@coauthor/schema';
import { normalizeOutline, type OutlineIssue } from '@coauthor/editor';
import {
  importDocx,
  importedToYDocs,
  META_FIELD,
  observeStructure,
  readStructure,
  writeStructure,
  type ImportReport,
  type ImportedManuscript,
} from '@coauthor/docx';
import {
  openLatestManuscript,
  persistImport,
  saveSectionUpdate,
  type ImportPayload,
  type StoredManuscript,
} from './backend';

export interface ManuscriptSession {
  id: string;
  title: string;
  manuscript: Y.Doc;
  sections: Map<string, Y.Doc>;
  outline: ShallowRef<Section[]>;
  /** The import report; null for a manuscript reopened from the database. */
  report: ImportReport | null;
  /** Problems repaired when the stored outline was opened (already saved back). */
  repairs: OutlineIssue[];
  save(next: Section[]): void;
  /** Write pending section edits to storage now (no-op without storage). */
  flush(): Promise<void>;
  /**
   * Stop observing. Pending edits are flushed first unless `discard` (e.g. after a restore
   * replaced storage, when writing the old docs back would be wrong).
   */
  close(opts?: { discard?: boolean }): Promise<void>;
}

export function openSession(
  id: string,
  title: string,
  manuscript: Y.Doc,
  sections: Map<string, Y.Doc>,
  report: ImportReport | null,
  persist?: SectionPersister,
): ManuscriptSession {
  // Y.Docs must never be wrapped in Vue reactive proxies: Yjs observers compare types by identity,
  // so a proxied doc silently stops delivering remote changes. (ManuscriptEditor also toRaw's.)
  markRaw(manuscript);
  for (const d of sections.values()) markRaw(d);
  // Repair and save back right away, so every id the sidebar shows (e.g. a renamed duplicate)
  // exists in the stored structure and resolves to its doc before the first edit.
  const { sections: repaired, issues: repairs } = normalizeOutline(readStructure(manuscript));
  if (repairs.length) writeStructure(manuscript, repaired);
  const outline = shallowRef(repairs.length ? readStructure(manuscript) : repaired);
  // Normalize on every change too: two peers repairing the same duplicate at once can merge
  // into repeated rows (c, c~2, c, c~2); the sidebar shows each section once.
  const off = observeStructure(
    manuscript,
    (next) => (outline.value = normalizeOutline(next).sections),
  );
  const saver = persist ? watchSections(manuscript, sections, persist) : undefined;
  let closed = false;
  return {
    id,
    title,
    manuscript,
    sections,
    outline,
    report,
    repairs,
    save: (next) => writeStructure(manuscript, next),
    flush: () => saver?.flush() ?? Promise.resolve(),
    close: async (opts) => {
      if (closed) return;
      closed = true;
      off();
      if (!saver) return;
      if (opts?.discard) saver.discard();
      else await saver.flush();
      saver.stop();
    },
  };
}

/** Import a .docx into a new session. */
export function sessionFromDocx(bytes: Uint8Array, manuscriptId: string): ManuscriptSession {
  return sessionFromImported(importDocx(bytes, { manuscriptId }), manuscriptId);
}

/** Open a session over an already-parsed import. */
export function sessionFromImported(
  imported: ImportedManuscript,
  manuscriptId: string,
): ManuscriptSession {
  const docs = importedToYDocs(imported);
  return openSession(manuscriptId, imported.title, docs.manuscript, docs.sections, imported.report);
}

/** What the backend persists for an import: title plus each section's kind, title and content. */
export function importPayload(imported: ImportedManuscript): ImportPayload {
  return {
    title: imported.title,
    sections: imported.sections.map((s) => ({
      id: s.id,
      ...(s.parentId ? { parentId: s.parentId } : {}),
      kind: s.kind,
      title: s.title,
      doc: s.content,
    })),
  };
}

/** Writes one section's Yjs update to storage. */
export type SaveSectionUpdate = (sectionId: string, update: Uint8Array) => Promise<void>;

export interface SectionPersister {
  save: SaveSectionUpdate;
  /** Quiet time before pending edits are written (ms). */
  debounceMs?: number;
  /** Called when a write fails; the edits stay pending and are retried on the next flush. */
  onError?: (err: unknown) => void;
}

/** Origin used when loading stored state, so loading is not echoed back as an edit. */
export const LOAD_ORIGIN = 'coauthor:load';
export const SAVE_DEBOUNCE_MS = 500;

/**
 * Collect every local update to the section docs and write them, merged per section, after
 * `debounceMs` of quiet or on flush. Section docs are keyed by docId; the stored section id is
 * looked up from the outline.
 */
function watchSections(manuscript: Y.Doc, docs: Map<string, Y.Doc>, p: SectionPersister) {
  const pending = new Map<string, Uint8Array[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> = Promise.resolve();
  const sectionIdOf = (docId: string) =>
    readStructure(manuscript).find((s) => s.docId === docId)?.id;
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    inflight = inflight.then(async () => {
      const batch = [...pending];
      pending.clear();
      for (const [docId, updates] of batch) {
        const sectionId = sectionIdOf(docId);
        if (!sectionId) continue;
        const merged = Y.mergeUpdates(updates);
        try {
          await p.save(sectionId, merged);
        } catch (err) {
          // Keep it for the next flush; Yjs updates are idempotent, so a retry is safe.
          pending.set(docId, [merged, ...(pending.get(docId) ?? [])]);
          p.onError?.(err);
        }
      }
    });
    return inflight;
  };
  const offs = [...docs].map(([docId, doc]) => {
    const on = (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD_ORIGIN) return;
      pending.set(docId, [...(pending.get(docId) ?? []), update]);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), p.debounceMs ?? SAVE_DEBOUNCE_MS);
    };
    doc.on('update', on);
    return () => doc.off('update', on);
  });
  return {
    flush,
    discard: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
    stop: () => offs.forEach((f) => f()),
  };
}

/**
 * Open a session over a manuscript as stored in the database: the outline uses the stored
 * section ids and docIds, and each section doc starts from its stored state, so edits are
 * deltas the backend can append.
 */
export function sessionFromStored(
  stored: StoredManuscript,
  report: ImportReport | null,
  persist?: SectionPersister,
): ManuscriptSession {
  const manuscript = new Y.Doc();
  manuscript.getMap(META_FIELD).set('title', stored.manuscript.title);
  writeStructure(
    manuscript,
    stored.sections.map((s) => ({
      id: s.id,
      kind: s.kind as Section['kind'],
      title: s.title,
      docId: s.docId,
      ...(s.parentId ? { parentId: s.parentId } : {}),
    })),
  );
  const sections = new Map<string, Y.Doc>();
  for (const s of stored.sections) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(s.state), LOAD_ORIGIN);
    sections.set(s.docId, doc);
  }
  return openSession(
    stored.manuscript.id,
    stored.manuscript.title,
    manuscript,
    sections,
    report,
    persist,
  );
}

/** A session over a stored manuscript whose section edits are saved to the database. */
export function openStored(
  stored: StoredManuscript,
  report: ImportReport | null,
  onError?: (err: unknown) => void,
): ManuscriptSession {
  const id = stored.manuscript.id;
  return sessionFromStored(stored, report, {
    save: (sectionId, update) => saveSectionUpdate(id, sectionId, update),
    onError,
  });
}

/**
 * Import a .docx and save it (manuscript, sections with their parents, initial text) before
 * opening it, so agents see it over MCP and it survives a restart. The session uses the stored
 * ids and saves edits. Without a database (plain browser) it opens in memory only.
 */
export async function importAndOpen(
  bytes: Uint8Array,
  onError?: (err: unknown) => void,
): Promise<ManuscriptSession> {
  const id = crypto.randomUUID();
  const imported = importDocx(bytes, { manuscriptId: id });
  const saved = await persistImport(importPayload(imported));
  return saved ? openStored(saved, imported.report, onError) : sessionFromImported(imported, id);
}

/** Reopen the most recent stored manuscript (null if none or no database). */
export async function reopenLatest(
  onError?: (err: unknown) => void,
): Promise<ManuscriptSession | null> {
  const latest = await openLatestManuscript();
  return latest ? openStored(latest, null, onError) : null;
}
