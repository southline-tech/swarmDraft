import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { docToYDoc, yDocToDoc } from '@swarmdraft/docx';
import type { DocNode } from '@swarmdraft/schema';
import {
  FormatTrackChanges,
  HumanTrackChanges,
  listSuggestions,
  manuscriptEditorOptions,
} from './index';
import { applyReviewDecision } from './trusted';

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

function editor(content: JSONContent = plainDoc) {
  return new Editor(
    manuscriptEditorOptions({
      element: document.createElement('div'),
      content,
      extensions: [
        HumanTrackChanges.configure({ active: () => true, author: () => WRITER }),
        FormatTrackChanges.configure({ active: () => true, author: () => WRITER }),
      ],
    }),
  );
}

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

describe('format track changes (#160)', () => {
  it('records bold toggle as format_change under the writer name', () => {
    const e = editor();
    editors.push(e);
    e.chain().focus().selectAll().toggleBold().run();
    const items = listSuggestions(e.getJSON() as DocNode);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'format_change',
      author: WRITER,
      target: 'bold',
      before: '0',
      after: '1',
      text: 'Alpha line.',
    });
    expect(e.state.doc.textBetween(1, e.state.doc.content.size - 1, '', '')).toBe('Alpha line.');
  });

  it('records paragraph style changes', () => {
    const e = editor();
    editors.push(e);
    e.chain().focus().selectAll().setParagraphStyle('centered').run();
    const items = listSuggestions(e.getJSON() as DocNode);
    expect(items[0]).toMatchObject({
      kind: 'format_change',
      target: 'paragraph_style',
      before: 'body',
      after: 'centered',
    });
  });

  it('accept removes the format_change mark and keeps bold', () => {
    const e = editor();
    editors.push(e);
    e.chain().focus().selectAll().toggleBold().run();
    const id = listSuggestions(e.getJSON() as DocNode)[0]!.id;
    applyReviewDecision(e.view, {
      targets: [{ kind: 'format_change', id }],
      decision: 'accept',
    });
    expect(listSuggestions(e.getJSON() as DocNode)).toHaveLength(0);
    expect(e.getJSON()).toMatchObject({
      content: [{ content: [{ marks: [{ type: 'bold' }] }] }],
    });
  });

  it('reject restores plain text and drops the mark', () => {
    const e = editor();
    editors.push(e);
    e.chain().focus().selectAll().toggleBold().run();
    const id = listSuggestions(e.getJSON() as DocNode)[0]!.id;
    applyReviewDecision(e.view, {
      targets: [{ kind: 'format_change', id }],
      decision: 'reject',
    });
    expect(listSuggestions(e.getJSON() as DocNode)).toHaveLength(0);
    expect(e.getJSON()).toMatchObject({
      content: [{ content: [{ type: 'text', text: 'Alpha line.' }] }],
    });
  });

  it('does not throw when paste adds paragraphs alongside human track (#163)', () => {
    const e = editor();
    editors.push(e);
    const pos = e.state.doc.content.size - 1;
    e.commands.insertContentAt(pos, [
      {
        type: 'paragraph',
        attrs: { style: 'body' },
        content: [{ type: 'text', text: 'Para A.' }],
      },
      {
        type: 'paragraph',
        attrs: { style: 'body' },
        content: [{ type: 'text', text: 'Para B.' }],
      },
    ]);
    const formats = listSuggestions(e.getJSON() as DocNode).filter(
      (i) => i.kind === 'format_change',
    );
    expect(formats).toHaveLength(0);
  });

  it('round-trips format_change through Yjs', () => {
    const e = editor();
    editors.push(e);
    e.chain().focus().selectAll().toggleItalic().run();
    const ydoc = docToYDoc(e.getJSON() as DocNode);
    const back = yDocToDoc(ydoc);
    expect(listSuggestions(back)[0]).toMatchObject({ kind: 'format_change', target: 'italic' });
  });
});
