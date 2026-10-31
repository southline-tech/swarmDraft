import { markRaw, onBeforeUnmount, type ShallowRef } from 'vue';
import * as Y from 'yjs';
import { loadNotesState, pollUpdates } from '../backend';
import { createNotesDoc } from './doc';
import { notesSaveStatus, retryNotesSave, watchNotesDoc, type NotesSaveStatus } from './persist';

export { notesSaveStatus, retryNotesSave, type NotesSaveStatus };
import {
  followUpdates,
  LIVE_POLL_MS,
  LOAD_ORIGIN,
  REMOTE_ORIGIN,
  type PollUpdates,
} from '../manuscript-session';

export interface NotesSession {
  doc: Y.Doc;
  close(opts?: { discard?: boolean }): Promise<void>;
}

export async function openNotesSession(
  manuscriptId: string,
  poll: PollUpdates = (after) => pollUpdates(manuscriptId, after),
): Promise<NotesSession> {
  const docRef = markRaw(createNotesDoc());
  const stored = await loadNotesState(manuscriptId);
  if (stored?.state?.length) {
    Y.applyUpdate(docRef, Uint8Array.from(stored.state), LOAD_ORIGIN);
  }
  const persister = watchNotesDoc(manuscriptId, docRef);
  let cursor = stored?.updatesCursor ?? 0;
  const notesDocId = `manuscript/${manuscriptId}/notes`;
  const notesMap = new Map<string, Y.Doc>([[notesDocId, docRef]]);
  let stopPoll: (() => void) | undefined;
  stopPoll = followUpdates(notesMap, cursor, poll, LIVE_POLL_MS, (c) => (cursor = c));
  return {
    doc: docRef,
    close: async (opts) => {
      stopPoll?.();
      stopPoll = undefined;
      await persister.close(opts);
    },
  };
}

/** Apply a remote/agent note write in tests without persisting. */
export function applyRemoteNotesUpdate(doc: Y.Doc, update: Uint8Array) {
  Y.applyUpdate(doc, update, REMOTE_ORIGIN);
}

export function useNotesSessionLifecycle(session: ShallowRef<NotesSession | null>) {
  onBeforeUnmount(() => {
    void session.value?.close();
  });
}
