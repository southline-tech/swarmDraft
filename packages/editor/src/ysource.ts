/**
 * Private to the editor package (not exported from the index): tells the review guard whether
 * a transaction is one the Yjs binding itself dispatched. The y-tiptap `{ isChangeOrigin: true }`
 * meta alone proves nothing (any plugin can set it), and a time window is not enough either
 * (observers and appendTransaction run inside it). So collab.ts routes the binding's
 * `view.dispatch` through `trustBindingDispatches`, which records the exact Transaction objects
 * in a module-private WeakSet. Transactions appended in response get no trust of their own.
 */
import type { Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

const fromBinding = new WeakSet<Transaction>();

export function isBindingTransaction(tr: Transaction): boolean {
  return fromBinding.has(tr);
}

/** Make the binding's `view` a proxy whose `dispatch` records each transaction it sends. */
export function trustBindingDispatches(binding: { readonly view: EditorView }): void {
  const proto = Object.getPrototypeOf(binding) as object;
  const getView = Object.getOwnPropertyDescriptor(proto, 'view')?.get;
  if (!getView) throw new Error('Unexpected y-tiptap binding shape: no view getter');
  let wrappedFor: EditorView | null = null;
  let proxy: EditorView | null = null;
  Object.defineProperty(binding, 'view', {
    configurable: true,
    get() {
      const view = getView.call(binding) as EditorView | null;
      if (!view) return view;
      if (view !== wrappedFor) {
        wrappedFor = view;
        const dispatch = (tr: Transaction) => {
          fromBinding.add(tr);
          view.dispatch(tr);
        };
        proxy = new Proxy(view, {
          get(target, p) {
            if (p === 'dispatch') return dispatch;
            const v = Reflect.get(target, p, target) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        });
      }
      return proxy;
    },
  });
}
