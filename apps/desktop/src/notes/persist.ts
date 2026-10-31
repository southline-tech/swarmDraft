/**
 * Persist story notes Y.Doc edits through the Rust store (#38).
 * Save status for the notes detail header (#185).
 */
import * as Y from 'yjs';
import { notesApplyUpdate } from '../backend';
import {
  LOAD_ORIGIN,
  REMOTE_ORIGIN,
  RETRY_MAX_MS,
  SAVE_DEBOUNCE_MS,
  SAVE_TIMEOUT_MS,
} from '../manuscript-session';

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

export type NotesSavePhase = 'idle' | 'saving' | 'saved' | 'error';

export type NotesSaveStatus = {
  phase: NotesSavePhase;
  savedAt: number | null;
};

const SAVE = Symbol('coauthorNotesSaveState');
const FLUSH = Symbol('coauthorNotesFlush');

type DocWithSave = Y.Doc & {
  [SAVE]?: NotesSaveStatus;
  [FLUSH]?: () => Promise<void>;
};

const IDLE: NotesSaveStatus = { phase: 'idle', savedAt: null };

const g = globalThis as typeof globalThis & { __coauthorNotesSaveTick?: number };
if (g.__coauthorNotesSaveTick == null) g.__coauthorNotesSaveTick = 0;

function bumpSaveStatus() {
  g.__coauthorNotesSaveTick! += 1;
}

/** Bumped whenever any watched notes doc save status changes (for Vue computed deps). */
export function notesSaveStatusTick(): number {
  return g.__coauthorNotesSaveTick!;
}

export function readNotesSaveStatus(doc: Y.Doc): NotesSaveStatus {
  return (doc as DocWithSave)[SAVE] ?? IDLE;
}

function writeStatus(doc: Y.Doc, next: NotesSaveStatus) {
  (doc as DocWithSave)[SAVE] = next;
  bumpSaveStatus();
}

export function retryNotesSave(doc: Y.Doc) {
  void (doc as DocWithSave)[FLUSH]?.().catch(() => {});
}

export function watchNotesDoc(
  manuscriptId: string,
  doc: Y.Doc,
  hooks?: {
    debounceMs?: number;
    onError?: (err: unknown) => void;
    onSaved?: () => void;
    applyUpdate?: (manuscriptId: string, update: Uint8Array) => Promise<void>;
  },
) {
  let pending: Uint8Array[] = [];
  let dirtyFull = false;
  let failures = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> = Promise.resolve();

  const applyUpdate = hooks?.applyUpdate ?? notesApplyUpdate;

  const markSaving = () => {
    const cur = readNotesSaveStatus(doc);
    if (cur.phase === 'error') return;
    writeStatus(doc, { phase: 'saving', savedAt: cur.savedAt });
  };

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = stopped ? undefined : setTimeout(() => void flush().catch(() => {}), ms);
  };

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const run = inflight.then(async () => {
      const batch = pending;
      pending = [];
      if (!dirtyFull && !batch.length) return;
      if (readNotesSaveStatus(doc).phase !== 'error') markSaving();
      const update = dirtyFull ? Y.encodeStateAsUpdate(doc) : Y.mergeUpdates(batch);
      try {
        await withTimeout(applyUpdate(manuscriptId, update), SAVE_TIMEOUT_MS);
        dirtyFull = false;
        failures = 0;
        writeStatus(doc, { phase: 'saved', savedAt: Date.now() });
        hooks?.onSaved?.();
      } catch (err) {
        dirtyFull = true;
        failures += 1;
        writeStatus(doc, { phase: 'error', savedAt: readNotesSaveStatus(doc).savedAt });
        hooks?.onError?.(err);
        schedule(Math.min(RETRY_MAX_MS, 500 * 2 ** failures));
        throw err;
      }
    });
    inflight = run.catch(() => {});
    return run;
  };

  (doc as DocWithSave)[FLUSH] = flush;

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (stopped || origin === LOAD_ORIGIN || origin === REMOTE_ORIGIN) return;
    pending.push(update);
    markSaving();
    schedule(hooks?.debounceMs ?? SAVE_DEBOUNCE_MS);
  };
  doc.on('update', onUpdate);

  return {
    flush,
    close: async (opts?: { discard?: boolean }) => {
      stopped = true;
      doc.off('update', onUpdate);
      delete (doc as DocWithSave)[FLUSH];
      if (opts?.discard) return;
      await flush();
    },
  };
}
