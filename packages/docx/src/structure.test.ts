import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Section } from '@coauthor/schema';
import {
  STRUCTURE_FIELD,
  importDocx,
  importedToYDocs,
  observeStructure,
  readStructure,
  writeStructure,
  yDocToDoc,
} from './index';

const dir = fileURLToPath(new URL('../../../fixtures/manuscripts/docx-import/', import.meta.url));
const mock = () => importDocx(readFileSync(dir + 'mock-manuscript.docx'), { manuscriptId: 'm1' });

const s = (id: string, kind: Section['kind'], title: string, parentId?: string): Section => ({
  id,
  kind,
  title,
  docId: `doc-${id}`,
  ...(parentId ? { parentId } : {}),
});

describe('manuscript structure', () => {
  it('import writes the real parts and chapters in reading order', () => {
    const m = mock();
    const { manuscript, sections } = importedToYDocs(m);
    const outline = readStructure(manuscript);
    expect(outline.map((x) => [x.id, x.kind, x.title, x.parentId])).toEqual(
      m.sections.map((x) => [x.id, x.kind, x.title, x.parentId]),
    );
    expect(outline.filter((x) => x.kind === 'part').map((x) => x.title)).toEqual([
      'Part One: The Bell That Stopped',
      'Part Two: Salt and Lamplight',
      'Part Three: The Twelfth Boat',
    ]);
    expect(outline.filter((x) => x.kind === 'chapter')).toHaveLength(12);
    expect(manuscript.getMap('meta').get('title')).toBe(m.title);
    for (const sec of m.sections) expect(yDocToDoc(sections.get(sec.docId)!)).toEqual(sec.content);
  });

  it('round-trips through a Yjs update (what persistence and other peers see)', () => {
    const { manuscript } = importedToYDocs(mock());
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(manuscript));
    expect(readStructure(peer)).toEqual(readStructure(manuscript));
  });

  it('rename and reparent update in place; reorder rewrites in one transaction', () => {
    const doc = new Y.Doc();
    writeStructure(doc, [s('p', 'part', 'P'), s('a', 'chapter', 'A', 'p'), s('b', 'chapter', 'B')]);
    const mapA = doc.getArray<Y.Map<unknown>>(STRUCTURE_FIELD).get(1);
    writeStructure(doc, [s('p', 'part', 'P'), s('a', 'chapter', 'A2'), s('b', 'chapter', 'B')]);
    expect(doc.getArray(STRUCTURE_FIELD).get(1)).toBe(mapA);
    expect(readStructure(doc)[1]).toEqual(s('a', 'chapter', 'A2'));

    let calls = 0;
    const off = observeStructure(doc, () => calls++);
    writeStructure(doc, [s('b', 'chapter', 'B'), s('p', 'part', 'P'), s('a', 'chapter', 'A2')]);
    off();
    expect(calls).toBe(1);
    expect(readStructure(doc).map((x) => x.id)).toEqual(['b', 'p', 'a']);
  });

  it('skips malformed refs instead of throwing', () => {
    const doc = new Y.Doc();
    const arr = doc.getArray<unknown>(STRUCTURE_FIELD);
    const bad = new Y.Map<unknown>();
    bad.set('id', 'x');
    bad.set('kind', 'appendix');
    bad.set('docId', 'd');
    const ok = new Y.Map<unknown>();
    ok.set('id', 'c');
    ok.set('kind', 'chapter');
    ok.set('docId', 'doc-c');
    ok.set('title', 7);
    arr.push(['junk', bad, ok]);
    expect(readStructure(doc)).toEqual([{ id: 'c', kind: 'chapter', title: '', docId: 'doc-c' }]);
  });
});
