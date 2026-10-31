import { describe, expect, it } from 'vitest';
import {
  WORDS_PER_PAGE,
  estimatedCurrentPage,
  estimatedPageTotal,
  pageStatusLabel,
} from './pageEstimate';

describe('pageEstimate', () => {
  it('uses ~250 words per page for totals', () => {
    expect(WORDS_PER_PAGE).toBe(250);
    expect(estimatedPageTotal(0)).toBe(1);
    expect(estimatedPageTotal(1)).toBe(1);
    expect(estimatedPageTotal(250)).toBe(1);
    expect(estimatedPageTotal(251)).toBe(2);
    expect(estimatedPageTotal(12_000)).toBe(48);
  });

  it('derives the current page from words before the caret', () => {
    expect(estimatedCurrentPage(0, 0)).toBe(1);
    expect(estimatedCurrentPage(0, 500)).toBe(1);
    expect(estimatedCurrentPage(250, 500)).toBe(1);
    expect(estimatedCurrentPage(251, 500)).toBe(2);
    expect(estimatedCurrentPage(10_000, 12_000)).toBe(40);
    expect(estimatedCurrentPage(12_000, 12_000)).toBe(48);
  });

  it('formats long and narrow copy', () => {
    expect(pageStatusLabel(5, 48, false)).toEqual({
      visible: 'Page 5 of 48',
      ariaLabel: 'Estimated page 5 of 48',
    });
    expect(pageStatusLabel(5, 48, true)).toEqual({
      visible: 'p. 5',
      ariaLabel: 'Estimated page 5 of 48',
    });
  });
});
