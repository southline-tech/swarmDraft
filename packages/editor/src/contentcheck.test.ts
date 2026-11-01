import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Editor, type JSONContent } from '@tiptap/core';
import { FRAGMENT_NAME } from '@swarmdraft/docx';
import {
  checkYDocContent,
  collaborativeEditorOptions,
  contentErrorOf,
  createManuscriptEditor,
} from './index';

// A paragraph "keep" with an unknown mark, plus an unknown table node (synthetic).
const INVALID: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [{ type: 'text', text: 'keep', marks: [{ type: 'mystery_mark' }] }],
    },
    { type: 'table', content: [{ type: 'table_row' }] },
  ],
};

function invalidYDoc(): Y.Doc {
  const ydoc = new Y.Doc();
  ydoc.transact(() => {
    const frag = ydoc.getXmlFragment(FRAGMENT_NAME);
    const p = new Y.XmlElement('paragraph');
    const table = new Y.XmlElement('table');
    frag.insert(0, [p, table]);
    p.setAttribute('style', 'body');
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, 'keep', { mystery_mark: {} });
    table.insert(0, [new Y.XmlElement('table_row')]);
  });
  return ydoc;
}

describe('content outside the schema is refused, not wiped', () => {
  it('JSON content: reports the error and goes read-only', () => {
    const errors: Error[] = [];
    const editor = createManuscriptEditor({
      content: INVALID,
      onContentError: (e) => errors.push(e.error),
    });
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.cause ?? errors[0])).toMatch(/mystery_mark|table/);
    expect(contentErrorOf(editor)).toBeDefined();
    expect(editor.isEditable).toBe(false);
    editor.destroy();
  });

  it('Y.Doc content: reports the error and never writes to the stored doc', async () => {
    const ydoc = invalidYDoc();
    const before = Y.encodeStateAsUpdate(ydoc);
    const snapshot = ydoc.getXmlFragment(FRAGMENT_NAME).toString();
    let writes = 0;
    ydoc.on('update', () => writes++);
    const errors: Error[] = [];
    expect(checkYDocContent(ydoc)?.message).toMatch(/mystery_mark|table/);
    const editor = new Editor(
      collaborativeEditorOptions(ydoc, {
        element: document.createElement('div'),
        onContentError: (e) => errors.push(e.error),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    editor.commands.insertContent('x');
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.length).toBeGreaterThan(0);
    expect(String(errors[0]?.cause ?? errors[0])).toMatch(/mystery_mark|table/);
    expect(contentErrorOf(editor)).toBeDefined();
    expect(editor.isEditable).toBe(false);
    expect(writes).toBe(0);
    expect(ydoc.getXmlFragment(FRAGMENT_NAME).toString()).toBe(snapshot);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    editor.destroy();
  });
});
