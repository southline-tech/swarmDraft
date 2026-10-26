import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { docToYDoc, importDocx, markKey, rekeyMarks, yDocToDoc } from '@coauthor/docx';
import {
  collectReviewItems,
  checkYDocContent,
  collaborativeEditorOptions,
  contentErrorOf,
  manuscriptExtensions,
} from './index';

// Regression: review-mark Yjs keys must be parseable by y-prosemirror, or the bound editor
// renders an empty document. Synthetic fixture only.
const file = resolve(process.cwd(), '../../fixtures/manuscripts/docx-import/mock-manuscript.docx');

const ids = (items: { type: string; id: string }[]) => items.map((r) => `${r.type}:${r.id}`).sort();

describe('editor bound to a Y.Doc via y-prosemirror', () => {
  it('renders the imported mock manuscript with comments and suggestions intact', async () => {
    const m = importDocx(readFileSync(file), { manuscriptId: 'm1' });
    let expected: string[] = [];
    let got: string[] = [];
    let textLen = 0;
    for (const s of m.sections.filter((x) => x.content.content.length)) {
      const plain = new Editor({ extensions: manuscriptExtensions(), content: s.content });
      expected = expected.concat(ids(collectReviewItems(plain.state.doc)));
      plain.destroy();

      const doc = docToYDoc(s.content);
      expect(checkYDocContent(doc)).toBeUndefined();
      let writes = 0;
      doc.on('update', () => writes++);
      const editor = new Editor(
        collaborativeEditorOptions(doc, { element: document.createElement('div') }),
      );
      await new Promise((r) => setTimeout(r, 0));
      textLen += editor.getText().trim().length;
      expect(contentErrorOf(editor)).toBeUndefined();
      expect(editor.getJSON()).toEqual(s.content);
      expect(writes).toBe(0);
      got = got.concat(ids(collectReviewItems(editor.state.doc)));
      editor.destroy();
    }
    expect(textLen).toBeGreaterThan(0);
    expect(expected.length).toBeGreaterThan(0);
    expect(got.sort()).toEqual(expected.sort());
  });

  it('loads a legacy type--id doc after rekeyMarks', async () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { style: 'body' },
          content: [
            {
              type: 'text',
              text: 'noted',
              marks: [{ type: 'comment_anchor', attrs: { id: 'c1' } }],
            },
          ],
        },
      ],
    };
    const doc = docToYDoc(content as never);
    // Rewrite to the pre-fix `type--id` key.
    const t = (doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    t.format(0, 5, {
      [markKey({ type: 'comment_anchor', attrs: { id: 'c1' } })]: null,
      'comment_anchor--c1': { id: 'c1' },
    });
    expect(checkYDocContent(doc)).toBeDefined();
    expect(rekeyMarks(doc)).toBe(1);
    expect(checkYDocContent(doc)).toBeUndefined();
    const editor = new Editor(
      collaborativeEditorOptions(doc, { element: document.createElement('div') }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(ids(collectReviewItems(editor.state.doc))).toEqual(['comment_anchor:c1']);
    editor.destroy();
  });

  const commented = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { style: 'body' },
        content: [
          { type: 'text', text: 'plain ' },
          {
            type: 'text',
            text: 'noted',
            marks: [{ type: 'comment_anchor', attrs: { id: 'c1' } }],
          },
        ],
      },
    ],
  };
  const keysOf = (doc: Y.Doc) =>
    ((doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText)
      .toDelta()
      .flatMap((d: { attributes?: object }) => Object.keys(d.attributes ?? {}));
  const reviewIdsInY = (doc: Y.Doc) => {
    const out = new Set<string>();
    const walk = (n: {
      marks?: { type: string; attrs?: { id?: unknown } }[];
      content?: unknown[];
    }) => {
      for (const m of n.marks ?? [])
        if (m.attrs?.id !== undefined) out.add(`${m.type}:${m.attrs.id}`);
      for (const c of n.content ?? []) walk(c as never);
    };
    walk(yDocToDoc(doc) as never);
    return [...out];
  };

  it('still finds comments by attrs.id after the binding re-keys them on edit', async () => {
    const doc = docToYDoc(commented as never);
    const before = keysOf(doc);
    const editor = new Editor(
      collaborativeEditorOptions(doc, { element: document.createElement('div') }),
    );
    await new Promise((r) => setTimeout(r, 0));
    editor.commands.insertContentAt(8, 'X'); // inside the commented run
    await new Promise((r) => setTimeout(r, 0));
    expect(keysOf(doc)).not.toEqual(before); // the binding wrote its own key
    expect(ids(collectReviewItems(editor.state.doc))).toEqual(['comment_anchor:c1']);
    expect(reviewIdsInY(doc)).toEqual(['comment_anchor:c1']);
    // Keys the binding wrote are parseable, so a re-key on the next load is a no-op.
    expect(rekeyMarks(doc)).toBe(0);
    editor.destroy();
  });

  it('refuses a later Yjs update that brings an unknown mark, leaving the doc intact', async () => {
    const doc = docToYDoc(commented as never);
    const errors: Error[] = [];
    const editor = new Editor(
      collaborativeEditorOptions(doc, {
        element: document.createElement('div'),
        onContentError: ({ error }) => errors.push(error),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const shown = editor.getJSON();

    // Another writer (peer or agent) adds a mark this schema does not know.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const pt = (peer.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    pt.format(0, 5, { glitter: {} });
    const stored = () => JSON.stringify(yDocToDoc(doc));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    const afterRemote = stored();
    expect(afterRemote).toContain('glitter');
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toHaveLength(1);
    expect(contentErrorOf(editor)).toBe(errors[0]);
    expect(editor.isEditable).toBe(false);
    expect(editor.getJSON()).toEqual(shown);
    // A local attempt to write is not applied, and the unknown mark survives in the Y.Doc.
    editor.commands.insertContentAt(2, 'Z');
    await new Promise((r) => setTimeout(r, 0));
    expect(stored()).toBe(afterRemote);
    editor.destroy();
  });

  it('accepts valid remote updates after load', async () => {
    const doc = docToYDoc(commented as never);
    const editor = new Editor(
      collaborativeEditorOptions(doc, { element: document.createElement('div') }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    ((peer.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(
      0,
      'A ',
    );
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    await new Promise((r) => setTimeout(r, 0));
    expect(contentErrorOf(editor)).toBeUndefined();
    expect(editor.getText()).toBe('A plain noted');
    editor.destroy();
  });

  it('rekeyMarks leaves keys the binding can parse alone', () => {
    const doc = docToYDoc(commented as never);
    const t = (doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    t.format(6, 5, {
      [markKey({ type: 'comment_anchor', attrs: { id: 'c1' } })]: null,
      'comment_anchor--Ql7mhpA0': { id: 'c1' },
    });
    expect(rekeyMarks(doc)).toBe(0);
    expect(keysOf(doc)).toEqual(['comment_anchor--Ql7mhpA0']);
  });
});
