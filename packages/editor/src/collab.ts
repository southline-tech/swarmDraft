/**
 * Binds the manuscript editor to a section's Y.Doc (RAD-203). The document lives in the
 * Y.XmlFragment named `prosemirror`, the same encoding `@coauthor/docx` (ydoc.ts) and the Rust
 * MCP server use. Review marks are stored under `type--id` / `type--hash` keys, so overlapping
 * comments and suggestions survive.
 */
import Collaboration from '@tiptap/extension-collaboration';
import type { EditorOptions } from '@tiptap/core';
import type * as Y from 'yjs';
import { manuscriptExtensions } from './extensions';

export const YJS_FRAGMENT = 'prosemirror';

/** Editor options bound to `doc`; content always comes from the Y.Doc, never `opts.content`. */
export function collaborativeEditorOptions(
  doc: Y.Doc,
  opts: Partial<EditorOptions> = {},
): Partial<EditorOptions> {
  return {
    ...opts,
    content: undefined,
    extensions: [
      ...manuscriptExtensions(),
      Collaboration.configure({ document: doc, field: YJS_FRAGMENT }),
      ...(opts.extensions ?? []),
    ],
  };
}
