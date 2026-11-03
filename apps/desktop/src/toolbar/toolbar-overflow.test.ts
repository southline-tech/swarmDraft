import { describe, expect, it } from 'vitest';
import { pickInlineOverflowItems, TOOLBAR_SPILL_ORDER } from './toolbar-overflow';

const W = Object.fromEntries(TOOLBAR_SPILL_ORDER.map((id) => [id, 40])) as Record<
  (typeof TOOLBAR_SPILL_ORDER)[number],
  number
>;

describe('pickInlineOverflowItems', () => {
  it('keeps highest-priority items inline when space is tight', () => {
    const pick = pickInlineOverflowItems(120, W, 30);
    expect(pick.inline).toEqual(['navigator', 'underline']);
    expect(pick.overflow).toContain('pageBreak');
    expect(pick.overflow).not.toContain('navigator');
  });

  it('fits everything inline and reserves no ⋯ width when all items fit', () => {
    const pick = pickInlineOverflowItems(2000, W, 30);
    expect(pick.overflow).toEqual([]);
    expect(pick.inline).toEqual([...TOOLBAR_SPILL_ORDER].reverse());
  });

  it('subtracts ⋯ width when some items overflow', () => {
    const budget = 40 * 3 + 2 * 2 + 30;
    const pick = pickInlineOverflowItems(budget, W, 30);
    expect(pick.inline.length).toBe(2);
    expect(pick.overflow.length).toBeGreaterThan(0);
  });
});
