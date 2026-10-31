import type { Mark as PMMark, Node as PMNode } from '@tiptap/pm/model';
import { SUGGESTION_MARKS } from '../content';

const isSkippedMark = (m: PMMark) => (SUGGESTION_MARKS as readonly string[]).includes(m.type.name);

/** Plain text for Harper plus a map from string index → document position. */
export interface LintableText {
  text: string;
  map: number[];
}

/** Collect lintable text inside one text block, skipping suggestion / track marks. */
export function lintableBlockText(block: PMNode, blockPos: number): LintableText {
  const base = blockPos + 1;
  let text = '';
  const map: number[] = [];

  block.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    if (node.marks.some(isSkippedMark)) return true;
    const nodeStart = base + pos;
    for (let i = 0; i < node.text.length; i++) {
      map.push(nodeStart + i);
      text += node.text[i]!;
    }
    return true;
  });

  return { text, map };
}

export function mapLintSpan(
  map: number[],
  start: number,
  end: number,
): { from: number; to: number } | null {
  if (start >= end || start >= map.length) return null;
  const endIdx = Math.min(end, map.length) - 1;
  const from = map[start];
  const toPos = map[endIdx];
  if (from === undefined || toPos === undefined) return null;
  return { from, to: toPos + 1 };
}

export function surfaceWord(doc: PMNode, from: number, to: number): string {
  return doc.textBetween(from, to, '');
}
