/**
 * Merge prose that still lives in legacy scene sections into parent chapter docs (#131).
 * Runs on stored outlines before normalizeOutline turns scene rows into sibling chapters.
 */
import type { BlockNode, DocNode, InlineNode, Section } from '@coauthor/schema';

const SCENE_BREAK = '* * *';
const CHAPTER_MARKER = /^(?:chapter|CHAPTER)\b/i;

const WORD =
  /(?:\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{M}\p{N}])[\p{L}\p{M}\p{N}]*(?:['\u2019-][\p{L}\p{M}\p{N}]+)*/gu;

function plainInline(nodes: InlineNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => (n.type === 'text' ? n.text : n.type === 'hard_break' ? '\n' : ''))
    .join('');
}

function blockPlain(b: BlockNode): string {
  if (b.type === 'scene_break') return b.attrs.marker || SCENE_BREAK;
  if (b.type === 'page_break') return '';
  return plainInline(b.content);
}

export function docWordCount(doc: DocNode): number {
  const text = doc.content.map(blockPlain).join(' ');
  return text.match(WORD)?.length ?? 0;
}

function isTitleOnlyChapter(doc: DocNode | undefined): boolean {
  if (!doc) return false;
  const blocks = doc.content.filter((b) => b.type !== 'page_break');
  if (!blocks.length) return true;
  if (blocks.length === 1 && blocks[0]!.type === 'heading') return true;
  return blocks.every(
    (b) => b.type === 'heading' || (b.type === 'paragraph' && !plainInline(b.content).trim()),
  );
}

function startsNewChapterGroup(sec: Section, doc: DocNode | undefined): boolean {
  if (!isTitleOnlyChapter(doc)) return false;
  const h = doc?.content.find((b) => b.type === 'heading' && b.attrs.level === 1);
  const heading = h && h.type === 'heading' ? plainInline(h.content) : '';
  return CHAPTER_MARKER.test(sec.title) || CHAPTER_MARKER.test(heading);
}

function bodyBlocks(doc: DocNode): BlockNode[] {
  return doc.content.filter((b) => !(b.type === 'heading' && b.attrs.level === 1));
}

function chapterHasBody(doc: DocNode): boolean {
  return bodyBlocks(doc).some(
    (b) => b.type !== 'page_break' && (b.type !== 'paragraph' || plainInline(b.content).trim()),
  );
}

function appendMergedBlocks(target: DocNode, source: DocNode): void {
  const blocks = bodyBlocks(source);
  if (!blocks.length) return;
  if (chapterHasBody(target)) {
    target.content.push({ type: 'scene_break', attrs: { marker: SCENE_BREAK } });
  }
  target.content.push(...blocks);
}

function mergeIntoChapter(
  chapter: Section,
  absorb: Section[],
  docs: Map<string, DocNode>,
  updatedDocIds: Set<string>,
): boolean {
  if (!absorb.length) return false;
  const base = docs.get(chapter.docId);
  if (!base) return false;
  const merged: DocNode = { type: 'doc', content: [...base.content] };
  for (const s of absorb) {
    const src = docs.get(s.docId);
    if (src) appendMergedBlocks(merged, src);
    docs.delete(s.docId);
  }
  docs.set(chapter.docId, merged);
  updatedDocIds.add(chapter.docId);
  return true;
}

function isLegacyScene(sec: Section, byId: Map<string, Section>): boolean {
  if ((sec.kind as string) !== 'scene') return false;
  const parent = sec.parentId ? byId.get(sec.parentId) : undefined;
  return parent?.kind === 'chapter';
}

export interface LegacySceneMergeResult {
  sections: Section[];
  docs: Map<string, DocNode>;
  removedDocIds: string[];
  /** Chapter docs whose content was rewritten by the merge. */
  updatedDocIds: string[];
  changed: boolean;
}

/**
 * Coalesce legacy scene section docs into their parent chapter (nested scenes), then merge
 * post-#106 sibling chapter rows that split a chapter title from its former scene bodies.
 */
export function coalesceLegacySceneSections(
  sections: readonly Section[],
  docs: Map<string, DocNode>,
): LegacySceneMergeResult {
  let list = sections.map((s) => ({ ...s }));
  const docMap = new Map(docs);
  const removed = new Set<string>();
  const updatedDocIds = new Set<string>();
  let changed = false;

  const drop = (ids: string[]) => {
    const dropSet = new Set(ids);
    for (const s of list) {
      if (!dropSet.has(s.id)) continue;
      removed.add(s.docId);
      docMap.delete(s.docId);
    }
    list = list.filter((s) => !dropSet.has(s.id));
    changed = true;
  };

  // Nested legacy rows: scene -> chapter parent.
  const byId = () => new Map(list.map((s) => [s.id, s]));
  for (const sec of [...list]) {
    if (!isLegacyScene(sec, byId())) continue;
    const parent = sec.parentId ? byId().get(sec.parentId) : undefined;
    if (parent?.kind !== 'chapter') continue;
    if (mergeIntoChapter(parent, [sec], docMap, updatedDocIds)) drop([sec.id]);
  }

  // Sibling split under each part: title-only chapter followed by scene bodies as chapters.
  for (const part of list.filter((s) => s.kind === 'part')) {
    const kids = list.filter((s) => s.parentId === part.id);
    let i = 0;
    while (i < kids.length) {
      const head = kids[i]!;
      const headDoc = docMap.get(head.docId);
      if (!startsNewChapterGroup(head, headDoc)) {
        i++;
        continue;
      }
      const absorb: Section[] = [];
      let j = i + 1;
      while (j < kids.length) {
        const next = kids[j]!;
        const nextDoc = docMap.get(next.docId);
        if (startsNewChapterGroup(next, nextDoc)) break;
        absorb.push(next);
        j++;
      }
      if (absorb.length && mergeIntoChapter(head, absorb, docMap, updatedDocIds))
        drop(absorb.map((s) => s.id));
      i = j;
    }
  }

  // Top-level chapters (no part): same sibling merge pass.
  const roots = list.filter((s) => !s.parentId && s.kind === 'chapter');
  let i = 0;
  while (i < roots.length) {
    const head = roots[i]!;
    const headDoc = docMap.get(head.docId);
    if (!startsNewChapterGroup(head, headDoc)) {
      i++;
      continue;
    }
    const absorb: Section[] = [];
    let j = i + 1;
    while (j < roots.length) {
      const next = roots[j]!;
      const nextDoc = docMap.get(next.docId);
      if (startsNewChapterGroup(next, nextDoc)) break;
      absorb.push(next);
      j++;
    }
    if (absorb.length && mergeIntoChapter(head, absorb, docMap, updatedDocIds))
      drop(absorb.map((s) => s.id));
    i = j;
  }

  return {
    sections: list,
    docs: docMap,
    removedDocIds: [...removed],
    updatedDocIds: [...updatedDocIds],
    changed,
  };
}
