/**
 * Scan a book for heading-like lines that can be split into chapters (#305).
 * Proposals only: applying a break uses the #304 split helpers.
 */
import type { BlockNode, DocNode } from '@swarmdraft/schema';
import { firstLineText, suggestSplitTitle } from './chapter-split-merge';

export type ChapterBreakKind = 'numbered' | 'ornament' | 'title';

export interface BreakScanChapter {
  id: string;
  title: string;
  /** 0-based index among chapters in reading order. */
  chapterIndex: number;
  doc: DocNode;
}

export interface ChapterBreakCandidate {
  key: string;
  chapterId: string;
  sourceTitle: string;
  blockIndex: number;
  kind: ChapterBreakKind;
  title: string;
  removeLine: boolean;
  snippet: string;
}

const ONES = 'one|two|three|four|five|six|seven|eight|nine';
const TEENS = 'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const NUMBER_WORD = new RegExp(`^(?:${ONES}|${TEENS}|${TENS}|hundred)(?:[\\s-](?:${ONES}))?$`, 'i');
const ROMAN_RE = /^(?:m{0,4})(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;
const NOT_A_TITLE = new Set([
  'yes',
  'no',
  'oh',
  'ok',
  'okay',
  'wait',
  'stop',
  'hi',
  'hey',
  'hello',
  'well',
  'and',
  'but',
  'or',
  'the',
  'a',
  'an',
  'i',
  'we',
  'he',
  'she',
  'they',
  'it',
  'you',
  'me',
  'my',
  'his',
  'her',
  'hmm',
  'ah',
  'ha',
]);
const MINOR_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'and',
  'or',
  'in',
  'on',
  'to',
  'for',
  'from',
  'with',
  'by',
  'at',
  'as',
]);

/** Drop leading `#` marks and wrapping `**` / `*` so a typed heading can be matched. */
export function stripSimpleHeadingMarkup(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  t = t.replace(/^#{1,6}\s*/, '');
  const wrapped = /^(?:\*\*|__)(.+)(?:\*\*|__)$/.exec(t);
  if (wrapped?.[1]) return wrapped[1].trim();
  const star = /^\*(.+)\*$/.exec(t);
  if (star?.[1] && !/^\*+$/.test(t)) return star[1].trim();
  const under = /^_(.+)_$/.exec(t);
  if (under?.[1]) return under[1].trim();
  return t.trim();
}

function isRomanNumeral(token: string, minLength: number): boolean {
  if (token.length < minLength || token.length > 20) return false;
  return ROMAN_RE.test(token);
}

function headingToken(rest: string): string {
  const trimmed = rest.trim().replace(/[.]+$/g, '');
  const sub = /^(.*?)(?:\s*[:\u2014\u2013-]\s+\S.*)$/.exec(trimmed);
  return (sub?.[1] ?? trimmed).trim();
}

export function isNumberedHeadingLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^\d+$/.test(t)) return t.length <= 60;
  if (isRomanNumeral(t, 2) && t.length <= 60) return true;
  const m = /^(chapter|ch\.|part|book)\s*(.+)$/i.exec(t);
  if (!m?.[2]) return false;
  const token = headingToken(m[2]);
  if (!token) return false;
  if (/^\d+$/.test(token)) return true;
  if (isRomanNumeral(token, 1)) return true;
  return NUMBER_WORD.test(token);
}

export function isOrnamentLine(line: string): boolean {
  const compact = line.replace(/\s+/g, '');
  if (compact.length < 3) return false;
  return /^[*•\u2014\u2013-]+$/.test(compact);
}

function endsWithSentencePunct(line: string): boolean {
  return /[.?!…]$/.test(line.trim());
}

function isTitleCasePhrase(line: string): boolean {
  const stripped = line.replace(/[.?!…]+$/u, '').trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return words.every((word, i) => {
    const core = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (!core) return false;
    if (/^\d/.test(core)) return true;
    const lower = core.toLowerCase();
    if (i > 0 && i < words.length - 1 && MINOR_WORDS.has(lower)) return /^[a-z]/.test(core);
    const first = core[0] ?? '';
    return first !== first.toLowerCase() && first === first.toUpperCase();
  });
}

function looksLikeDialogue(line: string): boolean {
  const t = line.trim();
  if (/^["“«]/.test(t)) return true;
  if (/^['‘]\S/.test(t)) return true;
  if (/^[\u2014\u2013]\s*\S/.test(t)) return true;
  return false;
}

function isExcludedShortWord(line: string): boolean {
  const words = line
    .replace(/[.?!…]+$/u, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length !== 1) return false;
  const key = words[0]!.replace(/[^A-Za-z]/g, '').toLowerCase();
  return NOT_A_TITLE.has(key);
}

export function isShortStandaloneTitle(
  line: string,
  ctx: { centered: boolean; surrounded: boolean },
): boolean {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  if (!ctx.surrounded && !ctx.centered) return false;
  if (looksLikeDialogue(t) || isExcludedShortWord(t)) return false;
  const words = t
    .replace(/[.?!…]+$/u, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const titleCase = isTitleCasePhrase(t);
  if (endsWithSentencePunct(t) && !(titleCase && words.length >= 2)) return false;
  if (!ctx.centered && !titleCase) return false;
  return true;
}

function blockPlainText(block: BlockNode | undefined): string {
  if (!block) return '';
  if (block.type === 'scene_break') return (block.attrs.marker ?? '').replace(/\s+/g, ' ').trim();
  return firstLineText(block);
}

function isBlankParagraph(block: BlockNode | undefined): boolean {
  if (!block) return false;
  if (block.type !== 'paragraph' && block.type !== 'heading') return false;
  return blockPlainText(block).length === 0;
}

function isLeadingSkip(block: BlockNode): boolean {
  return isBlankParagraph(block) || block.type === 'page_break';
}

/** First paragraph of a chapter is already that chapter's start. */
export function firstChapterParagraphIndex(blocks: readonly BlockNode[]): number {
  return blocks.findIndex((block) => !isLeadingSkip(block));
}

function surroundedByBreak(blocks: readonly BlockNode[], index: number): boolean {
  const before = index === 0 || isBlankParagraph(blocks[index - 1]);
  const after = index === blocks.length - 1 || isBlankParagraph(blocks[index + 1]);
  return before && after;
}

function classifyBlock(
  block: BlockNode,
  blocks: readonly BlockNode[],
  index: number,
): ChapterBreakKind | null {
  const raw = blockPlainText(block);
  if (!raw) return null;
  if (isOrnamentLine(raw)) return 'ornament';
  if (block.type === 'scene_break') return null;
  const stripped = stripSimpleHeadingMarkup(raw);
  if (!stripped) return null;
  if (isNumberedHeadingLine(stripped)) return 'numbered';
  const centered = block.type === 'paragraph' && block.attrs.style === 'centered';
  const heading = block.type === 'heading';
  if (heading) return 'title';
  if (
    isShortStandaloneTitle(stripped, { centered, surrounded: surroundedByBreak(blocks, index) })
  ) {
    return 'title';
  }
  return null;
}

function followingSnippet(blocks: readonly BlockNode[], index: number): string {
  for (let i = index + 1; i < blocks.length; i++) {
    const text = stripSimpleHeadingMarkup(blockPlainText(blocks[i]));
    if (text) return text.slice(0, 80);
  }
  return '';
}

function proposedBreak(
  kind: ChapterBreakKind,
  raw: string,
  chapterNumber: number,
): { title: string; removeLine: boolean } {
  if (kind === 'ornament') return { title: `Chapter ${chapterNumber}`, removeLine: false };
  const stripped = stripSimpleHeadingMarkup(raw);
  const title = suggestSplitTitle(stripped, chapterNumber).title;
  return { title, removeLine: stripped.length > 0 && stripped.length <= 60 };
}

/**
 * Chapter number a new chapter would have if every proposed break up to and
 * including this one were applied, in reading order.
 */
function prospectiveNumber(chapterIndex: number, priorBreaks: number, inChapter: number): number {
  return chapterIndex + priorBreaks + inChapter + 1;
}

export function scanChapterBreaks(chapters: readonly BreakScanChapter[]): ChapterBreakCandidate[] {
  const out: ChapterBreakCandidate[] = [];
  let priorBreaks = 0;
  for (const chapter of chapters) {
    const blocks = chapter.doc.content ?? [];
    const skip = firstChapterParagraphIndex(blocks);
    let inChapter = 0;
    blocks.forEach((block, blockIndex) => {
      if (blockIndex === skip) return;
      const kind = classifyBlock(block, blocks, blockIndex);
      if (!kind) return;
      inChapter += 1;
      const raw = blockPlainText(block);
      const n = prospectiveNumber(chapter.chapterIndex, priorBreaks, inChapter);
      const proposed = proposedBreak(kind, raw, n);
      out.push({
        key: `${chapter.id}:${blockIndex}`,
        chapterId: chapter.id,
        sourceTitle: chapter.title.trim() || 'Untitled',
        blockIndex,
        kind,
        title: proposed.title,
        removeLine: proposed.removeLine,
        snippet: followingSnippet(blocks, blockIndex),
      });
    });
    priorBreaks += inChapter;
  }
  return out;
}

export function skippedBreaksMessage(count: number): string {
  const noun = count === 1 ? 'break' : 'breaks';
  return `Skipped ${count} ${noun}: resolve the change at that spot first`;
}
