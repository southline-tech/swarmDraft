/**
 * Bind a manuscript editor to a section Y.Doc (y-prosemirror encoding, fragment "prosemirror").
 * The stored content is validated against the manuscript schema first; if it holds nodes or
 * marks the schema does not know, the editor is NOT bound (so nothing can be written back),
 * opens read-only and empty, and reports the error instead of silently dropping content.
 */
import { getSchema, type EditorOptions, type JSONContent } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { manuscriptExtensions } from './extensions';
import { EMPTY_DOC, manuscriptEditorOptions } from './index';

export const YJS_FRAGMENT = 'prosemirror';

/** Why the Y.Doc's content cannot be loaded into the manuscript schema, or undefined if it can. */
export function checkYDocContent(doc: Y.Doc, field = YJS_FRAGMENT): Error | undefined {
  return readYDoc(doc, field).error;
}

function readYDoc(doc: Y.Doc, field: string): { json?: JSONContent; error?: Error } {
  try {
    const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(field)) as JSONContent;
    getSchema(manuscriptExtensions()).nodeFromJSON(json).check();
    return { json };
  } catch (e) {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  }
}

export function collaborativeEditorOptions(
  doc: Y.Doc,
  opts: Partial<EditorOptions> = {},
  field = YJS_FRAGMENT,
): Partial<EditorOptions> {
  const { json, error } = readYDoc(doc, field);
  if (error) {
    return manuscriptEditorOptions({
      ...opts,
      editable: false,
      onCreate: (props) => {
        (props.editor.storage as unknown as { contentError?: Error }).contentError = error;
        opts.onContentError?.({ editor: props.editor, error, disableCollaboration: () => {} });
        opts.onCreate?.(props);
      },
    });
  }
  return manuscriptEditorOptions({
    ...opts,
    // Start from the stored content so the binding has nothing to write back on load.
    content: json?.content?.length ? json : EMPTY_DOC,
    extensions: [Collaboration.configure({ document: doc, field }), ...(opts.extensions ?? [])],
  });
}
