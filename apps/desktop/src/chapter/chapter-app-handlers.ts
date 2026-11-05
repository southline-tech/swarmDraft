import * as Y from 'yjs';
import { isEmptyChapterDoc } from '@swarmdraft/editor';
import { yDocToDoc } from '@swarmdraft/docx';
import { isMacPlatform } from '../shells/app-shortcuts';
import type { ManuscriptSession } from '../manuscript-session';
import {
  applyChapterMerge,
  applyChapterSplit,
  captureChapterSnapshot,
  docsChangedSince,
  restoreChapterSnapshot,
  type ChapterOpSnapshot,
} from './chapter-ops';

export const CHAPTER_TOAST_MS = 8000;

export type ChapterToastState = {
  message: string;
  detail?: string;
  undo: ChapterOpSnapshot;
  watchDocIds: string[];
  stateVectors: Map<string, Uint8Array>;
};

function captureDocStateVectors(session: ManuscriptSession, docIds: readonly string[]) {
  const out = new Map<string, Uint8Array>();
  for (const docId of docIds) {
    const doc = session.sections.get(docId);
    if (doc) out.set(docId, Y.encodeStateVector(doc));
  }
  return out;
}

export async function runChapterSplit(
  session: ManuscriptSession,
  manuscriptId: string,
  sectionId: string,
  payload: { blockIndex: number; title: string; removeLine: boolean },
  selectedId: string,
  notesDoc?: Y.Doc,
) {
  const undo = captureChapterSnapshot(session, selectedId, notesDoc);
  const result = await applyChapterSplit(
    session,
    manuscriptId,
    sectionId,
    payload.blockIndex,
    payload.title,
    payload.removeLine,
    notesDoc,
  );
  const newDocId = session.outline.value.find((s) => s.id === result.newChapterId)?.docId;
  const watchDocIds = [
    ...new Set([...undo.outline.map((s) => s.docId), newDocId ?? ''].filter(Boolean)),
  ];
  return {
    newChapterId: result.newChapterId,
    splitAcrossThreadIds: result.splitAcrossThreadIds,
    toast: {
      message: `Split into “${payload.title.trim() || 'Untitled'}”`,
      detail: result.notesLinkedBoth ? 'Notes linked to both chapters' : undefined,
      undo,
      watchDocIds,
      stateVectors: captureDocStateVectors(session, watchDocIds),
    } satisfies ChapterToastState,
  };
}

export async function runChapterMerge(
  session: ManuscriptSession,
  targetId: string,
  sourceId: string,
  selectedId: string,
  notesDoc?: Y.Doc,
) {
  const undo = captureChapterSnapshot(session, selectedId, notesDoc);
  await applyChapterMerge(session, targetId, sourceId, notesDoc);
  const target = session.outline.value.find((s) => s.id === targetId);
  const watchDocIds = [target?.docId ?? ''].filter(Boolean);
  return {
    targetId,
    toast: {
      message: `Merged into “${target?.title ?? 'Untitled'}”`,
      undo,
      watchDocIds,
      stateVectors: captureDocStateVectors(session, watchDocIds),
    } satisfies ChapterToastState,
  };
}

export function chapterToastUndoDisabled(session: ManuscriptSession, toast: ChapterToastState) {
  return docsChangedSince(session, toast.watchDocIds, toast.stateVectors);
}

export function chapterToastUndoHint(): string {
  return isMacPlatform() ? 'Text changed — use ⌘Z' : 'Text changed — use Ctrl+Z';
}

export async function undoChapterToast(
  session: ManuscriptSession,
  toast: ChapterToastState,
  notesDoc?: Y.Doc,
) {
  await restoreChapterSnapshot(session, toast.undo, notesDoc);
  return toast.undo.selectedId;
}

export function shouldConfirmMerge(
  session: ManuscriptSession,
  sourceId: string,
  skipSession: boolean,
) {
  if (skipSession) return false;
  const source = session.outline.value.find((s) => s.id === sourceId);
  if (!source) return true;
  const doc = session.sections.get(source.docId);
  if (!doc) return true;
  return !isEmptyChapterDoc(yDocToDoc(doc));
}
