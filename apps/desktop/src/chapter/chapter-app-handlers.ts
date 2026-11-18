import * as Y from 'yjs';
import type { DocNode } from '@swarmdraft/schema';
import {
  firstLineText,
  isEmptyChapterDoc,
  reviewBlocksSplit,
  scanChapterBreaks,
  skippedBreaksMessage,
} from '@swarmdraft/editor';
import { yDocToDoc } from '@swarmdraft/docx';
import { isMacPlatform } from '../shells/app-shortcuts';
import type { ManuscriptSession } from '../manuscript-session';
import { listNotes } from '../notes/doc';
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
  return isMacPlatform()
    ? 'Text changed since this, use ⌘Z'
    : 'Text changed since this, use Ctrl+Z';
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

export interface FindBreakRow {
  key: string;
  chapterId: string;
  blockIndex: number;
  sourceTitle: string;
  title: string;
  snippet: string;
  selected: boolean;
  removeLine: boolean;
}

export interface BreakLocation {
  chapterId: string;
  blockIndex: number;
  sourceTitle: string;
}

export interface ChapterBreakBatchResult {
  appliedKeys: string[];
  skippedKeys: string[];
  createdIds: string[];
  firstNewChapterId: string | null;
  locations: Map<string, BreakLocation>;
  splitAcrossThreadIds: string[];
  toast: ChapterToastState | null;
}

export function chapterBreakToastMessage(titles: readonly string[]): string {
  if (titles.length === 1) return `Split into “${titles[0]?.trim() || 'Untitled'}”`;
  return `Split into ${titles.length} chapters`;
}

/** How many chapters from this batch a note now covers (source plus each new chapter). */
export function notesLinkSpan(
  notes: readonly { sectionIds: readonly string[] }[],
  sourceIds: ReadonlySet<string>,
  createdIds: ReadonlySet<string>,
): number {
  let max = 0;
  for (const note of notes) {
    if (!note.sectionIds.some((id) => createdIds.has(id))) continue;
    const span = note.sectionIds.filter((id) => sourceIds.has(id) || createdIds.has(id)).length;
    if (span > max) max = span;
  }
  return max;
}

export function notesLinkedDetail(chapterCount: number): string | undefined {
  if (chapterCount < 2) return undefined;
  if (chapterCount === 2) return 'Notes linked to both chapters';
  return 'Notes linked to all of these chapters';
}

export function scanSessionBreaks(session: ManuscriptSession): FindBreakRow[] {
  const chapters = session.outline.value.filter((s) => s.kind === 'chapter');
  const input = chapters.flatMap((sec, chapterIndex) => {
    const ydoc = session.sections.get(sec.docId);
    if (!ydoc) return [];
    return [
      {
        id: sec.id,
        title: sec.title.trim() || 'Untitled',
        chapterIndex,
        doc: yDocToDoc(ydoc),
      },
    ];
  });
  return scanChapterBreaks(input).map((row) => ({
    key: row.key,
    chapterId: row.chapterId,
    blockIndex: row.blockIndex,
    sourceTitle: row.sourceTitle,
    title: row.title,
    snippet: row.snippet,
    selected: true,
    removeLine: row.removeLine,
  }));
}

function splitPointBlocked(doc: DocNode, blockIndex: number): boolean {
  const blocks = doc.content ?? [];
  if (blockIndex <= 0 || blockIndex >= blocks.length) return true;
  const tail = blocks.slice(blockIndex);
  if (tail.every((block) => block.type !== 'scene_break' && !firstLineText(block))) return true;
  return reviewBlocksSplit(doc, blockIndex);
}

/**
 * Apply selected heading breaks with the #304 split, last break first so earlier
 * indexes stay valid. One snapshot covers the whole batch.
 */
export async function runChapterBreakBatch(
  session: ManuscriptSession,
  manuscriptId: string,
  rows: readonly FindBreakRow[],
  selectedId: string,
  notesDoc?: Y.Doc,
): Promise<ChapterBreakBatchResult> {
  const locations = new Map<string, BreakLocation>(
    rows.map((row) => [
      row.key,
      { chapterId: row.chapterId, blockIndex: row.blockIndex, sourceTitle: row.sourceTitle },
    ]),
  );
  const chapterPos = (id: string) => session.outline.value.findIndex((s) => s.id === id);
  const selected = rows
    .filter((row) => row.selected)
    .sort((a, b) => {
      const aLoc = locations.get(a.key)!;
      const bLoc = locations.get(b.key)!;
      const pos = chapterPos(bLoc.chapterId) - chapterPos(aLoc.chapterId);
      if (pos !== 0) return pos;
      return bLoc.blockIndex - aLoc.blockIndex;
    });

  let undo: ChapterOpSnapshot | null = null;
  const applied: { key: string; id: string; title: string }[] = [];
  const skipped: string[] = [];
  const splitSources = new Set<string>();
  const splitAcrossThreadIds: string[] = [];

  const shiftAfter = (
    sourceChapterId: string,
    splitAt: number,
    removeLine: boolean,
    newChapterId: string,
    sourceTitle: string,
  ) => {
    for (const [key, loc] of locations) {
      if (loc.chapterId !== sourceChapterId || loc.blockIndex <= splitAt) continue;
      locations.set(key, {
        chapterId: newChapterId,
        blockIndex: loc.blockIndex - splitAt - (removeLine ? 1 : 0),
        sourceTitle,
      });
    }
  };

  try {
    for (const row of selected) {
      const loc = locations.get(row.key);
      const chapter = loc ? session.outline.value.find((s) => s.id === loc.chapterId) : undefined;
      const ydoc = chapter ? session.sections.get(chapter.docId) : undefined;
      if (!loc || !chapter || !ydoc || splitPointBlocked(yDocToDoc(ydoc), loc.blockIndex)) {
        skipped.push(row.key);
        continue;
      }
      if (!undo) undo = captureChapterSnapshot(session, selectedId, notesDoc);
      const result = await applyChapterSplit(
        session,
        manuscriptId,
        loc.chapterId,
        loc.blockIndex,
        row.title,
        row.removeLine,
        notesDoc,
      );
      splitAcrossThreadIds.push(...result.splitAcrossThreadIds);
      const created = session.outline.value.find((s) => s.id === result.newChapterId);
      const sourceTitle = created?.title || row.title;
      splitSources.add(loc.chapterId);
      applied.push({ key: row.key, id: result.newChapterId, title: row.title });
      shiftAfter(loc.chapterId, loc.blockIndex, row.removeLine, result.newChapterId, sourceTitle);
    }
  } catch (err) {
    if (undo) await restoreChapterSnapshot(session, undo, notesDoc);
    throw err;
  }

  const skippedKeys = [...skipped].sort((a, b) => {
    const aLoc = locations.get(a)!;
    const bLoc = locations.get(b)!;
    const pos = chapterPos(aLoc.chapterId) - chapterPos(bLoc.chapterId);
    if (pos !== 0) return pos;
    return aLoc.blockIndex - bLoc.blockIndex;
  });

  if (!undo || applied.length === 0) {
    return {
      appliedKeys: [],
      skippedKeys,
      createdIds: [],
      firstNewChapterId: null,
      locations,
      splitAcrossThreadIds,
      toast: null,
    };
  }

  const createdSet = new Set(applied.map((row) => row.id));
  const createdInOrder = session.outline.value.filter((s) => createdSet.has(s.id));
  const titlesInOrder = createdInOrder.map(
    (s) => applied.find((row) => row.id === s.id)?.title || s.title,
  );
  const watchDocIds = [
    ...new Set([...undo.outline.map((s) => s.docId), ...session.outline.value.map((s) => s.docId)]),
  ];
  const noteSpan = notesDoc
    ? notesLinkSpan(listNotes(notesDoc), splitSources, new Set(applied.map((row) => row.id)))
    : 0;
  return {
    appliedKeys: applied.map((row) => row.key),
    skippedKeys,
    createdIds: createdInOrder.map((s) => s.id),
    firstNewChapterId: createdInOrder[0]?.id ?? null,
    locations,
    splitAcrossThreadIds,
    toast: {
      message: chapterBreakToastMessage(titlesInOrder),
      detail: notesLinkedDetail(noteSpan),
      undo,
      watchDocIds,
      stateVectors: captureDocStateVectors(session, watchDocIds),
    },
  };
}

export { skippedBreaksMessage };
