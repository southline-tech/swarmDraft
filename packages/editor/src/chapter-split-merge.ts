/**
 * Split and merge chapter sections (#304): pure outline + ProseMirror JSON helpers.
 */
import type { BlockNode, DocNode, InlineNode, Section } from '@swarmdraft/schema';
import { sectionDocId } from '@swarmdraft/schema';
import { cleanTitle, deleteSection } from './outline';
import { listCommentAnchors } from './comments';
import { SUGGESTION_MARKS } from './content';

export const CHAPTER_OP_ORIGIN = 'swarmdraft:chapter-op';

const HEADING_LINE =
  /^(?:chapter\s+[\divxlcdm]+|[\divxlcdm]+|part\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+|[\divxlcdm]+))\s*$/i;

export function stripHeadingMarkup(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function firstLineText(block: BlockNode | undefined): string {
  if (!block || !('content' in block)) return '';
  let out = '';
  const walk = (nodes: InlineNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.type === 'text') out += n.text;
      else if (n.type === 'hard_break') out += ' ';
      else if (n.type === 'footnote') for (const p of n.attrs.content) walk(p.content);
    }
  };
  walk(block.content);
  return stripHeadingMarkup(out);
}

export function looksLikeChapterHeading(line: string): boolean {
  const t = stripHeadingMarkup(line);
  if (!t || t.length > 60) return false;
  return HEADING_LINE.test(t) || /^(chapter|part)\b/i.test(t);
}

export function defaultRemoveTitleLine(line: string): boolean {
  return looksLikeChapterHeading(line);
}

export function suggestSplitTitle(
  line: string,
  chapterNumber: number,
  maxLen = 80,
): { title: string; removeLineDefault: boolean } {
  const stripped = stripHeadingMarkup(line).slice(0, maxLen);
  const title = stripped || `Chapter ${chapterNumber}`;
  return { title, removeLineDefault: defaultRemoveTitleLine(line) };
}

function blockHasText(block: BlockNode): boolean {
  if (block.type === 'scene_break') return true;
  if (!('content' in block)) return false;
  let t = '';
  const walk = (nodes: InlineNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.type === 'text') t += n.text;
      else if (n.type === 'footnote') for (const p of n.attrs.content) walk(p.content);
    }
  };
  walk(block.content);
  return t.trim().length > 0;
}

export function isEmptyChapterDoc(doc: DocNode): boolean {
  const blocks = doc.content ?? [];
  if (!blocks.length) return true;
  return !blocks.some(blockHasText);
}

function blockHasReviewMark(block: BlockNode): boolean {
  if (!('content' in block)) return false;
  let hit = false;
  const walk = (nodes: InlineNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.type === 'text') {
        for (const m of n.marks ?? []) {
          if ((SUGGESTION_MARKS as readonly string[]).includes(m.type)) hit = true;
        }
      } else if (n.type === 'footnote') for (const p of n.attrs.content) walk(p.content);
    }
  };
  walk(block.content);
  return hit;
}

export function reviewBlocksSplit(doc: DocNode, blockIndex: number): boolean {
  const blocks = doc.content ?? [];
  const at = blocks[blockIndex];
  const prev = blocks[blockIndex - 1];
  return Boolean((at && blockHasReviewMark(at)) || (prev && blockHasReviewMark(prev)));
}

function anchorBlockRange(doc: DocNode, anchorId: string): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  const blocks = doc.content ?? [];
  blocks.forEach((block, bi) => {
    if (!('content' in block)) return;
    const walk = (nodes: InlineNode[] | undefined) => {
      for (const n of nodes ?? []) {
        if (n.type === 'text') {
          for (const m of n.marks ?? []) {
            if (m.type === 'comment_anchor' && m.attrs.id === anchorId) {
              if (first < 0) first = bi;
              last = bi;
            }
          }
        } else if (n.type === 'footnote') for (const p of n.attrs.content) walk(p.content);
      }
    };
    walk(block.content);
  });
  return first < 0 ? null : { first, last };
}

function stripAnchorFromBlocks(blocks: BlockNode[]): BlockNode[] {
  return JSON.parse(JSON.stringify(blocks)) as BlockNode[];
}

function truncateAnchorAtBlockEnd(block: BlockNode): BlockNode {
  return block;
}

export function splitChapterDocs(
  doc: DocNode,
  blockIndex: number,
  opts: { removeTitleLine: boolean },
): { before: DocNode; after: DocNode; splitAcrossThreadIds: string[] } {
  const blocks = [...(doc.content ?? [])];
  if (blockIndex <= 0 || blockIndex >= blocks.length) {
    return { before: doc, after: { type: 'doc', content: [] }, splitAcrossThreadIds: [] };
  }
  let tail = blocks.slice(blockIndex);
  if (opts.removeTitleLine && tail.length) tail = tail.slice(1);
  const beforeBlocks = blocks.slice(0, blockIndex);
  const splitAcrossThreadIds: string[] = [];
  for (const a of listCommentAnchors(doc)) {
    const range = anchorBlockRange(doc, a.id);
    if (!range) continue;
    if (range.first < blockIndex && range.last >= blockIndex) {
      splitAcrossThreadIds.push(a.id);
    }
  }
  let beforeContent = beforeBlocks;
  let afterContent = tail;
  if (splitAcrossThreadIds.length > 0) {
    afterContent = stripAnchorFromBlocks(afterContent);
    if (beforeContent.length) {
      const last = beforeContent.length - 1;
      beforeContent = [
        ...beforeContent.slice(0, last),
        truncateAnchorAtBlockEnd(beforeContent[last]!),
      ];
    }
  }
  return {
    before: { type: 'doc', content: beforeContent },
    after: {
      type: 'doc',
      content: afterContent.length
        ? afterContent
        : [{ type: 'paragraph', attrs: { style: 'body' } }],
    },
    splitAcrossThreadIds,
  };
}

export function planSplitChapterOutline(
  sections: readonly Section[],
  manuscriptId: string,
  chapterId: string,
  title: string,
): { sections: Section[]; newChapterId: string; newDocId: string } {
  const idx = sections.findIndex((s) => s.id === chapterId);
  if (idx < 0) throw new Error('Unknown chapter');
  const ch = sections[idx]!;
  const newChapterId = crypto.randomUUID();
  const newDocId = sectionDocId(manuscriptId, newChapterId);
  const row: Section = {
    id: newChapterId,
    kind: 'chapter',
    title: cleanTitle(title) || 'Untitled',
    docId: newDocId,
    ...(ch.parentId ? { parentId: ch.parentId } : {}),
  };
  const next = [...sections];
  next.splice(idx + 1, 0, row);
  return { sections: next, newChapterId, newDocId };
}

function titleParagraph(title: string): BlockNode {
  return {
    type: 'paragraph',
    attrs: { style: 'body' },
    content: [{ type: 'text', text: title }],
  };
}

export function planChapterMerge(
  sections: readonly Section[],
  targetId: string,
  sourceId: string,
  targetDoc: DocNode,
  sourceDoc: DocNode,
  sourceTitle: string,
): { sections: Section[]; mergedDoc: DocNode; removedChapterId: string } {
  const titleLine = cleanTitle(sourceTitle) || 'Untitled';
  const join: BlockNode[] = [
    ...(targetDoc.content ?? []),
    titleParagraph(titleLine),
    ...(sourceDoc.content ?? []),
  ];
  const mergedDoc: DocNode = { type: 'doc', content: join };
  const sectionsOut = deleteSection(sections, sourceId, { children: 'delete' });
  return { sections: sectionsOut, mergedDoc, removedChapterId: sourceId };
}

export function noteSectionIdsAfterSplit(
  sectionIds: readonly string[],
  chapterId: string,
  newChapterId: string,
): string[] {
  if (!sectionIds.includes(chapterId)) return [...sectionIds];
  const set = new Set(sectionIds);
  set.add(newChapterId);
  return [...set];
}

export function noteSectionIdsAfterMerge(
  sectionIds: readonly string[],
  targetId: string,
  sourceId: string,
): string[] {
  const without = sectionIds.filter((id) => id !== sourceId);
  const set = new Set(without);
  if (sectionIds.includes(sourceId)) set.add(targetId);
  return [...set];
}
