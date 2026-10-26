/**
 * Private to the editor package (not exported from the index): tells the review guard whether
 * the transaction being filtered was dispatched by the Yjs binding while it applies a Y.Doc
 * change to the editor. The y-tiptap `{ isChangeOrigin: true }` meta alone proves nothing (any
 * plugin can set it); this flag is only raised by collab.ts around the binding's apply paths.
 */
let depth = 0;

export function isApplyingFromY(): boolean {
  return depth > 0;
}

/** Run `fn` with the flag raised. */
export function asYApply<T>(fn: () => T): T {
  depth++;
  try {
    return fn();
  } finally {
    depth--;
  }
}

/**
 * Raise the flag while `doc`'s observers run for a transaction that did not come from the
 * editor's own binding (`localOrigin`): that is when the binding renders the change.
 */
export function trackYApply(doc: import('yjs').Doc, localOrigin: unknown): () => void {
  const raised = new WeakSet<object>();
  const before = (tr: import('yjs').Transaction) => {
    if (tr.origin === localOrigin) return;
    raised.add(tr);
    depth++;
  };
  const after = (tr: import('yjs').Transaction) => {
    if (raised.delete(tr)) depth--;
  };
  doc.on('beforeObserverCalls', before);
  doc.on('afterTransaction', after);
  return () => {
    doc.off('beforeObserverCalls', before);
    doc.off('afterTransaction', after);
  };
}
