import { describe, expect, it } from 'vitest';
import type { Section } from '@coauthor/schema';
import {
  addSection,
  applyOutlineEdit,
  buildOutline,
  canNest,
  canPromoteChildren,
  cleanTitle,
  deleteSection,
  MAX_TITLE_LENGTH,
  normalizeOutline,
  validParents,
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

describe('outline hardening', () => {
  const sec = (id: string, kind: Section['kind'], parentId?: string, title = id): Section => ({
    id,
    kind,
    title,
    docId: `manuscript/m1/section/${id}`,
    ...(parentId ? { parentId } : {}),
  });

  it('shows every section once when parents form a two-node cycle', () => {
    const s = [sec('a', 'part', 'b'), sec('b', 'part', 'a'), sec('c', 'chapter', 'a')];
    const { sections, issues } = normalizeOutline(s);
    expect(ids(sections).sort()).toEqual(['a', 'b', 'c']);
    expect(issues.filter((i) => i.problem === 'parent-cycle').map((i) => i.id)).toEqual(['a']);
    expect(buildOutline(s).map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('dropSection terminates and keeps everything on cyclic input', () => {
    const s = [sec('a', 'part', 'b'), sec('b', 'part', 'a'), sec('c', 'chapter', 'a')];
    const out = dropSection(s, 'c', { parentId: 'b' });
    expect(ids(out).sort()).toEqual(['a', 'b', 'c']);
    expect(out.find((x) => x.id === 'c')!.parentId).toBe('b');
    expect(ids(moveSection(s, 'b', -1)).sort()).toEqual(['a', 'b', 'c']);
  });

  it('repairs self-parents, missing parents, invalid nesting and repeated ids', () => {
    const s = [
      sec('a', 'chapter', 'a'),
      sec('b', 'chapter', 'gone'),
      sec('c', 'part', 'a'),
      sec('a', 'part'),
    ];
    const { sections, issues } = normalizeOutline(s);
    expect(ids(sections)).toEqual(['a', 'b', 'c']);
    expect(sections.every((x) => x.parentId === undefined)).toBe(true);
    expect(issues.map((i) => i.problem).sort()).toEqual([
      'duplicate-id',
      'invalid-nesting',
      'missing-parent',
      'parent-cycle',
    ]);
  });

  it('cleans titles: control characters, whitespace and length', () => {
    expect(cleanTitle('  A\u0000B\tC\nD\u202829  ')).toBe('A B C D 29');
    expect([...cleanTitle('é'.repeat(500))]).toHaveLength(MAX_TITLE_LENGTH);
    const s = renameSection(sample(), 'c1', 'x\u0007'.repeat(300));
    expect(s.find((x) => x.id === 'c1')!.title).toHaveLength(MAX_TITLE_LENGTH - 1);
    expect(renameSection(sample(), 'c1', '\u0001 \u0002').find((x) => x.id === 'c1')!.title).toBe(
      'Chapter A1',
    );
    expect(normalizeOutline([sec('z', 'part', undefined, 7 as never)]).sections[0]!.title).toBe('');
  });

  it('deletes with children, or promotes them when they can move up', () => {
    expect(ids(deleteSection(sample(), 'c1', { children: 'delete' }))).toEqual([
      't',
      'p1',
      'c2',
      'p2',
      'b',
    ]);
    expect(canPromoteChildren(sample(), 'c1')).toBe(false); // scenes cannot sit under a part
    expect(() => deleteSection(sample(), 'c1', { children: 'promote' })).toThrow();
    const out = deleteSection(sample(), 'p1', { children: 'promote' });
    expect(ids(out)).toEqual(['t', 'c1', 's1', 's2', 'c2', 'p2', 'b']);
    expect(out.find((x) => x.id === 'c1')!.parentId).toBeUndefined();
    expect(() => deleteSection(sample(), 'nope', { children: 'delete' })).toThrow();
  });

  it('lists valid parents for a non-drag move', () => {
    expect(validParents(sample(), 's1').map((p) => p?.id)).toEqual(['c1', 'c2']);
    expect(validParents(sample(), 'c1').map((p) => p?.id)).toEqual([undefined, 'p1', 'p2']);
    expect(validParents(sample(), 'p1').map((p) => p?.id)).toEqual([undefined]);
  });

  it('applies edits all-or-nothing', () => {
    const s = sample();
    const bad = applyOutlineEdit(s, (x) => [...x, sec('s9', 'scene', 'p2')]);
    expect(bad.ok).toBe(false);
    expect(bad.sections).toEqual(s);
    const thrown = applyOutlineEdit(s, (x) => deleteSection(x, 'c1', { children: 'promote' }));
    expect(thrown.ok).toBe(false);
    const good = applyOutlineEdit(s, (x) => renameSection(x, 'c1', 'New'));
    expect(good.ok && good.sections.find((x) => x.id === 'c1')!.title).toBe('New');
  });

  it('rejects a duplicate id on add', () => {
    expect(() =>
      addSection(sample(), { manuscriptId: 'm1', id: 'c1', kind: 'chapter', title: 'x' }),
    ).toThrow();
  });
});
