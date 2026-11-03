/**
 * Responsive toolbar overflow (issue 268): which flexible items stay inline vs ⋯ menu.
 * Spill order from Designer (issue 268): first listed = first moved into overflow when narrow.
 */
import type { ToolbarCommand } from './toolbar';

/** Stable ids for flexible toolbar items (each appears in exactly one place). */
export type ToolbarOverflowItemId =
  | 'navigator'
  | 'underline'
  | 'aligns'
  | 'comment'
  | 'find'
  | 'smallcaps'
  | 'strike'
  | 'style-first'
  | 'epigraph'
  | 'verse'
  | 'pageBreak';

/** First to leave the bar when width shrinks; last to stay inline among flexible items. */
export const TOOLBAR_SPILL_ORDER: readonly ToolbarOverflowItemId[] = [
  'pageBreak',
  'verse',
  'epigraph',
  'style-first',
  'strike',
  'smallcaps',
  'find',
  'comment',
  'aligns',
  'underline',
  'navigator',
];

/** Highest inline priority first (reverse of spill). */
export const TOOLBAR_INLINE_PRIORITY: readonly ToolbarOverflowItemId[] = [
  ...TOOLBAR_SPILL_ORDER,
].reverse();

export const TOOLBAR_FLEX_GAP_PX = 2;

export interface InlineOverflowPick {
  inline: ToolbarOverflowItemId[];
  overflow: ToolbarOverflowItemId[];
}

/** Pick inline vs overflow for a measured available width (flex slot between pinned clusters). */
export function pickInlineOverflowItems(
  availableWidth: number,
  itemWidths: Readonly<Partial<Record<ToolbarOverflowItemId, number>>>,
  overflowButtonWidth: number,
  gap = TOOLBAR_FLEX_GAP_PX,
): InlineOverflowPick {
  const fit = (budget: number): InlineOverflowPick => {
    const inline: ToolbarOverflowItemId[] = [];
    let used = 0;
    for (const id of TOOLBAR_INLINE_PRIORITY) {
      const w = itemWidths[id] ?? 0;
      const next = inline.length ? used + gap + w : used + w;
      if (next <= budget + 0.5) {
        inline.push(id);
        used = next;
      }
    }
    const inlineSet = new Set(inline);
    const overflow = TOOLBAR_SPILL_ORDER.filter((id) => !inlineSet.has(id));
    return { inline, overflow };
  };

  let pick = fit(availableWidth);
  if (pick.overflow.length > 0 && overflowButtonWidth > 0) {
    const reserved = overflowButtonWidth + (pick.inline.length ? gap : 0);
    pick = fit(Math.max(0, availableWidth - reserved));
  }
  return pick;
}

/** Text-row actions in the ⋯ menu (also render inline when they fit). */
export const TOOLBAR_OVERFLOW_TEXT_ACTIONS: {
  id: Exclude<ToolbarOverflowItemId, 'navigator' | 'underline' | 'aligns' | 'comment' | 'find'>;
  cmd: ToolbarCommand;
  label: string;
  active?: 'smallcaps' | 'strike';
}[] = [
  { id: 'smallcaps', cmd: 'smallcaps', label: 'Small caps', active: 'smallcaps' },
  { id: 'strike', cmd: 'strike', label: 'Strikethrough', active: 'strike' },
  { id: 'style-first', cmd: 'style:first', label: 'First paragraph' },
  { id: 'epigraph', cmd: 'style:epigraph', label: 'Epigraph' },
  { id: 'verse', cmd: 'style:verse', label: 'Verse' },
  { id: 'pageBreak', cmd: 'pageBreak', label: 'Insert page break' },
];
