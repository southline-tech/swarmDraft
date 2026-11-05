import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docToYDoc, writeStructure, yDocToDoc } from '@swarmdraft/docx';
import { addSection } from '@swarmdraft/editor';
import { openSession } from '../manuscript-session';
import { applyChapterSplit, captureChapterSnapshot, restoreChapterSnapshot } from './chapter-ops';

describe('chapter split wiring (#304)', () => {
  it('split then undo restores outline and text', async () => {
    let outline = addSection([], { manuscriptId: 'm', kind: 'chapter', title: 'One', id: 'c1' });
    const manuscript = new Y.Doc();
    writeStructure(
      manuscript,
      outline.map((s) => ({ ...s, docId: `manuscript/m/section/${s.id}` })),
    );
    outline = outline.map((s) => ({ ...s, docId: `manuscript/m/section/${s.id}` }));
    const doc = docToYDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'B' }] },
      ],
    });
    const sections = new Map([[outline[0]!.docId, doc]]);
    const session = openSession('m', 'T', manuscript, sections, null);
    const snap = captureChapterSnapshot(session, 'c1');
    await applyChapterSplit(session, 'm', 'c1', 1, 'Part B', false);
    expect(session.outline.value).toHaveLength(2);
    await restoreChapterSnapshot(session, snap);
    expect(session.outline.value).toHaveLength(1);
    expect(JSON.stringify(yDocToDoc(doc))).toContain('B');
  });
});
