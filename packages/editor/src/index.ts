/**
 * Editor package: the Tiptap manuscript editor (RAD-202) and its Yjs binding (`./collab`).
 */
import { Editor, Extension, type EditorOptions, type JSONContent } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { Section } from '@coauthor/schema';
import { manuscriptExtensions } from './extensions';

export type OutlineNode = Section & { children: OutlineNode[] };

export * from './content';
export * from './extensions';
export * from './collab';
export {
  ReviewGuard,
  collectReviewItems,
  reviewGuardKey,
  stepChangesReview,
  transactionChangesReview,
  type ReviewItem,
} from './review';

export const EMPTY_DOC: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', attrs: { style: 'body' } }],
};

/**
 * The content check guards loading. Once the view exists, later pastes/inserts go back to
 * lenient parsing (unknown HTML dropped as usual); incoming Yjs changes are validated separately
 * by `collaborativeEditorOptions` (see collab.ts).
 */
const LenientAfterLoad = Extension.create({
  name: 'lenientAfterLoad',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        view: () => {
          editor.options.enableContentCheck = false;
          return {};
        },
      }),
    ];
  },
});

/**
 * Options for a manuscript editor; pass the result to `new Editor()` or Vue's `useEditor()`.
 *
 * Content that does not fit the manuscript schema (unknown nodes or marks) is never silently
 * dropped: the content check is on, and on a content error the editor turns read-only, a bound
 * Yjs document is detached (so nothing is written back to stored content), and
 * `opts.onContentError` is called so the UI can show the error.
 */
export function manuscriptEditorOptions(opts: Partial<EditorOptions> = {}): Partial<EditorOptions> {
  return {
    ...opts,
    content: opts.content ?? EMPTY_DOC,
    enableContentCheck: true,
    onContentError: (props) => {
      props.disableCollaboration();
      props.editor.setEditable(false, false);
      (props.editor.storage as unknown as { contentError?: Error }).contentError = props.error;
      opts.onContentError?.(props);
    },
    extensions: [...manuscriptExtensions(), LenientAfterLoad, ...(opts.extensions ?? [])],
  };
}

/** The content error the editor refused to load, if any. */
export function contentErrorOf(editor: Editor): Error | undefined {
  return (editor.storage as unknown as { contentError?: Error }).contentError;
}

export function createManuscriptEditor(opts: Partial<EditorOptions> = {}): Editor {
  return new Editor(manuscriptEditorOptions(opts));
}
