import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docToYDoc, writeStructure, yDocToDoc } from '@swarmdraft/docx';
import { addSection } from '@swarmdraft/editor';
import type { BlockNode, DocNode } from '@swarmdraft/schema';
import { openSession, type ManuscriptSession } from '../manuscript-session';
import { addNote, createNotesDoc, listNotes } from '../notes/doc';
import {
  chapterBreakToastMessage,
  runChapterBreakBatch,
  scanSessionBreaks,
  undoChapterToast,
  type FindBreakRow,
} from './chapter-app-handlers';

function para(text: string): BlockNode {
  return {
    type: 'paragraph',
    attrs: { style: 'body' },
    content: text ? [{ type: 'text', text }] : [],
  };
}

function docOf(blocks: BlockNode[]): DocNode {
  return { type: 'doc', content: blocks };
}

async function sessionWith(blocks: BlockNode[]) {
  let outline = addSection([], { manuscriptId: 'm', kind: 'chapter', title: 'One', id: 'c1' });
  const manuscript = new Y.Doc();
  writeStructure(
    manuscript,
    outline.map((s) => ({ ...s, docId: `manuscript/m/section/${s.id}` })),
  );
  outline = outline.map((s) => ({ ...s, docId: `manuscript/m/section/${s.id}` }));
  const doc = docToYDoc(docOf(blocks));
  const sections = new Map([[outline[0]!.docId, doc]]);
  const session = openSession('m', 'A test manuscript', manuscript, sections, null);
  return session;
}

function texts(session: ManuscriptSession) {
  return session.outline.value.map((s) => ({
    id: s.id,
    title: s.title,
    text: JSON.stringify(yDocToDoc(session.sections.get(s.docId)!)),
  }));
}

describe('chapter break batch (#305)', () => {
  it('splits selected breaks through the chapter split and undoes them in one step', async () => {
    const session = await sessionWith([
      para('Opening line.'),
      para('Chapter Two'),
      para('A quiet morning on the road.'),
      para('Chapter Three'),
      para('Later the rain started.'),
    ]);
    const rows = scanSessionBreaks(session);
    expect(rows.map((row) => row.title)).toEqual(['Chapter Two', 'Chapter Three']);
    expect(rows.every((row) => row.selected && row.removeLine)).toBe(true);

    const notes = createNotesDoc();
    addNote(notes, { kind: 'human', id: 'you', name: 'You' }, 'A note', { sectionIds: ['c1'] });
    const result = await runChapterBreakBatch(session, 'm', rows, 'c1', notes);

    expect(result.toast?.message).toBe('Split into 2 chapters');
    expect(result.skippedKeys).toEqual([]);
    expect(session.outline.value.map((s) => s.id)[0]).toBe('c1');
    expect(session.outline.value).toHaveLength(3);
    expect(new Set(session.outline.value.map((s) => s.id)).size).toBe(3);
    expect(result.firstNewChapterId).toBe(session.outline.value[1]?.id);
    const bodies = texts(session);
    expect(bodies[0]?.text).toContain('Opening line.');
    expect(bodies[0]?.text).not.toContain('Chapter Two');
    expect(bodies[1]?.title).toBe('Chapter Two');
    expect(bodies[1]?.text).toContain('A quiet morning on the road.');
    expect(bodies[2]?.title).toBe('Chapter Three');
    expect(bodies[2]?.text).toContain('Later the rain started.');
    const noteIds = listNotes(notes)[0]?.sectionIds ?? [];
    expect(noteIds).toEqual(expect.arrayContaining(['c1', bodies[1]!.id, bodies[2]!.id]));
    expect(result.toast?.detail).toBe('Notes linked to all of these chapters');

    const restored = await undoChapterToast(session, result.toast!, notes);
    expect(restored).toBe('c1');
    expect(session.outline.value).toHaveLength(1);
    expect(session.outline.value[0]?.id).toBe('c1');
    expect(texts(session)[0]?.text).toContain('Chapter Two');
    expect(texts(session)[0]?.text).toContain('Chapter Three');
    expect(listNotes(notes)[0]?.sectionIds).toEqual(['c1']);
  });

  it('uses the single-chapter toast when one break is selected', async () => {
    const session = await sessionWith([para('Opening line.'), para('Chapter Two'), para('After.')]);
    const notes = createNotesDoc();
    addNote(notes, { kind: 'human', id: 'you', name: 'You' }, 'A note', { sectionIds: ['c1'] });
    const rows = scanSessionBreaks(session).map((row, i) => ({ ...row, selected: i === 0 }));
    const result = await runChapterBreakBatch(session, 'm', rows, 'c1', notes);
    expect(result.toast?.message).toBe(chapterBreakToastMessage(['Chapter Two']));
    expect(result.toast?.detail).toBe('Notes linked to both chapters');
    expect(session.outline.value).toHaveLength(2);
    expect(listNotes(notes)[0]?.sectionIds).toHaveLength(2);
  });

  it('skips a blocked break and still splits the others', async () => {
    const session = await sessionWith([
      para('Opening line.'),
      para('Chapter Two'),
      para('Between.'),
      {
        type: 'paragraph',
        attrs: { style: 'body' },
        content: [
          {
            type: 'text',
            text: 'Chapter Three',
            marks: [{ type: 'suggestion_insert', attrs: { id: 's1', author: 'a', ts: '1' } }],
          },
        ],
      },
      para('After.'),
    ]);
    const rows = scanSessionBreaks(session);
    expect(rows.map((row) => row.title)).toEqual(['Chapter Two', 'Chapter Three']);
    const result = await runChapterBreakBatch(session, 'm', rows, 'c1');
    expect(result.appliedKeys).toHaveLength(1);
    expect(result.skippedKeys).toHaveLength(1);
    expect(result.toast?.message).toBe('Split into “Chapter Two”');
    expect(session.outline.value).toHaveLength(2);
    const kept = texts(session)
      .map((row) => row.text)
      .join('\n');
    expect(kept).toContain('Chapter Three');
    const skipped = result.skippedKeys[0]!;
    const loc = result.locations.get(skipped);
    expect(loc?.blockIndex).toBeGreaterThan(0);
  });

  it('leaves the book unchanged when every selected break is blocked', async () => {
    const marked: FindBreakRow = {
      key: 'c1:1',
      chapterId: 'c1',
      blockIndex: 1,
      sourceTitle: 'One',
      title: 'Chapter Two',
      snippet: 'After.',
      selected: true,
      removeLine: true,
    };
    const session = await sessionWith([
      para('Opening line.'),
      {
        type: 'paragraph',
        attrs: { style: 'body' },
        content: [
          {
            type: 'text',
            text: 'Chapter Two',
            marks: [{ type: 'suggestion_insert', attrs: { id: 's1', author: 'a', ts: '1' } }],
          },
        ],
      },
      para('After.'),
    ]);
    const result = await runChapterBreakBatch(session, 'm', [marked], 'c1');
    expect(result.toast).toBeNull();
    expect(result.appliedKeys).toEqual([]);
    expect(result.skippedKeys).toEqual(['c1:1']);
    expect(session.outline.value).toHaveLength(1);
    expect(texts(session)[0]?.text).toContain('Chapter Two');
  });
});
