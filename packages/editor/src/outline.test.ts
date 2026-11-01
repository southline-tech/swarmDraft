import { describe, expect, it } from 'vitest';
import type { Section } from '@swarmdraft/schema';
import {
  addSection,
  applyOutlineEdit,
  buildOutline,
  canNest,
  canPromoteChildren,
  cleanTitle,
  titleLength,
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
  add('c2', 'chapter', 'Chapter A2', 'p1');
  add('c3', 'chapter', 'Chapter A3', 'p1');
  add('p2', 'part', 'Part B');
  add('b', 'back_matter', 'About');
  return s;
}
const ids = (s: Section[]) => s.map((x) => x.id);

describe('outline', () => {
  it('builds a nested tree in reading order with per-section doc ids', () => {
    const s = sample();
    expect(ids(s)).toEqual(['t', 'p1', 'c1', 'c2', 'c3', 'p2', 'b']);
    const tree = buildOutline(s);
    expect(tree.map((n) => n.id)).toEqual(['t', 'p1', 'p2', 'b']);
    expect(tree[1]!.children.map((n) => n.id)).toEqual(['c1', 'c2', 'c3']);
    expect(s.find((x) => x.id === 'c1')!.docId).toBe('manuscript/m1/section/c1');
  });

  it('enforces nesting', () => {
    expect(canNest('chapter', 'part')).toBe(true);
    expect(canNest('chapter', undefined)).toBe(true);
    expect(canNest('part', 'chapter')).toBe(false);
    expect(() =>
      addSection(sample(), { manuscriptId: 'm1', kind: 'chapter', title: 'x', parentId: 'c1' }),
    ).toThrow();
  });

  it('appends new sections at the end of their parent with a fresh id', () => {
    const s = addSection(sample(), {
      manuscriptId: 'm1',
      kind: 'chapter',
      title: 'Chapter A4',
      parentId: 'p1',
    });
    expect(s[5]!.title).toBe('Chapter A4');
    expect(s[5]!.id).toMatch(/[0-9a-f-]{36}/);
    expect(s[5]!.docId).toBe(`manuscript/m1/section/${s[5]!.id}`);
  });

  it('renames', () => {
    expect(renameSection(sample(), 'c2', 'Renamed').find((x) => x.id === 'c2')!.title).toBe(
      'Renamed',
    );
  });

  it('moves a section among siblings', () => {
    expect(ids(moveSection(sample(), 'c3', -1))).toEqual(['t', 'p1', 'c1', 'c3', 'c2', 'p2', 'b']);
    expect(ids(moveSection(sample(), 't', -1))).toEqual(ids(sample()));
  });

  it('drops a chapter into another part, before a sibling or at the end', () => {
    let s = dropSection(sample(), 'c1', { parentId: 'p2' });
    expect(s.find((x) => x.id === 'c1')!.parentId).toBe('p2');
    s = dropSection(s, 'c2', { beforeId: 'c1' });
    expect(ids(s).indexOf('c2')).toBeLessThan(ids(s).indexOf('c1'));
  });

  it('moves a chapter to the top level and rejects invalid drops', () => {
    const s = dropSection(sample(), 'c2', { beforeId: 'p2' });
    expect(s.find((x) => x.id === 'c2')!.parentId).toBeUndefined();
    expect(ids(dropSection(sample(), 'c1', { parentId: 'c2' }))).toEqual(ids(sample()));
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
    const s = [sec('a', 'part', 'b'), sec('b', 'chapter', 'a'), sec('c', 'chapter', 'b')];
    const { sections, issues } = normalizeOutline(s);
    expect(ids(sections).sort()).toEqual(['a', 'b', 'c']);
    expect(issues.filter((i) => i.problem === 'parent-cycle').map((i) => i.id)).toEqual(['a']);
    const tree = buildOutline(s);
    expect(tree.map((n) => n.id)).toEqual(['a', 'c']);
    expect(tree[0]!.children.map((n) => n.id)).toEqual(['b']);
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

  it('keeps a repeated id on a different doc as its own section with a fresh id', () => {
    const s = [
      { ...sec('c1', 'chapter'), docId: 'd2' },
      { ...sec('c1', 'chapter'), docId: 'd3', title: 'other' },
      { ...sec('c1', 'chapter'), docId: 'd2' },
    ];
    const { sections, issues } = normalizeOutline(s);
    expect(sections.map((x) => [x.id, x.docId])).toEqual([
      ['c1', 'd2'],
      ['c1~2', 'd3'],
    ]);
    expect(sections[1]!.title).toBe('other');
    expect(issues.filter((i) => i.problem === 'duplicate-id')).toHaveLength(2);
    expect(normalizeOutline(sections).issues).toEqual([]);
  });

  it('breaks a longer cycle at one node and keeps its subtree', () => {
    const s = [sec('c', 'chapter', 'p'), sec('x', 'chapter', 'c'), sec('p', 'part', 'x')];
    const { issues } = normalizeOutline(s);
    expect(issues.map((i) => [i.id, i.problem])).toEqual([
      ['c', 'parent-cycle'],
      ['x', 'invalid-nesting'],
      ['p', 'invalid-nesting'],
    ]);
    const tree = buildOutline(s);
    expect(tree.map((n) => n.id)).toEqual(['c', 'x', 'p']);
  });

  it('legacy scene rows become sibling chapters under the same part', () => {
    const legacy = [
      sec('p', 'part'),
      sec('c', 'chapter', 'p'),
      { ...sec('s', 'chapter', 'c', 'Scene 1'), kind: 'scene' as never },
    ];
    const { sections } = normalizeOutline(legacy as Section[]);
    expect(sections.find((x) => x.id === 's')!.kind).toBe('chapter');
    expect(sections.find((x) => x.id === 's')!.parentId).toBe('p');
  });

  it('caps titles by grapheme and strips bidi and zero-width characters', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const capped = cleanTitle(family.repeat(250));
    expect(titleLength(capped)).toBe(MAX_TITLE_LENGTH);
    expect(capped).toBe(family.repeat(MAX_TITLE_LENGTH));
    expect(titleLength(cleanTitle('e\u0301'.repeat(300)))).toBe(MAX_TITLE_LENGTH);
    expect(cleanTitle('a\u202Eb\u2066c\u200Bd\uFEFFe\u200Ff')).toBe('abcdef');
  });

  it('treats a title of only zero-width joiners as empty', () => {
    expect(cleanTitle('\u200D\u200C \u200D')).toBe('');
    const renamed = renameSection(sample(), 'c1', '\u200D\u200D');
    expect(renamed.find((x) => x.id === 'c1')!.title).toBe(
      sample().find((x) => x.id === 'c1')!.title,
    );
  });

  it('dropSection refuses to move a section into its own subtree', () => {
    const s = [sec('p', 'part'), sec('c', 'chapter', 'p'), sec('x', 'chapter', 'p')];
    expect(dropSection(s, 'p', { parentId: 'c' })).toEqual(s);
    expect(dropSection(s, 'c', { beforeId: 'x' })).toEqual(s);
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
      'c3',
      'p2',
      'b',
    ]);
    expect(canPromoteChildren(sample(), 'c1')).toBe(true);
    const promoted = deleteSection(sample(), 'c1', { children: 'promote' });
    expect(promoted.find((x) => x.id === 'c2')!.parentId).toBe('p1');
    const out = deleteSection(sample(), 'p1', { children: 'promote' });
    expect(out.find((x) => x.id === 'c1')!.parentId).toBeUndefined();
    expect(() => deleteSection(sample(), 'nope', { children: 'delete' })).toThrow();
  });

  it('lists valid parents for a non-drag move', () => {
    expect(validParents(sample(), 'c1').map((p) => p?.id)).toEqual([undefined, 'p1', 'p2']);
    expect(validParents(sample(), 'p1').map((p) => p?.id)).toEqual([undefined]);
  });

  it('applies edits all-or-nothing', () => {
    const s = sample();
    const bad = applyOutlineEdit(s, (x) => [...x, sec('s9', 'chapter', 'c1')]);
    expect(bad.ok).toBe(false);
    expect(bad.sections).toEqual(s);
    const good = applyOutlineEdit(s, (x) => renameSection(x, 'c1', 'New'));
    expect(good.ok && good.sections.find((x) => x.id === 'c1')!.title).toBe('New');
  });

  it('rejects a duplicate id on add', () => {
    expect(() =>
      addSection(sample(), { manuscriptId: 'm1', id: 'c1', kind: 'chapter', title: 'x' }),
    ).toThrow(/duplicate id/);
  });
});
