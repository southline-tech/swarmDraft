import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { checkYDocContent, collaborativeEditorOptions, YJS_FRAGMENT } from './index';

// #42: a section added from the navigator starts with a brand-new, empty Y.Doc.
describe('an empty section doc', () => {
  it('opens editable and takes typing, which is written to the doc', () => {
    const ydoc = new Y.Doc();
    let contentError: unknown;
    const editor = new Editor({
      ...collaborativeEditorOptions(ydoc, {
        onContentError: ({ error }) => (contentError = error),
      }),
    });
    expect(contentError).toBeUndefined();
    expect(editor.isEditable).toBe(true);
    editor.commands.focus('start');
    editor.commands.insertContent('Synthetic words');
    expect(editor.getText()).toContain('Synthetic words');
    const json = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(YJS_FRAGMENT));
    expect(JSON.stringify(json)).toContain('Synthetic words');
    expect(checkYDocContent(ydoc)).toBeUndefined();
    editor.destroy();
  });
});
