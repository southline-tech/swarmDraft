import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import { docToYDoc, yDocToDoc } from '@coauthor/docx';
import type { DocNode } from '@coauthor/schema';
import {
  MemoryDocBackend,
  SectionDocs,
  SectionPersistence,
  collaborativeEditorOptions,
  collectReviewItems,
} from './index';

// Synthetic sample text only.
const by = { author: 'agent:grok', ts: '2026-10-25T00:00:00Z' };
const SECTION: DocNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
    {
      type: 'paragraph',
      attrs: { style: 'first' },
      content: [
        { type: 'text', text: 'The kettle ' },
        {
          type: 'text',
          marks: [
            { type: 'comment_anchor', attrs: { id: 'c1' } },
            { type: 'comment_anchor', attrs: { id: 'c2' } },
          ],
          text: 'sang',
        },
        { type: 'text', text: ' ' },
        {
          type: 'text',
          marks: [{ type: 'suggestion_delete', attrs: { id: 's1', ...by } }],
          text: 'loudly',
        },
        {
          type: 'text',
          marks: [{ type: 'suggestion_insert', attrs: { id: 's1', ...by } }],
          text: 'low',
        },
        { type: 'text', text: '.' },
      ],
    },
  ],
};

const seed = (backend: MemoryDocBackend, docId: string, content: DocNode) =>
  backend.append(docId, Y.encodeStateAsUpdate(docToYDoc(content)));

let editors: Editor[] = [];
afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors = [];
  vi.useRealTimers();
});
/** Mount an editor on `doc`; the Yjs binding renders on the next tick. */
const bind = async (doc: Y.Doc) => {
  const e = new Editor(collaborativeEditorOptions(doc, { element: document.createElement('div') }));
  editors.push(e);
  await new Promise((r) => setTimeout(r, 0));
  return e;
};

describe('per-section Yjs persistence', () => {
  it('loads a stored section into the editor with overlapping review marks intact', async () => {
    const backend = new MemoryDocBackend();
    await seed(backend, 'd1', SECTION);
    const docs = new SectionDocs(backend);
    const p = await docs.open('d1');
    const editor = await bind(p.doc);
    expect(editor.getJSON()).toEqual(SECTION);
    expect(
      collectReviewItems(editor.state.doc)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['c1', 'c2', 's1', 's1'].sort());
    expect(p.status).toBe('saved');
  });

  it('autosaves typing after the debounce, as one batched update, and survives reopen', async () => {
    const backend = new MemoryDocBackend();
    await seed(backend, 'd1', SECTION);
    const p = await new SectionDocs(backend, { debounceMs: 30 }).open('d1');
    const editor = await bind(p.doc);
    editor.commands.setTextSelection(3);
    for (const ch of 'xyz') editor.commands.insertContent(ch);
    expect(p.status).toBe('pending');
    expect(backend.logs.get('d1')).toHaveLength(1);
    await vi.waitFor(() => expect(p.status).toBe('saved'));
    expect(backend.logs.get('d1')).toHaveLength(2);

    // "Restart": a fresh SectionDocs over the same store sees the edit.
    const again = await new SectionDocs(backend).open('d1');
    expect((await bind(again.doc)).getJSON()).toEqual(editor.getJSON());
  });

  it('saves within maxWait even while typing continues', async () => {
    vi.useFakeTimers();
    const backend = new MemoryDocBackend();
    const p = new SectionPersistence('d1', new Y.Doc(), backend, {
      debounceMs: 400,
      maxWaitMs: 1000,
    });
    await p.load();
    const t = p.doc.getText('t');
    for (let i = 0; i < 10; i++) {
      t.insert(t.length, 'a');
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(backend.logs.get('d1')?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('keeps edits through a failed save and retries', async () => {
    vi.useFakeTimers();
    const backend = new MemoryDocBackend();
    backend.failNext = 1;
    const statuses: string[] = [];
    const p = new SectionPersistence('d1', new Y.Doc(), backend, {
      debounceMs: 10,
      retryMs: 100,
      onStatus: (s) => statuses.push(s),
    });
    await p.load();
    p.doc.getText('t').insert(0, 'kept');
    await vi.advanceTimersByTimeAsync(10);
    expect(p.status).toBe('error');
    expect(p.hasUnsavedChanges).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(p.status).toBe('saved');
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, await backend.diff('d1', new Uint8Array()));
    expect(reloaded.getText('t').toString()).toBe('kept');
    expect(statuses).toContain('error');
  });

  it('flushes pending edits on destroy (closing a section)', async () => {
    vi.useFakeTimers();
    const backend = new MemoryDocBackend();
    const docs = new SectionDocs(backend, { debounceMs: 10_000 });
    const p = await docs.open('d1');
    p.doc.getText('t').insert(0, 'bye');
    await docs.closeAll();
    expect(backend.logs.get('d1')).toHaveLength(1);
  });

  it('pull() brings in an agent suggestion written to the store, past the review guard', async () => {
    const backend = new MemoryDocBackend();
    await seed(backend, 'd1', SECTION);
    const p = await new SectionDocs(backend).open('d1');
    const editor = await bind(p.doc);

    // The MCP server edits the stored doc on its own copy.
    const server = new Y.Doc();
    Y.applyUpdate(server, await backend.diff('d1', new Uint8Array()));
    const sv = Y.encodeStateVector(server);
    const withComment = yDocToDoc(server);
    const para = withComment.content[1] as Extract<
      DocNode['content'][number],
      { type: 'paragraph' }
    >;
    para.content = [
      ...(para.content ?? []),
      { type: 'text', marks: [{ type: 'comment_anchor', attrs: { id: 'c3' } }], text: ' Again.' },
    ];
    const fresh = docToYDoc(withComment);
    // Apply as a structural change on the server doc.
    const frag = server.getXmlFragment('prosemirror');
    server.transact(() => {
      frag.delete(0, frag.length);
      const src = fresh.getXmlFragment('prosemirror');
      frag.insert(
        0,
        src.toArray().map((n) => n.clone() as Y.XmlElement),
      );
    });
    await backend.append('d1', Y.encodeStateAsUpdate(server, sv));

    await p.pull();
    expect(collectReviewItems(editor.state.doc).map((r) => r.id)).toContain('c3');
  });

  it('opens each section once, with its own Y.Doc', async () => {
    const docs = new SectionDocs(new MemoryDocBackend());
    const [a, a2, b] = await Promise.all([docs.open('a'), docs.open('a'), docs.open('b')]);
    expect(a).toBe(a2);
    expect(a.doc).not.toBe(b.doc);
  });
});
