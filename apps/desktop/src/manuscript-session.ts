/**
 * An open manuscript in the UI: the manuscript Y.Doc (meta + `structure`) and its section docs.
 * The sidebar reads the outline from `structure` and saves edits back to it; changes from any
 * other writer (another window, an agent) show up through the structure observer.
 */
import { markRaw, shallowRef, type ShallowRef } from 'vue';
import * as Y from 'yjs';
import type { NumberingStyle, Section } from '@coauthor/schema';
import { normalizeOutline, parseNumberingStyle, type OutlineIssue } from '@coauthor/editor';
import {
  importDocx,
  importedToYDocs,
  META_FIELD,
  observeStructure,
  readNumberingStyle,
  readStructure,
  writeNumberingStyle,
  writeStructure,
  type ImportReport,
  type ImportedManuscript,
} from '@coauthor/docx';
import {
  openLatestManuscript,
  persistImport,
  pollUpdates,
  saveOutline,
  saveSectionUpdate,
  setManuscriptNumberingStyle,
  type ImportPayload,
  type StoredManuscript,
  type UpdatesSince,
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
  /**
   * Save an outline edit (add, rename, reorder, move, delete). For a stored manuscript it is
   * written to the database first and rejects (changing nothing) if that fails.
   */
  save(next: Section[]): Promise<void>;
  /**
   * Write pending section edits to storage now (no-op without storage). Rejects with an
   * `UnsavedEditsError` if some edits are still not saved (they are kept and retried).
   */
  flush(): Promise<void>;
  /**
   * Stop observing. Pending edits are flushed first unless `discard` (e.g. after a restore
   * replaced storage, when writing the old docs back would be wrong). If they can't be saved it
   * rejects with `UnsavedEditsError` and the session stays open, still retrying.
   */
  close(opts?: { discard?: boolean }): Promise<void>;
  /** True once `close` has succeeded (edits typed after that are ignored). */
  readonly closed: boolean;
  /**
   * Resume following writes made elsewhere (RAD-264). `close` stops following before it tries
   * to close, so a refused close never leaves a poll running; call this when a refused close
   * keeps the session on screen.
   */
  resumeLive?(): void;
  /** Book-wide numbering display (#111); the index is computed from outline order. */
  numberingStyle: ShallowRef<NumberingStyle>;
  setNumberingStyle(style: NumberingStyle): Promise<void>;
}

export type SaveNumberingStyle = (style: NumberingStyle) => Promise<void>;

export function openSession(
  id: string,
  title: string,
  manuscript: Y.Doc,
  sections: Map<string, Y.Doc>,
  report: ImportReport | null,
  persist?: SectionPersister,
  saveOutline?: SaveOutline,
  saveNumberingStyle?: SaveNumberingStyle,
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
  const closed = shallowRef(false); // reactive, so a closed session's editor turns read-only
  const numberingStyle = shallowRef(parseNumberingStyle(readNumberingStyle(manuscript)));
  return {
    id,
    title,
    manuscript,
    sections,
    outline,
    report,
    repairs,
    numberingStyle,
    setNumberingStyle: async (style) => {
      if (closed.value) return;
      writeNumberingStyle(manuscript, style);
      numberingStyle.value = style;
      await saveNumberingStyle?.(style);
    },
    get closed() {
      return closed.value;
    },
    save: async (next) => {
      if (closed.value) throw new Error('This manuscript is closed.');
      const kept = new Set(next.map((x) => x.docId));
      const removed = readStructure(manuscript)
        .map((x) => x.docId)
        .filter((d) => !kept.has(d));
      // Save pending text first, while every section still exists in storage; if that fails the
      // outline change is refused (nothing is lost, the edits keep retrying).
      if (removed.length) await saver?.flush();
      await saveOutline?.(next);
      // Removed sections are no longer tracked: no queued save or later keystroke can target a
      // section that storage no longer has.
      for (const d of removed) {
        saver?.forget(d);
        sections.delete(d);
      }
      // New sections start with an empty doc (the backend stored one too) and are watched.
      for (const x of next) {
        if (sections.has(x.docId)) continue;
        const doc = markRaw(new Y.Doc());
        sections.set(x.docId, doc);
        saver?.watch(x.docId, doc);
      }
      writeStructure(manuscript, next);
    },
    flush: () => saver?.flush() ?? Promise.resolve(),
    close: async (opts) => {
      if (closed.value) return;
      // If the flush fails, stay open (observers and retries keep running) and rethrow, so the
      // caller can keep this session instead of losing its unsaved edits.
      if (opts?.discard) saver?.discard();
      else await saver?.flush();
      closed.value = true;
      off();
      saver?.stop();
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

/** Writes a whole outline to storage. */
export type SaveOutline = (next: Section[]) => Promise<void>;

/** Writes one section's Yjs update to storage. */
export type SaveSectionUpdate = (sectionId: string, update: Uint8Array) => Promise<void>;

export interface SectionPersister {
  save: SaveSectionUpdate;
  /** Quiet time before pending edits are written (ms). */
  debounceMs?: number;
  /** A save that takes longer than this (ms, default 10 s) counts as failed. */
  saveTimeoutMs?: number;
  /** First retry delay after a failed save (ms); doubles per failure up to 30 s. */
  retryMs?: number;
  /** Called when a save fails; the edits are kept and retried (nothing is ever dropped). */
  onError?: (err: unknown) => void;
  /** Called when a save succeeds and nothing is left unsaved (e.g. to clear an error). */
  onSaved?: () => void;
}

/** Thrown by `flush` when some edits could not be saved; they are kept and retried. */
export class UnsavedEditsError extends Error {
  constructor(
    readonly sectionIds: string[],
    override readonly cause?: unknown,
  ) {
    super(
      `${sectionIds.length} section(s) have edits that aren't saved yet` +
        (cause === undefined ? '' : `: ${cause instanceof Error ? cause.message : String(cause)}`),
    );
    this.name = 'UnsavedEditsError';
  }
}

/** Origin used when loading stored state, so loading is not echoed back as an edit. */
export const LOAD_ORIGIN = 'coauthor:load';
/**
 * Origin used when applying updates someone else already stored (an agent's suggestions over
 * MCP), so they show in the editor without being saved back.
 */
export const REMOTE_ORIGIN = 'coauthor:remote';
export const SAVE_DEBOUNCE_MS = 500;
/** How often an open stored manuscript checks for writes made elsewhere (RAD-264). */
export const LIVE_POLL_MS = 500;
export const RETRY_MAX_MS = 30_000;
export const SAVE_TIMEOUT_MS = 10_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`save timed out after ${ms} ms`)), ms);
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

/**
 * Collect every local update to the section docs and write them, merged per section, after
 * `debounceMs` of quiet or on flush. Section docs are keyed by docId; the stored section id is
 * looked up from the outline.
 *
 * Nothing is ever dropped: after a failed save the section is marked dirty-full, and the next
 * attempt (a backoff retry, the next edit, or a flush) sends the section's full state instead of
 * a delta. Applying a Yjs state the backend already has is a no-op, so this is idempotent and
 * covers whatever was lost, however many attempts failed.
 */
function watchSections(manuscript: Y.Doc, docs: Map<string, Y.Doc>, p: SectionPersister) {
  const pending = new Map<string, Uint8Array[]>();
  const dirtyFull = new Set<string>();
  let lastError: unknown;
  let failures = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> = Promise.resolve();
  const sectionIdOf = (docId: string) =>
    readStructure(manuscript).find((s) => s.docId === docId)?.id;
  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = stopped ? undefined : setTimeout(() => void flush().catch(() => {}), ms);
  };
  const unsaved = () =>
    [...new Set([...dirtyFull, ...pending.keys()])].map((d) => sectionIdOf(d) ?? d);
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const run = inflight.then(async () => {
      const batch = new Map(pending);
      pending.clear();
      let failed = false;
      for (const docId of new Set([...dirtyFull, ...batch.keys()])) {
        const sectionId = sectionIdOf(docId);
        const doc = docs.get(docId);
        if (!sectionId || !doc) {
          dirtyFull.delete(docId);
          continue;
        }
        const full = dirtyFull.has(docId);
        const update = full ? Y.encodeStateAsUpdate(doc) : Y.mergeUpdates(batch.get(docId)!);
        try {
          await withTimeout(p.save(sectionId, update), p.saveTimeoutMs ?? SAVE_TIMEOUT_MS);
          // A full state covers edits made while it was in flight only if they're in `pending`;
          // those stay queued and are sent as their own delta.
          dirtyFull.delete(docId);
        } catch (err) {
          dirtyFull.add(docId);
          lastError = err;
          failed = true;
          p.onError?.(err);
        }
      }
      if (failed) {
        failures++;
        schedule(Math.min((p.retryMs ?? 1000) * 2 ** (failures - 1), RETRY_MAX_MS));
      } else if (!dirtyFull.size) {
        if (failures) p.onSaved?.();
        failures = 0;
        lastError = undefined;
      }
    });
    inflight = run.catch(() => {});
    return run.then(() => {
      if (dirtyFull.size) throw new UnsavedEditsError(unsaved(), lastError);
    });
  };
  const watch = (docId: string, doc: Y.Doc) => {
    const on = (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD_ORIGIN || origin === REMOTE_ORIGIN) return;
      pending.set(docId, [...(pending.get(docId) ?? []), update]);
      schedule(p.debounceMs ?? SAVE_DEBOUNCE_MS);
    };
    doc.on('update', on);
    return () => doc.off('update', on);
  };
  const offs = new Map([...docs].map(([docId, doc]) => [docId, watch(docId, doc)]));
  return {
    flush,
    watch: (docId: string, doc: Y.Doc) => {
      if (!stopped && !offs.has(docId)) offs.set(docId, watch(docId, doc));
    },
    forget: (docId: string) => {
      offs.get(docId)?.();
      offs.delete(docId);
      pending.delete(docId);
      dirtyFull.delete(docId);
    },
    discard: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
      dirtyFull.clear();
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      offs.forEach((f) => f());
      offs.clear();
    },
  };
}

/** Fetches the updates written after a cursor; null means there is nothing to follow. */
export type PollUpdates = (after: number) => Promise<UpdatesSince | null>;

/**
 * Follow writes made elsewhere to stored section docs (RAD-264): every `intervalMs`, apply
 * the updates stored after `cursor` to the open docs with `REMOTE_ORIGIN`. y-prosemirror shows
 * them in a bound editor right away, and the CRDT merge keeps whatever the author is typing.
 * Updates already in a doc (e.g. the author's own saved edits) are no-ops. Polls never overlap;
 * a failed poll is retried on the next tick. Returns `stop`.
 */
export function followUpdates(
  docs: Map<string, Y.Doc>,
  cursor: number,
  poll: PollUpdates,
  intervalMs = LIVE_POLL_MS,
  onCursor?: (cursor: number) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      // Drain: a full page means more may be waiting.
      for (;;) {
        const r = await poll(cursor);
        if (stopped || !r) return;
        for (const u of r.updates) {
          const doc = docs.get(u.docId);
          if (doc) Y.applyUpdate(doc, Uint8Array.from(u.update), REMOTE_ORIGIN);
        }
        const advanced = r.cursor > cursor;
        cursor = Math.max(cursor, r.cursor);
        onCursor?.(cursor);
        if (!advanced || !r.updates.length) break;
      }
    } catch {
      // Keep the cursor: the same updates are fetched again next time.
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
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
  saveOutline?: SaveOutline,
  live?: PollUpdates,
  saveNumberingStyle?: SaveNumberingStyle,
): ManuscriptSession {
  const manuscript = new Y.Doc();
  manuscript.getMap(META_FIELD).set('title', stored.manuscript.title);
  writeNumberingStyle(manuscript, parseNumberingStyle(stored.manuscript.numberingStyle));
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
  const session = openSession(
    stored.manuscript.id,
    stored.manuscript.title,
    manuscript,
    sections,
    report,
    persist,
    saveOutline,
    saveNumberingStyle,
  );
  if (!live || stored.updatesCursor === undefined) return session;
  // Follow writes made elsewhere until the session closes. `sections` is the session's own map,
  // so docs added to it later are followed too.
  let cursor = stored.updatesCursor;
  let stop: (() => void) | undefined;
  const follow = () => {
    stop ??= followUpdates(sections, cursor, live, LIVE_POLL_MS, (c) => (cursor = c));
  };
  follow();
  const close = session.close;
  // Stop first: a refused close (unsaved edits on switch or import) must not leave it polling.
  session.close = (opts) => {
    stop?.();
    stop = undefined;
    return close(opts);
  };
  session.resumeLive = () => {
    if (!session.closed) follow();
  };
  return session;
}

/** A session over a stored manuscript whose section edits are saved to the database. */
export function openStored(
  stored: StoredManuscript,
  report: ImportReport | null,
  persistHooks?: Pick<SectionPersister, 'onError' | 'onSaved'>,
): ManuscriptSession {
  const id = stored.manuscript.id;
  return sessionFromStored(
    stored,
    report,
    {
      save: (sectionId, update) => saveSectionUpdate(id, sectionId, update),
      ...persistHooks,
    },
    (next) => saveOutline(id, next),
    (after) => pollUpdates(id, after),
    (style) => setManuscriptNumberingStyle(id, style).then(() => undefined),
  );
}

/**
 * Import a .docx in place of `current`: parse it, close `current` (its edits must be saved, or
 * this rejects with `UnsavedEditsError` and `current` stays open, still retrying), and only then
 * save the import, so a failed switch never leaves an orphan import that would reopen as the
 * newest manuscript. The write is atomic and is never undone: if opening fails after it, the
 * caller reopens the newest manuscript, which is the import. The new session uses the stored ids and saves edits; without a database it is in memory only.
 */
export async function importAndOpen(
  bytes: Uint8Array,
  persistHooks?: Pick<SectionPersister, 'onError' | 'onSaved'>,
  current?: ManuscriptSession | null,
): Promise<ManuscriptSession> {
  const id = crypto.randomUUID();
  const imported = importDocx(bytes, { manuscriptId: id });
  const payload = importPayload(imported);
  await current?.close();
  const saved = await persistImport(payload);
  return saved
    ? openStored(saved, imported.report, persistHooks)
    : sessionFromImported(imported, id);
}

/** Reopen the most recent stored manuscript (null if none or no database). */
export async function reopenLatest(
  persistHooks?: Pick<SectionPersister, 'onError' | 'onSaved'>,
): Promise<ManuscriptSession | null> {
  const latest = await openLatestManuscript();
  return latest ? openStored(latest, null, persistHooks) : null;
}
