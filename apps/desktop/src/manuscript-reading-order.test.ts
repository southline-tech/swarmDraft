import { describe, expect, it } from 'vitest';
import { addSection } from '@swarmdraft/editor';
import { sectionsInReadingOrder } from './manuscript-reading-order';

describe('sectionsInReadingOrder', () => {
  it('returns a depth-first reading order', () => {
    let s = addSection([], {
      manuscriptId: 'm',
      id: 't',
      kind: 'front_matter',
      title: 'Title',
    });
    s = addSection(s, { manuscriptId: 'm', id: 'p', kind: 'part', title: 'Part' });
    s = addSection(s, {
      manuscriptId: 'm',
      id: 'c1',
      kind: 'chapter',
      title: 'One',
      parentId: 'p',
    });
    s = addSection(s, {
      manuscriptId: 'm',
      id: 'c2',
      kind: 'chapter',
      title: 'Two',
      parentId: 'p',
    });
    expect(sectionsInReadingOrder(s).map((x) => x.id)).toEqual(['t', 'p', 'c1', 'c2']);
  });
});
