/**
 * Hover labels for suggestion marks (RAD-263): a decoration-only plugin that sets `title` on
 * suggested text to "Added by <name>" / "Deleted by <name>". The host supplies the label
 * (e.g. an agent's display name for `agent:<id>`), so the stored `author` attr is never shown
 * raw. Decorations set attributes through the DOM, so names are never parsed as HTML. Dispatch
 * `refreshAuthorLabels(view)` after names change.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export const authorLabelsKey = new PluginKey<DecorationSet>('coauthorAuthorLabels');
export type AuthorLabel = (author: string) => string;

const KIND: Record<string, string> = { suggestion_insert: 'Added', suggestion_delete: 'Deleted' };

function decorate(doc: PMNode, label: AuthorLabel): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const titles = node.marks
      .filter((m) => KIND[m.type.name])
      .map((m) => `${KIND[m.type.name]} by ${label(String(m.attrs.author ?? ''))}`);
    if (titles.length)
      decos.push(Decoration.inline(pos, pos + node.nodeSize, { title: titles.join('\n') }));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export const AuthorLabels = Extension.create<{ label: AuthorLabel }>({
  name: 'authorLabels',
  addOptions: () => ({ label: (a: string) => a }),
  addProseMirrorPlugins() {
    const label: AuthorLabel = (a) => this.options.label(a);
    return [
      new Plugin<DecorationSet>({
        key: authorLabelsKey,
        state: {
          init: (_, state: EditorState) => decorate(state.doc, label),
          apply: (tr, old) =>
            tr.docChanged || tr.getMeta(authorLabelsKey) ? decorate(tr.doc, label) : old,
        },
        props: { decorations: (state) => authorLabelsKey.getState(state) },
      }),
    ];
  },
});

/** Recompute the labels, e.g. after an agent was renamed. Changes no content. */
export function refreshAuthorLabels(view: {
  state: EditorState;
  dispatch: (tr: EditorState['tr']) => void;
}) {
  view.dispatch(view.state.tr.setMeta(authorLabelsKey, true).setMeta('addToHistory', false));
}
