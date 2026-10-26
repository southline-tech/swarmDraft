import { describe, expect, it } from 'vitest';
import type { Section } from '@coauthor/schema';
import {
  addSection,
  buildOutline,
  canNest,
  dropSection,
  moveSection,
  renameSection,
} from './outline';

// Synthetic titles only.
function sample(): Section[] {
  let s: Section[] = [];
  const add = (id: string, kind: Section['kind'], title: string, parentId?: string) =>
    (s = addSection(s, { manuscriptId: 'm1', id, kind, title, ...(parentId ? { parentId } : {}) }));
  add('t', 'front_matter', 'Title page');
  add('p1', 'part', 'Part A');
  add('c1', 'chapter', 'Chapter A1', 'p1');
  add('s1', 'scene', 'Scene 1', 'c1');
  add('s2', 'scene', 'Scene 2', 'c1');
  add('c2', 'chapter', 'Chapter A2', 'p1');
  add('p2', 'part', 'Part B');
  add('b', 'back_matter', 'About');
  return s;
}
const ids = (s: Section[]) => s.map((x) => x.id);

describe('outline', () => {
  it('builds a nested tree in reading order with per-section doc ids', () => {
    const s = sample();
    expect(ids(s)).toEqual(['t', 'p1', 'c1', 's1', 's2', 'c2', 'p2', 'b']);
    const tree = buildOutline(s);
    expect(tree.map((n) => n.id)).toEqual(['t', 'p1', 'p2', 'b']);
    expect(tree[1]!.children.map((n) => n.id)).toEqual(['c1', 'c2']);
    expect(tree[1]!.children[0]!.children.map((n) => n.id)).toEqual(['s1', 's2']);
    expect(s.find((x) => x.id === 's1')!.docId).toBe('manuscript/m1/section/s1');
  });

  it('enforces nesting', () => {
    expect(canNest('scene', 'chapter')).toBe(true);
    expect(canNest('scene', undefined)).toBe(false);
    expect(canNest('chapter', undefined)).toBe(true);
    expect(canNest('chapter', 'scene')).toBe(false);
    expect(() => addSection(sample(), { manuscriptId: 'm1', kind: 'scene', title: 'x' })).toThrow();
  });

  it('appends new sections at the end of their parent with a fresh id', () => {
    const s = addSection(sample(), {
      manuscriptId: 'm1',
      kind: 'scene',
      title: 'Scene 3',
      parentId: 'c1',
    });
    expect(s[5]!.title).toBe('Scene 3');
    expect(s[5]!.id).toMatch(/[0-9a-f-]{36}/);
    expect(s[5]!.docId).toBe(`manuscript/m1/section/${s[5]!.id}`);
  });

  it('renames', () => {
    expect(renameSection(sample(), 'c2', 'Renamed').find((x) => x.id === 'c2')!.title).toBe(
      'Renamed',
    );
  });

  it('moves a section and its children among siblings', () => {
    expect(ids(moveSection(sample(), 'c2', -1))).toEqual([
      't',
      'p1',
      'c2',
      'c1',
      's1',
      's2',
      'p2',
      'b',
    ]);
    expect(ids(moveSection(sample(), 't', -1))).toEqual(ids(sample()));
  });

  it('drops a scene into another chapter, before a sibling or at the end', () => {
    let s = dropSection(sample(), 's1', { parentId: 'c2' });
    expect(ids(s)).toEqual(['t', 'p1', 'c1', 's2', 'c2', 's1', 'p2', 'b']);
    expect(s.find((x) => x.id === 's1')!.parentId).toBe('c2');
    s = dropSection(s, 's2', { beforeId: 's1' });
    expect(ids(s)).toEqual(['t', 'p1', 'c1', 'c2', 's2', 's1', 'p2', 'b']);
  });

  it('moves a chapter to the top level and rejects invalid drops', () => {
    const s = dropSection(sample(), 'c2', { beforeId: 'p2' });
    expect(s.find((x) => x.id === 'c2')!.parentId).toBeUndefined();
    expect(ids(dropSection(sample(), 's1', { beforeId: 'p2' }))).toEqual(ids(sample()));
    expect(ids(dropSection(sample(), 'p1', { parentId: 'c1' }))).toEqual(ids(sample()));
    expect(ids(dropSection(sample(), 'c1', { parentId: 'c1' }))).toEqual(ids(sample()));
  });
});
