// Lives under review/ because the trusted accept needs @coauthor/editor/trusted.
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import type { Editor } from '@tiptap/core';
import { docToYDoc, markKey } from '@coauthor/docx';
import { allowReviewEdits } from '@coauthor/editor/trusted';
import ManuscriptEditor from '../ManuscriptEditor.vue';

describe('ManuscriptEditor bound to a Y.Doc', () => {
  const by = { author: 'agent:test', ts: '2026-10-25T00:00:00Z' };
  const start = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Plain ' },
          {
            type: 'text',
            text: 'new',
            marks: [{ type: 'suggestion_insert', attrs: { id: 's1', ...by } }],
          },
          { type: 'text', text: ' end' },
        ],
      },
    ],
  };
  const sync = (a: Y.Doc, b: Y.Doc) => {
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  };
  const textOf = (d: Y.Doc) =>
    (d.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const editorOf = (w: ReturnType<typeof mount>) =>
    (w.find('.tiptap').element as unknown as { editor: Editor }).editor;

  it("shows other writers' changes in a second mounted editor's view", async () => {
    const docA = docToYDoc(start as never);
    const docB = new Y.Doc();
    sync(docA, docB);
    // Each doc relays its own changes to the other, as a provider would.
    docA.on(
      'update',
      (u: Uint8Array, o: unknown) => o !== 'relay' && Y.applyUpdate(docB, u, 'relay'),
    );
    docB.on(
      'update',
      (u: Uint8Array, o: unknown) => o !== 'relay' && Y.applyUpdate(docA, u, 'relay'),
    );
    const a = mount(ManuscriptEditor, { props: { doc: docA }, attachTo: document.body });
    const b = mount(ManuscriptEditor, { props: { doc: docB }, attachTo: document.body });
    await flushPromises();
    const viewB = () => b.find('.tiptap');

    // (a) a peer text insert
    const peer = new Y.Doc();
    sync(peer, docA);
    textOf(peer).insert(0, 'A ');
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(peer));
    await flushPromises();
    expect(viewB().text()).toBe('A Plain new end');

    // (b) a trusted accept of s1 in editor A (drop the mark, keep the text)
    const ea = editorOf(a);
    let from = -1;
    ea.state.doc.descendants((n, pos) => {
      if (n.marks.some((m) => m.attrs.id === 's1')) from = pos;
    });
    const type = ea.schema.marks.suggestion_insert!;
    ea.view.dispatch(allowReviewEdits(ea.state.tr.removeMark(from, from + 3, type)));
    await flushPromises();
    expect(viewB().find('ins.suggestion-insert').exists()).toBe(false);
    expect(viewB().text()).toBe('A Plain new end');

    // (c) a raw third-client suggestion_insert s7
    const third = new Y.Doc();
    sync(third, docB);
    const mark = { type: 'suggestion_insert', attrs: { id: 's7', ...by } };
    textOf(third).insert(textOf(third).length, ' more', { [markKey(mark)]: mark.attrs });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(third));
    await flushPromises();
    expect(viewB().find('ins.suggestion-insert').text()).toBe('more');
    expect(a.find('.tiptap ins.suggestion-insert').text()).toBe('more');
    a.unmount();
    b.unmount();
  });
});
