import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { docToYDoc, yDocToDoc } from '@coauthor/docx';
import {
  HumanTrackChanges,
  listSuggestions,
  manuscriptEditorOptions,
  collaborativeEditorOptions,
} from './index';

const WRITER = 'Rowan Vale';
const plainDoc: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [{ type: 'text', text: 'Alpha line.' }],
    },
  ],
};

function editor(content: JSONContent = plainDoc, tracking = true) {
  return new Editor(
    manuscriptEditorOptions({
      element: document.createElement('div'),
      content,
      extensions: [
        HumanTrackChanges.configure({
          active: () => tracking,
          author: () => WRITER,
        }),
      ],
    }),
  );
}

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

describe('human track changes (#126)', () => {
  it('records an insert as a suggestion under the writer name', () => {
    const e = editor();
    editors.push(e);
    const pos = e.state.doc.content.size - 1;
    e.view.dispatch(e.state.tr.insertText(' More', pos));
    const items = listSuggestions(e.getJSON() as never);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'suggestion_insert',
      author: WRITER,
      text: ' More',
    });
    expect(e.state.doc.textContent).toContain(' More');
    e.destroy();
  });

  it('records a delete as suggestion_delete without removing text', () => {
    const e = editor();
    editors.push(e);
    e.commands.setTextSelection({ from: 1, to: 6 });
    e.view.dispatch(e.state.tr.deleteSelection());
    const items = listSuggestions(e.getJSON() as never);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'suggestion_delete', author: WRITER, text: 'Alpha' });
    expect(e.state.doc.textContent).toBe('Alpha line.');
    e.destroy();
  });

  it('records replace as paired marks sharing an id', () => {
    const e = editor();
    editors.push(e);
    e.commands.setTextSelection({ from: 1, to: 6 });
    e.view.dispatch(e.state.tr.insertText('Beta'));
    const items = listSuggestions(e.getJSON() as never);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id)).toEqual([items[0]!.id, items[0]!.id]);
    expect(items.find((i) => i.kind === 'suggestion_delete')?.text).toBe('Alpha');
    expect(items.find((i) => i.kind === 'suggestion_insert')?.text).toBe('Beta');
    e.destroy();
  });

  it('does not track when the toggle is off', () => {
    const e = editor(plainDoc, false);
    editors.push(e);
    e.view.dispatch(e.state.tr.insertText('x', e.state.doc.content.size - 1));
    expect(listSuggestions(e.getJSON() as never)).toHaveLength(0);
    e.destroy();
  });

  it('undo removes a tracked insert', () => {
    const ydoc = docToYDoc(plainDoc as never);
    const e = new Editor(
      collaborativeEditorOptions(ydoc, {
        element: document.createElement('div'),
        extensions: [HumanTrackChanges.configure({ active: () => true, author: () => WRITER })],
      }),
    );
    editors.push(e);
    e.view.dispatch(e.state.tr.insertText(' tail', e.state.doc.content.size - 1));
    expect(listSuggestions(e.getJSON() as never)).toHaveLength(1);
    expect(e.commands.undo()).toBe(true);
    expect(listSuggestions(e.getJSON() as never)).toHaveLength(0);
    expect(e.state.doc.textContent).not.toContain(' tail');
    e.destroy();
  });

  it('persists suggestions through Yjs round-trip', () => {
    const ydoc = docToYDoc(plainDoc as never);
    const e = new Editor(
      collaborativeEditorOptions(ydoc, {
        element: document.createElement('div'),
        extensions: [HumanTrackChanges.configure({ active: () => true, author: () => WRITER })],
      }),
    );
    editors.push(e);
    e.view.dispatch(e.state.tr.insertText('!', 1));
    const exported = yDocToDoc(ydoc);
    expect(listSuggestions(exported).some((s) => s.author === WRITER)).toBe(true);
    e.destroy();
  });
});

describe('human track trusted marks', () => {
  it('dispatches a trusted append pass after recording', () => {
    const e = editor();
    editors.push(e);
    e.view.dispatch(e.state.tr.insertText('z', 1));
    expect(listSuggestions(e.getJSON() as never)).toHaveLength(1);
    e.destroy();
  });
});
