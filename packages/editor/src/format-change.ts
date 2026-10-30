/**
 * Helpers for the `format_change` suggestion mark (#160).
 */
import type { FormatChangeAttrs } from '@coauthor/schema';
import { PARAGRAPH_STYLE_LABELS, type ParagraphStyle } from './content';

export const PARAGRAPH_STYLE_TARGET = 'paragraph_style';

export const TRACKED_INLINE_FORMATS = [
  'bold',
  'italic',
  'smallcaps',
  'underline',
  'strike',
] as const;

export type TrackedInlineFormat = (typeof TRACKED_INLINE_FORMATS)[number];

const INLINE_LABELS: Record<TrackedInlineFormat, string> = {
  bold: 'bold',
  italic: 'italic',
  smallcaps: 'small caps',
  underline: 'underline',
  strike: 'strikethrough',
};

/** Human-readable summary for review cards and hover labels. */
export function formatChangeSummary(target: string, before: string, after: string): string {
  if (target === PARAGRAPH_STYLE_TARGET) {
    const fromKey = (before || 'body') as ParagraphStyle;
    const toKey = (after || 'body') as ParagraphStyle;
    const from = PARAGRAPH_STYLE_LABELS[fromKey] ?? before ?? 'Body';
    const to = PARAGRAPH_STYLE_LABELS[toKey] ?? after ?? 'Body';
    return `${from} → ${to}`;
  }
  const label = INLINE_LABELS[target as TrackedInlineFormat] ?? target;
  if (after === '1' && before === '0') return `Add ${label}`;
  if (after === '0' && before === '1') return `Remove ${label}`;
  return `Change ${label}`;
}

export function formatChangeAttrs(partial: {
  id: string;
  author: string;
  ts?: string;
  target: string;
  before: string;
  after: string;
}): FormatChangeAttrs {
  return {
    id: partial.id,
    author: partial.author,
    ts: partial.ts ?? new Date().toISOString(),
    target: partial.target,
    before: partial.before,
    after: partial.after,
  };
}

export function readFormatAttrs(attrs: Record<string, unknown>): FormatChangeAttrs | null {
  const id = attrs.id;
  const author = attrs.author;
  const ts = attrs.ts;
  const target = attrs.target;
  const before = attrs.before;
  const after = attrs.after;
  if (typeof id !== 'string' || !id) return null;
  if (typeof author !== 'string') return null;
  if (typeof ts !== 'string') return null;
  if (typeof target !== 'string' || !target) return null;
  if (typeof before !== 'string') return null;
  if (typeof after !== 'string') return null;
  return { id, author, ts, target, before, after };
}

/** Whether an inline format mark should be present after a reject (restore `before`). */
export function inlineFormatOnBefore(target: string, before: string): boolean {
  return before === '1';
}
