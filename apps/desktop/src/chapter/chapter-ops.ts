import { markRaw } from 'vue';
import * as Y from 'yjs';
import type { DocNode, Section } from '@swarmdraft/schema';
import {
  noteSectionIdsAfterMerge,
  noteSectionIdsAfterSplit,
  planChapterMerge,
  planSplitChapterOutline,
  splitChapterDocs,
  CHAPTER_OP_ORIGIN,
} from '@swarmdraft/editor';
import { docToYDoc, FRAGMENT_NAME, yDocToDoc } from '@swarmdraft/docx';
import type { ManuscriptSession } from '../manuscript-session';
import { listNotes, updateNoteSectionIds } from '../notes/doc';

export interface ChapterOpSnapshot {
  outline: Section[];
  docs: Map<string, Uint8Array>;
  notes?: Uint8Array;
  selectedId: string;
}

export function captureChapterSnapshot(
  session: ManuscriptSession,
  selectedId: string,
  notesDoc?: Y.Doc,
): ChapterOpSnapshot {
  const docs = new Map<string, Uint8Array>();
  for (const s of session.outline.value) {
    const d = session.sections.get(s.docId);
    if (d) docs.set(s.docId, Y.encodeStateAsUpdate(d));
  }
  return {
    outline: session.outline.value.map((x) => ({ ...x })),
    docs,
    notes: notesDoc ? Y.encodeStateAsUpdate(notesDoc) : undefined,
    selectedId,
  };
}

function replaceDocContent(ydoc: Y.Doc, node: DocNode) {
  ydoc.transact(() => {
    const frag = ydoc.getXmlFragment(FRAGMENT_NAME);
    if (frag.length) frag.delete(0, frag.length);
    docToYDoc(node, ydoc);
  }, CHAPTER_OP_ORIGIN);
}

export async function restoreChapterSnapshot(
  session: ManuscriptSession,
  snap: ChapterOpSnapshot,
  notesDoc?: Y.Doc,
) {
  await session.save(snap.outline.map((x) => ({ ...x })));
  for (const s of snap.outline) {
    const upd = snap.docs.get(s.docId);
    if (!upd) continue;
    let doc = session.sections.get(s.docId);
    if (!doc) {
      doc = markRaw(new Y.Doc());
      session.sections.set(s.docId, doc);
    }
    const fromSnap = markRaw(new Y.Doc());
    Y.applyUpdate(fromSnap, upd);
    replaceDocContent(doc, yDocToDoc(fromSnap));
  }
  if (snap.notes && notesDoc) {
    const empty = new Y.Doc();
    Y.applyUpdate(notesDoc, Y.encodeStateAsUpdate(empty), CHAPTER_OP_ORIGIN);
    Y.applyUpdate(notesDoc, snap.notes, CHAPTER_OP_ORIGIN);
  }
}

export async function applyChapterSplit(
  session: ManuscriptSession,
  manuscriptId: string,
  chapterId: string,
  blockIndex: number,
  title: string,
  removeTitleLine: boolean,
  notesDoc?: Y.Doc,
) {
  const chapter = session.outline.value.find((s) => s.id === chapterId);
  if (!chapter) throw new Error('Unknown chapter');
  const ydoc = session.sections.get(chapter.docId);
  if (!ydoc) throw new Error('Missing chapter doc');
  const split = splitChapterDocs(yDocToDoc(ydoc), blockIndex, { removeTitleLine });
  const plan = planSplitChapterOutline(session.outline.value, manuscriptId, chapterId, title);
  replaceDocContent(ydoc, split.before);
  session.sections.set(plan.newDocId, markRaw(docToYDoc(split.after)));
  let notesLinkedBoth = false;
  if (notesDoc) {
    for (const n of listNotes(notesDoc)) {
      const next = noteSectionIdsAfterSplit(n.sectionIds, chapterId, plan.newChapterId);
      if (next.length !== n.sectionIds.length) {
        updateNoteSectionIds(notesDoc, n.id, next);
        notesLinkedBoth = true;
      }
    }
  }
  await session.save(plan.sections);
  return {
    newChapterId: plan.newChapterId,
    splitAcrossThreadIds: split.splitAcrossThreadIds,
    notesLinkedBoth,
  };
}

export async function applyChapterMerge(
  session: ManuscriptSession,
  targetId: string,
  sourceId: string,
  notesDoc?: Y.Doc,
) {
  const target = session.outline.value.find((s) => s.id === targetId);
  const source = session.outline.value.find((s) => s.id === sourceId);
  if (!target || !source) throw new Error('Unknown chapter');
  const targetDoc = session.sections.get(target.docId);
  const sourceDoc = session.sections.get(source.docId);
  if (!targetDoc || !sourceDoc) throw new Error('Missing doc');
  const plan = planChapterMerge(
    session.outline.value,
    targetId,
    sourceId,
    yDocToDoc(targetDoc),
    yDocToDoc(sourceDoc),
    source.title,
  );
  replaceDocContent(targetDoc, plan.mergedDoc);
  session.sections.delete(source.docId);
  if (notesDoc) {
    for (const n of listNotes(notesDoc)) {
      const next = noteSectionIdsAfterMerge(n.sectionIds, targetId, sourceId);
      if (JSON.stringify(next) !== JSON.stringify(n.sectionIds)) {
        updateNoteSectionIds(notesDoc, n.id, next);
      }
    }
  }
  await session.save(plan.sections);
  return { targetId, removedId: plan.removedChapterId };
}

export function docsChangedSince(
  session: ManuscriptSession,
  docIds: readonly string[],
  stateVectors: Map<string, Uint8Array>,
): boolean {
  for (const docId of docIds) {
    const doc = session.sections.get(docId);
    const sv = stateVectors.get(docId);
    if (!doc || !sv) continue;
    const now = Y.encodeStateVector(doc);
    if (now.length !== sv.length || now.some((b, i) => b !== sv[i])) return true;
  }
  return false;
}
