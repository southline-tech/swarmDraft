import { describe, expect, it } from 'vitest';
import type { DecisionRecord, SuggestionItem } from '@coauthor/editor';
import {
  DecisionLog,
  filterSummary,
  resolveCurrent,
  reviewActionFor,
  REVIEW_SHORTCUTS,
  step,
  authorVisibleInFilter,
  toggleAuthor,
  visibleItems,
} from './review-state';

const it3: SuggestionItem[] = ['a', 'b', 'a'].map((author, i) => ({
  id: `s${i}`,
  kind: 'suggestion_insert',
  author,
  ts: 't',
  text: 'x',
}));

describe('review state (RAD-258)', () => {
  it('filters by raw id; selecting everyone collapses back to All', () => {
    const authors = ['a', 'b'];
    const onlyB = toggleAuthor(authors, null, 'a');
    expect(visibleItems(it3, onlyB).map((i) => i.id)).toEqual(['s1']);
    expect(filterSummary(authors, onlyB)).toBe('1 of 2');
    expect(toggleAuthor(authors, onlyB, 'a')).toBeNull();
    expect(filterSummary(authors, null)).toBe('All');
  });

  it('authorVisibleInFilter matches visibleItems (#50)', () => {
    const onlyB = new Set(['b']);
    expect(authorVisibleInFilter(null, 'a')).toBe(true);
    expect(authorVisibleInFilter(onlyB, 'a')).toBe(false);
    expect(authorVisibleInFilter(onlyB, 'b')).toBe(true);
  });

  it('steps with wraparound and auto-advances to the change at the old position', () => {
    expect(step(3, -1, 1)).toBe(0);
    expect(step(3, -1, -1)).toBe(2);
    expect(step(3, 2, 1)).toBe(0);
    expect(step(0, 0, 1)).toBe(-1);
    const rest = it3.slice(1).map((i) => ({ key: `suggestion_insert\u0000${i.id}` }));
    expect(resolveCurrent(rest, 'suggestion_insert\u0000s0', 0)).toBe(0);
    expect(resolveCurrent(rest, 'suggestion_insert\u0000s2', 0)).toBe(1);
    expect(resolveCurrent([], null, 0)).toBe(-1);
  });

  it('withdraws a decision record on undo and restores it on redo', () => {
    const log = new DecisionLog();
    const r: DecisionRecord = {
      kind: 'suggestion_insert',
      id: 's0',
      status: 'accepted',
      decidedAt: 'now',
      decidedBy: 'author',
    };
    log.record([r]);
    expect(log.sync([])).toBe(false);
    expect(log.records()).toEqual([r]);
    expect(log.sync([{ kind: 'suggestion_insert', id: 's0' }])).toBe(true); // undo
    expect(log.records()).toEqual([]);
    expect(log.sync([])).toBe(true); // redo
    expect(log.records()).toEqual([r]);
  });

  it('maps the review shortcuts and never claims Ctrl+R or Ctrl+J', () => {
    const k = (key: string, m: Partial<KeyboardEventInit> = {}) =>
      reviewActionFor(new KeyboardEvent('keydown', { key, ...m }));
    expect(k('ArrowRight', { altKey: true, shiftKey: true })).toBe('next');
    expect(k('ArrowLeft', { altKey: true, shiftKey: true })).toBe('prev');
    expect(k('Enter', { ctrlKey: true, shiftKey: true })).toBe('accept');
    expect(k('Backspace', { ctrlKey: true, shiftKey: true })).toBe('reject');
    expect(k('\\', { ctrlKey: true })).toBe('toggle');
    expect(k('r', { ctrlKey: true })).toBeNull();
    expect(k('j', { ctrlKey: true })).toBeNull();
    expect(k('ArrowRight', { shiftKey: true })).toBeNull();
    expect(Object.values(REVIEW_SHORTCUTS).join(' ')).not.toMatch(/Ctrl\+[RJ]\b/);
  });
});
