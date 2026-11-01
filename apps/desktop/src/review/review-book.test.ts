import { describe, expect, it } from 'vitest';
import {
  bookChangesFromSections,
  bookChapterGroups,
  openChangeCountsBySection,
  parseBookChangeKey,
  scopeBookChangeKey,
} from './review-book';
import type { SuggestionItem } from '@swarmdraft/editor';
import { pickActiveManuscriptMark, type ManuscriptMarkAnchor } from './review-scroll';

const s1: SuggestionItem[] = [
  { id: 'a', kind: 'suggestion_insert', author: 'brett', ts: 't', text: 'one' },
];
const s2: SuggestionItem[] = [
  { id: 'b', kind: 'suggestion_delete', author: 'agent:x', ts: 't', text: 'two' },
];

describe('review-book', () => {
  it('scopes change keys by section and parses them back', () => {
    const scoped = scopeBookChangeKey('ch-1', 'brett\u0000a');
    expect(parseBookChangeKey(scoped)).toEqual({ sectionId: 'ch-1', changeKey: 'brett\u0000a' });
  });

  it('aggregates open changes in reading order across sections', () => {
    const map = new Map([
      ['b', s2],
      ['a', s1],
    ]);
    const changes = bookChangesFromSections(['a', 'b'], map);
    expect(changes).toHaveLength(2);
    expect(changes[0]!.key).toBe(scopeBookChangeKey('a', 'brett\u0000a'));
    expect(changes[1]!.key).toBe(scopeBookChangeKey('b', 'agent:x\u0000b'));
    const groups = bookChapterGroups(['a', 'b'], changes, (id) => `Chapter · ${id}`);
    expect(groups.map((g) => g.sectionId)).toEqual(['a', 'b']);
    expect(openChangeCountsBySection(['a', 'b'], map)).toEqual({ a: 1, b: 1 });
  });
});

describe('pickActiveManuscriptMark', () => {
  it('picks the first mark at or below the offset line', () => {
    const root = document.createElement('div');
    root.getBoundingClientRect = () =>
      ({ top: 100, bottom: 500, left: 0, right: 400, width: 400, height: 400 }) as DOMRect;
    const anchors: ManuscriptMarkAnchor[] = [
      { scopedKey: 'a', top: 120, el: document.createElement('ins') },
      { scopedKey: 'b', top: 180, el: document.createElement('ins') },
    ];
    expect(pickActiveManuscriptMark(anchors, root, null, 64)).toBe('b');
    expect(pickActiveManuscriptMark(anchors, root, null, 100)).toBe('b');
  });
});
