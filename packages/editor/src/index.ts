/**
 * Editor package: the Tiptap manuscript editor (RAD-202). The Yjs binding, local persistence
 * and the parts/chapters/scenes outline land here next (RAD-203, RAD-214).
 */
import { Editor, type EditorOptions, type JSONContent } from '@tiptap/core';
import type { Section } from '@coauthor/schema';
import { manuscriptExtensions } from './extensions';

export type OutlineNode = Section & { children: OutlineNode[] };

export * from './content';
export * from './extensions';
export * from './review';

export const EMPTY_DOC: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', attrs: { style: 'body' } }],
};

/** Options for a manuscript editor; pass the result to `new Editor()` or Vue's `useEditor()`. */
export function manuscriptEditorOptions(opts: Partial<EditorOptions> = {}): Partial<EditorOptions> {
  return {
    content: EMPTY_DOC,
    ...opts,
    extensions: [...manuscriptExtensions(), ...(opts.extensions ?? [])],
  };
}

export function createManuscriptEditor(opts: Partial<EditorOptions> = {}): Editor {
  return new Editor(manuscriptEditorOptions(opts));
}
