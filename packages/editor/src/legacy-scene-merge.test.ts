import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importDocx } from '@swarmdraft/docx';
import type { BlockNode, DocNode, Section } from '@swarmdraft/schema';
import { coalesceLegacySceneSections, docWordCount } from './legacy-scene-merge';

const MOCK = resolve(process.cwd(), '../../fixtures/manuscripts/docx-import/mock-manuscript.docx');

function splitChapterAtSceneBreaks(
  chapter: Section,
  doc: DocNode,
): { chapter: Section; chapterDoc: DocNode; scenes: { section: Section; doc: DocNode }[] } {
  const blocks = doc.content;
  const heading = blocks[0]?.type === 'heading' ? blocks[0] : undefined;
  const rest = heading ? blocks.slice(1) : blocks;
  const segments: BlockNode[][] = [];
  let cur: BlockNode[] = [];
  for (const b of rest) {
    if (b.type === 'scene_break' && cur.length) {
      segments.push(cur);
      cur = [];
      continue;
    }
    if (b.type === 'scene_break') continue;
    cur.push(b);
  }
  if (cur.length) segments.push(cur);
  if (!segments.length) {
    return {
      chapter,
      chapterDoc: { type: 'doc', content: heading ? [heading] : [] },
      scenes: [],
    };
  }
  const scenes = segments.map((seg, i) => {
    const id = `${chapter.id}-sc${i + 1}`;
    return {
      section: {
        id,
        kind: 'chapter' as const,
        title: `Scene ${i + 1}`,
        parentId: chapter.parentId,
        docId: `${chapter.docId}-${id}`,
      },
      doc: { type: 'doc' as const, content: seg },
    };
  });
  const chapterDoc: DocNode = {
    type: 'doc',
    content: heading ? [heading] : scenes.length ? [] : segments[0]!,
  };
  return { chapter, chapterDoc, scenes };
}

function legacyFromMock(): {
  sections: Section[];
  docs: Map<string, DocNode>;
  totals: Map<string, number>;
} {
  const imported = importDocx(readFileSync(MOCK), { manuscriptId: 'm1' });
  const sections: Section[] = [];
  const docs = new Map<string, DocNode>();
  const totals = new Map<string, number>();
  for (const s of imported.sections) {
    totals.set(s.id, docWordCount(s.content));
    if (s.kind !== 'chapter' || !s.content.content.some((b) => b.type === 'scene_break')) {
      sections.push({
        id: s.id,
        kind: s.kind,
        title: s.title,
        docId: s.docId,
        ...(s.parentId ? { parentId: s.parentId } : {}),
      });
      docs.set(s.docId, s.content);
      continue;
    }
    const split = splitChapterAtSceneBreaks(
      {
        id: s.id,
        kind: s.kind,
        title: s.title,
        docId: s.docId,
        ...(s.parentId ? { parentId: s.parentId } : {}),
      },
      s.content,
    );
    sections.push(split.chapter);
    docs.set(split.chapter.docId, split.chapterDoc);
    for (const sc of split.scenes) {
      sections.push(sc.section);
      docs.set(sc.section.docId, sc.doc);
    }
  }
  return { sections, docs, totals };
}

describe('coalesceLegacySceneSections (#131)', () => {
  it('merges split mock chapters so word counts match the imported manuscript', () => {
    const { sections, docs, totals } = legacyFromMock();
    const beforeBook = [...docs.values()].reduce((n, d) => n + docWordCount(d), 0);
    const merged = coalesceLegacySceneSections(sections, docs);
    expect(merged.changed).toBe(true);
    expect(merged.sections.filter((s) => (s.kind as string) === 'scene')).toHaveLength(0);
    for (const s of merged.sections.filter((x) => x.kind === 'chapter')) {
      const doc = merged.docs.get(s.docId);
      expect(doc, s.title).toBeTruthy();
      expect(docWordCount(doc!), s.title).toBeGreaterThan(0);
      if (totals.has(s.id)) {
        expect(docWordCount(doc!), s.title).toBe(totals.get(s.id));
      }
    }
    const afterBook = [...merged.docs.values()].reduce((n, d) => n + docWordCount(d), 0);
    expect(afterBook).toBe(beforeBook);
    const imported = importDocx(readFileSync(MOCK), { manuscriptId: 'm1' });
    const importedBook = imported.sections.reduce((n, s) => n + docWordCount(s.content), 0);
    expect(afterBook).toBe(importedBook);
  });

  it('merges nested scene rows into the parent chapter doc', () => {
    const chapter: Section = {
      id: 'c1',
      kind: 'chapter',
      title: 'Chapter 1',
      docId: 'd1',
      parentId: 'p1',
    };
    const scene: Section = {
      id: 's1',
      kind: 'scene' as never,
      title: 'Scene 1',
      docId: 'd2',
      parentId: 'c1',
    };
    const docs = new Map<string, DocNode>([
      [
        'd1',
        {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Ch' }] },
          ],
        },
      ],
      [
        'd2',
        {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: { style: 'body' },
              content: [{ type: 'text', text: 'Body text here.' }],
            },
          ],
        },
      ],
    ]);
    const out = coalesceLegacySceneSections([chapter, scene], docs);
    expect(out.sections.map((s) => s.id)).toEqual(['c1']);
    expect(out.docs.get('d1')!.content.some((b) => b.type === 'paragraph')).toBe(true);
    expect(docWordCount(out.docs.get('d1')!)).toBe(4);
  });
});
