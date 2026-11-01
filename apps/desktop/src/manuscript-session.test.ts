import { describe, expect, it } from 'vitest';
import { isProxy, reactive } from 'vue';
import * as Y from 'yjs';
import type { Section } from '@swarmdraft/schema';
import { docToYDoc, readStructure, writeStructure, yDocToDoc } from '@swarmdraft/docx';
import { openSession } from './manuscript-session';

const ch = (id: string, title: string, docId: string): Section => ({
  id,
  kind: 'chapter',
  title,
  docId,
});
const report = { warnings: [] } as never;
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
};
function pair(rows: Section[]) {
  const a = new Y.Doc();
  writeStructure(a, rows);
  const b = new Y.Doc();
  sync(a, b);
  return { a, b };
}

describe('openSession repair and concurrent peers', () => {
  it('keeps a concurrent rename when the duplicate-id repair runs', () => {
    const { a, b } = pair([ch('x', 'Keep', 'dx'), ch('c', 'C1', 'd1'), ch('c', 'C2', 'd2')]);
    writeStructure(
      b,
      readStructure(b).map((s) => (s.id === 'x' ? { ...s, title: 'Renamed' } : s)),
    );
    const session = openSession('m', 'M', a, new Map(), report);
    expect(session.repairs.map((r) => r.problem)).toContain('duplicate-id');
    sync(a, b);
    for (const doc of [a, b])
      expect(readStructure(doc).map((s) => [s.id, s.title, s.docId])).toEqual([
        ['x', 'Renamed', 'dx'],
        ['c', 'C1', 'd1'],
        ['c~2', 'C2', 'd2'],
      ]);
    expect(session.outline.value.find((s) => s.id === 'x')?.title).toBe('Renamed');
    session.close();
  });

  it('two clients repairing at once converge on one row per section', () => {
    const { a, b } = pair([ch('c', 'C1', 'd1'), ch('c', 'C2', 'd2')]);
    const sa = openSession('m', 'M', a, new Map(), report);
    const sb = openSession('m', 'M', b, new Map(), report);
    sync(a, b);
    for (const s of [sa, sb]) {
      expect(readStructure(s.manuscript).map((x) => x.id)).toEqual(['c', 'c~2']);
      expect(s.outline.value.map((x) => x.id)).toEqual(['c', 'c~2']);
      s.close();
    }
  });

  it('the observer shows each section once if merged rows repeat (c, c~2, c, c~2)', () => {
    const a = new Y.Doc();
    writeStructure(a, [ch('c', 'C1', 'd1'), ch('c~2', 'C2', 'd2')]);
    const session = openSession('m', 'M', a, new Map(), report);
    const peer = new Y.Doc();
    writeStructure(peer, [ch('c', 'C1', 'd1'), ch('c~2', 'C2', 'd2')]);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(peer));
    expect(readStructure(a).map((s) => s.id)).toEqual(['c', 'c~2', 'c', 'c~2']);
    expect(session.outline.value.map((s) => [s.id, s.docId])).toEqual([
      ['c', 'd1'],
      ['c~2', 'd2'],
    ]);
    session.close();
  });
});

describe('openSession keeps Y.Docs raw', () => {
  it('marks the manuscript and section docs raw so reactive() never proxies them', () => {
    const a = new Y.Doc();
    const d1 = new Y.Doc();
    writeStructure(a, [ch('c', 'C1', 'd1')]);
    const s = openSession('m', 'M', a, new Map([['d1', d1]]), report);
    const r = reactive({ m: s.manuscript, d: s.sections.get('d1')! });
    expect(isProxy(r.m)).toBe(false);
    expect(isProxy(r.d)).toBe(false);
    s.close();
  });
});

describe('outline undo delete', () => {
  it('rehydrates section doc content when a removed docId returns to the outline', async () => {
    const a = new Y.Doc();
    const d1 = docToYDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Undo keep' }] }],
    } as never);
    writeStructure(a, [ch('c', 'C1', 'd1')]);
    const session = openSession('m', 'M', a, new Map([['d1', d1]]), report);
    await session.save([]);
    expect(session.sections.has('d1')).toBe(false);
    await session.save([ch('c', 'C1', 'd1')]);
    const restored = session.sections.get('d1')!;
    expect(JSON.stringify(yDocToDoc(restored))).toContain('Undo keep');
    session.close();
  });
});
