import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import {
  AuthorLabels,
  FormatTrackChanges,
  HumanTrackChanges,
  manuscriptEditorOptions,
} from './index';

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

describe('AuthorLabels format hover (#160)', () => {
  const editors: Editor[] = [];
  afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

  it('uses format card summary in the title, not a generic format line', () => {
    const e = new Editor(
      manuscriptEditorOptions({
        element: document.createElement('div'),
        content: plainDoc,
        extensions: [
          HumanTrackChanges.configure({ active: () => true, author: () => 'Kim' }),
          FormatTrackChanges.configure({ active: () => true, author: () => 'Kim' }),
          AuthorLabels.configure({
            label: (a) => (a === 'Kim' ? 'Kim' : a),
            authorVisible: () => true,
          }),
        ],
      }),
    );
    editors.push(e);
    e.chain().focus().selectAll().toggleBold().run();
    const titled = e.view.dom.querySelector('[title]') as HTMLElement | null;
    expect(titled?.getAttribute('title')).toBe('Add bold by Kim');
  });
});
