/**
 * Bind a manuscript editor to a section Y.Doc (y-prosemirror encoding, fragment "prosemirror").
 * The stored content is validated against the manuscript schema first; if it holds nodes or
 * marks the schema does not know, the editor is NOT bound (so nothing can be written back),
 * opens read-only and empty, and reports the error instead of silently dropping content.
 *
 * Validation stays on after load: every Yjs change that did not come from this editor's own
 * binding (a remote peer, an agent, a persistence pull) is checked before y-prosemirror applies
 * it. If it introduces unknown nodes or marks, the editor stops taking changes from the doc
 * (they would otherwise be dropped and then erased by the next local write), turns read-only and
 * reports the error through `onContentError`. The Y.Doc itself is left untouched.
 */
import { Extension, getSchema, type EditorOptions, type JSONContent } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import Collaboration from '@tiptap/extension-collaboration';
import { yXmlFragmentToProsemirrorJSON, ySyncPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import type { Editor } from '@tiptap/core';
import { manuscriptExtensions } from './extensions';
import { EMPTY_DOC, manuscriptEditorOptions } from './index';
import { trustBindingDispatches } from './ysource';

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
  // A brand-new section's doc has no content yet (#42). That is not invalid content: open it as
  // one empty body paragraph, which the binding writes to the doc. Incoming updates that empty
  // an existing doc are still checked strictly by the guard below.
  const { json, error } =
    doc.getXmlFragment(field).length === 0 ? { json: EMPTY_DOC } : readYDoc(doc, field);
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
  let stop: (() => void) | undefined;
  return manuscriptEditorOptions({
    ...opts,
    onCreate: (props) => {
      stop = guardIncomingUpdates(props.editor, doc, field, opts);
      opts.onCreate?.(props);
    },
    onDestroy: () => {
      stop?.();
      opts.onDestroy?.();
    },
    // Start from the stored content so the binding has nothing to write back on load.
    content: json?.content?.length ? json : EMPTY_DOC,
    extensions: [
      Collaboration.configure({ document: doc, field }),
      TrustBindingRenders,
      ...(opts.extensions ?? []),
    ],
  });
}

/**
 * Mark the exact transactions the y-sync binding dispatches (see ./ysource) so the review guard
 * lets them through. Runs as plugin state init: after y-sync's state exists, before any view is
 * created, so the binding's first render is covered too.
 */
const TrustBindingRenders = Extension.create({
  name: 'trustBindingRenders',
  priority: 1, // after Collaboration, so the y-sync state is already initialised
  addProseMirrorPlugins() {
    return [
      new Plugin({
        state: {
          init: (_config, state) => {
            const binding = (
              ySyncPluginKey.getState(state) as
                { binding?: Parameters<typeof trustBindingDispatches>[0] } | undefined
            )?.binding;
            if (binding) trustBindingDispatches(binding);
            return null;
          },
          apply: (_tr, v) => v,
        },
      }),
    ];
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs types are invariant in their event type
type AnyYType = Y.AbstractType<any>;

/** Whether a Y transaction changed anything inside `fragment`. */
function touches(tr: Y.Transaction, fragment: AnyYType): boolean {
  for (const type of tr.changed.keys()) {
    for (let t: AnyYType | null = type; t; t = (t._item?.parent as AnyYType | null) ?? null)
      if (t === fragment) return true;
  }
  return false;
}

/** Refuse incoming Yjs changes that do not fit the schema; returns an unsubscribe function. */
function guardIncomingUpdates(
  editor: Editor,
  doc: Y.Doc,
  field: string,
  opts: Partial<EditorOptions>,
): () => void {
  const onTx = (tr: Y.Transaction) => {
    if (tr.origin === ySyncPluginKey) return; // our own edits, already valid
    // Only re-read the fragment when this transaction changed it (cheap filter; the check
    // itself must stay synchronous so nothing invalid is ever applied).
    if (!touches(tr, doc.getXmlFragment(field))) return;
    const error = checkYDocContent(doc, field);
    if (!error) return;
    // Collaboration's filter rejects every Y->PM transaction once disabled.
    const collab = (editor.storage as unknown as { collaboration?: { isDisabled: boolean } })
      .collaboration;
    if (collab) collab.isDisabled = true;
    editor.setEditable(false, false);
    (editor.storage as unknown as { contentError?: Error }).contentError = error;
    doc.off('beforeObserverCalls', onTx);
    opts.onContentError?.({ editor, error, disableCollaboration: () => {} });
  };
  doc.on('beforeObserverCalls', onTx);
  return () => doc.off('beforeObserverCalls', onTx);
}
