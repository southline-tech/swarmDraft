/** #380: text typed into a chapter created by a split survives save and reload. */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docToYDoc, yDocToDoc } from '@swarmdraft/docx';
import type { BlockNode, DocNode, Section } from '@swarmdraft/schema';
import type { StoredManuscript, StoredSection } from '../backend';
import { sessionFromStored, type ManuscriptSession } from '../manuscript-session';
import { applyChapterSplit } from './chapter-ops';
import { runChapterBreakBatch, scanSessionBreaks } from './chapter-app-handlers';

function para(text: string): BlockNode {
  return {
    type: 'paragraph',
    attrs: { style: 'body' },
    content: text ? [{ type: 'text', text }] : [],
  };
}

function chapterState(blocks: BlockNode[]): number[] {
  const node: DocNode = { type: 'doc', content: blocks };
  return Array.from(Y.encodeStateAsUpdate(docToYDoc(node)));
}

function storedChapter(): StoredManuscript {
  return {
    manuscript: {
      id: 'm',
      title: 'A test manuscript',
      createdAt: '',
      numberingStyle: 'chapter_arabic',
    },
    sections: [
      {
        id: 'c1',
        manuscriptId: 'm',
        kind: 'chapter',
        parentId: null,
        position: 0,
        title: 'One',
        docId: 'manuscript/m/section/c1',
        state: chapterState([para('alpha'), para('beta')]),
      },
    ],
  };
}

/** Section rows plus accepted Yjs updates, the same shape SQLite stores. */
function memoryStore(stored: StoredManuscript) {
  const rows = new Map(stored.sections.map((row) => [row.id, { ...row }]));
  const updates = new Map(stored.sections.map((row) => [row.id, [Uint8Array.from(row.state)]]));
  let order = stored.sections.map((row) => row.id);
  return {
    persist: {
      save: async (id: string, update: Uint8Array) => {
        if (!rows.has(id)) throw new Error(`section ${id} not found`);
        updates.get(id)!.push(update);
      },
    },
    saveOutline: async (next: Section[]) => {
      for (const [index, row] of next.entries()) {
        if (!updates.has(row.id)) updates.set(row.id, []);
        const prev = rows.get(row.id);
        rows.set(row.id, {
          id: row.id,
          manuscriptId: stored.manuscript.id,
          kind: row.kind,
          parentId: row.parentId ?? null,
          position: index,
          title: row.title,
          docId: row.docId,
          state: prev?.state ?? [],
        });
      }
      const keep = new Set(next.map((row) => row.id));
      for (const id of [...rows.keys()]) if (!keep.has(id)) rows.delete(id);
      order = next.map((row) => row.id);
    },
    reload: (): StoredManuscript => ({
      manuscript: stored.manuscript,
      sections: order.map((id, index) => {
        const doc = new Y.Doc();
        for (const update of updates.get(id) ?? []) Y.applyUpdate(doc, update);
        const row = rows.get(id)!;
        return {
          ...row,
          position: index,
          state: Array.from(Y.encodeStateAsUpdate(doc)),
        } satisfies StoredSection;
      }),
    }),
  };
}

function plain(doc: Y.Doc | undefined): string {
  if (!doc) return '';
  return JSON.stringify(yDocToDoc(doc));
}

function appendParagraph(doc: Y.Doc, text: string) {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('prosemirror').insert(doc.getXmlFragment('prosemirror').length, [p]);
}

async function reopen(session: ManuscriptSession, store: ReturnType<typeof memoryStore>) {
  await session.flush();
  await session.close();
  return sessionFromStored(store.reload(), null);
}

describe('split chapter text survives save and reload (#380)', () => {
  it('keeps text typed into a chapter split by hand', async () => {
    const store = memoryStore(storedChapter());
    const session = sessionFromStored(store.reload(), null, store.persist, store.saveOutline);
    await applyChapterSplit(session, 'm', 'c1', 1, 'Chapter Two', false);
    const created = session.outline.value.find((row) => row.id !== 'c1');
    expect(created?.title).toBe('Chapter Two');
    appendParagraph(session.sections.get(created!.docId)!, 'gamma');

    const again = await reopen(session, store);
    const source = again.outline.value.find((row) => row.id === 'c1')!;
    const next = again.outline.value.find((row) => row.id === created!.id)!;
    expect(plain(again.sections.get(source.docId))).toContain('alpha');
    expect(plain(again.sections.get(source.docId))).not.toContain('beta');
    expect(plain(again.sections.get(next.docId))).toContain('beta');
    expect(plain(again.sections.get(next.docId))).toContain('gamma');
    await again.close();
  });

  it('keeps text typed into a chapter created by Split selected', async () => {
    const blocks = [para('alpha'), para('Chapter Two'), para('beta')];
    const stored = storedChapter();
    stored.sections[0]!.state = chapterState(blocks);
    const store = memoryStore(stored);
    const session = sessionFromStored(store.reload(), null, store.persist, store.saveOutline);
    const rows = scanSessionBreaks(session);
    expect(rows.map((row) => row.title)).toEqual(['Chapter Two']);
    const result = await runChapterBreakBatch(session, 'm', rows, 'c1');
    const createdId = result.firstNewChapterId;
    expect(createdId).toBeTruthy();
    const created = session.outline.value.find((row) => row.id === createdId)!;
    appendParagraph(session.sections.get(created.docId)!, 'gamma');

    const again = await reopen(session, store);
    const next = again.outline.value.find((row) => row.id === createdId)!;
    const body = plain(again.sections.get(next.docId));
    expect(body).toContain('beta');
    expect(body).toContain('gamma');
    await again.close();
  });
});
