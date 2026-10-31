/**
 * Persist story notes Y.Doc edits through the Rust store (#38).
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
      const update = dirtyFull ? Y.encodeStateAsUpdate(doc) : Y.mergeUpdates(batch);
      try {
        await withTimeout(notesApplyUpdate(manuscriptId, update), SAVE_TIMEOUT_MS);
        dirtyFull = false;
        failures = 0;
        hooks?.onSaved?.();
      } catch (err) {
        dirtyFull = true;
        failures += 1;
        hooks?.onError?.(err);
        schedule(Math.min(RETRY_MAX_MS, 500 * 2 ** failures));
        throw err;
      }
    });
    inflight = run.catch(() => {});
    return run;
  };

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (stopped || origin === LOAD_ORIGIN || origin === REMOTE_ORIGIN) return;
    pending.push(update);
    schedule(hooks?.debounceMs ?? SAVE_DEBOUNCE_MS);
  };
  doc.on('update', onUpdate);

  return {
    flush,
    close: async (opts?: { discard?: boolean }) => {
      stopped = true;
      doc.off('update', onUpdate);
      if (opts?.discard) return;
      await flush();
    },
  };
}
