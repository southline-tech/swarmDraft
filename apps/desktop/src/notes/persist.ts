/**
 * Persist story notes Y.Doc edits through the Rust store (#38).
 * Save status for the notes detail header (#185).
 */
import { ref, type Ref } from 'vue';
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

const FLUSH = Symbol('coauthorNotesFlush');

type DocWithSave = Y.Doc & {
  [FLUSH]?: () => Promise<void>;
};

const IDLE: NotesSaveStatus = { phase: 'idle', savedAt: null };

type GlobalNotesSave = { refs: WeakMap<Y.Doc, Ref<NotesSaveStatus>> };
const g = globalThis as typeof globalThis & { __coauthorNotesSave?: GlobalNotesSave };
if (!g.__coauthorNotesSave) g.__coauthorNotesSave = { refs: new WeakMap() };

function statusRef(doc: Y.Doc): Ref<NotesSaveStatus> {
  let r = g.__coauthorNotesSave!.refs.get(doc);
  if (!r) {
    r = ref({ ...IDLE });
    g.__coauthorNotesSave!.refs.set(doc, r);
  }
  return r;
}

export function notesSaveStatus(doc: Y.Doc): Ref<NotesSaveStatus> {
  return statusRef(doc);
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
  },
) {
  let pending: Uint8Array[] = [];
  let dirtyFull = false;
  let failures = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> = Promise.resolve();

  const status = statusRef(doc);

  const markSaving = () => {
    if (status.value.phase === 'error') return;
    status.value = { phase: 'saving', savedAt: status.value.savedAt };
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
      if (status.value.phase !== 'error') markSaving();
      const update = dirtyFull ? Y.encodeStateAsUpdate(doc) : Y.mergeUpdates(batch);
      try {
        await withTimeout(notesApplyUpdate(manuscriptId, update), SAVE_TIMEOUT_MS);
        dirtyFull = false;
        failures = 0;
        status.value = { phase: 'saved', savedAt: Date.now() };
        hooks?.onSaved?.();
      } catch (err) {
        dirtyFull = true;
        failures += 1;
        status.value = { phase: 'error', savedAt: status.value.savedAt };
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
