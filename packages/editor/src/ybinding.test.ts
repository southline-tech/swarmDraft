import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { docToYDoc, importDocx, markKey, rekeyMarks } from '@coauthor/docx';
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
});
