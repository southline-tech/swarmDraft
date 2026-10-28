import {
  DEFAULT_NUMBERING_STYLE,
  isNumberingStyle,
  type NumberingStyle,
  type Section,
} from '@coauthor/schema';
import { buildOutline, type OutlineNode } from './outline';

const WORDS = [
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
];

function word(n: number): string {
  return WORDS[n - 1] ?? String(n);
}

function formatIndex(n: number, style: NumberingStyle): string {
  switch (style) {
    case 'chapter_arabic':
      return String(n);
    case 'chapter_words':
      return word(n);
    case 'chapter_upper':
      return word(n).toUpperCase();
    case 'number_only':
      return String(n);
    default:
      return String(n);
  }
}

/** Display-only label above the section body (never written into the Yjs doc). */
export function sectionNumberLabel(
  kind: 'part' | 'chapter',
  index: number,
  style: NumberingStyle,
): string {
  if (index < 1) return '';
  const num = formatIndex(index, style);
  if (kind === 'part') {
    if (style === 'chapter_upper') return `Part ${word(index).toUpperCase()}`;
    if (style === 'chapter_arabic' || style === 'number_only') return `Part ${index}`;
    return `Part ${word(index)}`;
  }
  switch (style) {
    case 'number_only':
      return num;
    case 'chapter_upper':
      return num;
    default:
      return `Chapter ${num}`;
  }
}

/** Optional title after the number, e.g. "Chapter 1: Low Tide". */
export function sectionDisplayHeading(label: string, title: string): string {
  const t = title.trim();
  if (!label) return t;
  if (!t) return label;
  return `${label}: ${t}`;
}

function walkOutline(nodes: OutlineNode[], visit: (s: Section) => void) {
  for (const { children, ...section } of nodes) {
    visit(section);
    walkOutline(children, visit);
  }
}

/**
 * Labels for numbered sections in reading order. Front and back matter are omitted.
 * Chapter indices are book-wide; part indices count only parts.
 */
export function sectionNumberLabels(
  outline: readonly Section[],
  style: NumberingStyle = DEFAULT_NUMBERING_STYLE,
): Map<string, string> {
  const labels = new Map<string, string>();
  let chapter = 0;
  let part = 0;
  walkOutline(buildOutline(outline), (s) => {
    if (s.kind === 'chapter') {
      chapter += 1;
      labels.set(s.id, sectionNumberLabel('chapter', chapter, style));
    } else if (s.kind === 'part') {
      part += 1;
      labels.set(s.id, sectionNumberLabel('part', part, style));
    }
  });
  return labels;
}

export function parseNumberingStyle(value: unknown): NumberingStyle {
  return typeof value === 'string' && isNumberingStyle(value) ? value : DEFAULT_NUMBERING_STYLE;
}
