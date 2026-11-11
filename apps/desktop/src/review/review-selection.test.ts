import { describe, expect, it } from 'vitest';
import { filterChangesById, selectedChangesLabel } from './review-state';

describe('review link selection (#119)', () => {
  const items = [
    { id: 's1', author: 'agent:a' },
    { id: 's2', author: 'brett' },
    { id: 's3', author: 'agent:a' },
  ];

  it('keeps only the selected change ids', () => {
    expect(filterChangesById(items, ['s3', 's1']).map((item) => item.id)).toEqual(['s1', 's3']);
    expect(filterChangesById(items, ['missing'])).toEqual([]);
    expect(filterChangesById(items, null)).toEqual(items);
  });

  it('labels the chip with the selected count', () => {
    expect(selectedChangesLabel(1)).toBe('Showing 1 selected change');
    expect(selectedChangesLabel(2)).toBe('Showing 2 selected changes');
  });
});
