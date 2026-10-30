/**
 * Per-author suggestion mark colors (#48): decoration-only `data-suggester` and `--ct-suggester`
 * on suggested text so manuscript CSS resolves `--ct-suggest-*` per author. The host supplies
 * the token (e.g. `var(--ct-collab-N)`); legacy marks with no author get a neutral token.
 * Dispatch `refreshSuggestionColors(view)` when the color map or author visibility changes.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export const suggestionColorsKey = new PluginKey<DecorationSet>('coauthorSuggestionColors');
export type SuggestionColor = (author: string) => string;
/** When false, suggestion marks render as plain text (display only; doc unchanged). */
export type SuggestionAuthorVisible = (author: string) => boolean;

const SUGGESTION = new Set(['suggestion_insert', 'suggestion_delete']);

function hiddenClasses(marks: { type: { name: string } }[]): string {
  const classes = ['suggestion-filter-hidden'];
  if (marks.some((m) => m.type.name === 'suggestion_insert'))
    classes.push('suggestion-filter-hidden-insert');
  if (marks.some((m) => m.type.name === 'suggestion_delete'))
    classes.push('suggestion-filter-hidden-delete');
  return classes.join(' ');
}

function decorate(
  doc: PMNode,
  colorFor: SuggestionColor,
  authorVisible: SuggestionAuthorVisible,
): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const marks = node.marks.filter((m) => SUGGESTION.has(m.type.name));
    if (!marks.length) return false;
    const authors = [...new Set(marks.map((m) => String(m.attrs.author ?? '').trim()))];
    const author = authors.length === 1 ? authors[0]! : '';
    if (!authors.some((a) => authorVisible(a))) {
      decos.push(
        Decoration.inline(pos, pos + node.nodeSize, {
          class: hiddenClasses(marks),
        }),
      );
      return false;
    }
    const token = colorFor(author);
    decos.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        'data-suggester': '',
        style: `--ct-suggester: ${token}`,
      }),
    );
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export const AuthorSuggestionColors = Extension.create<{
  colorFor: SuggestionColor;
  authorVisible: SuggestionAuthorVisible;
}>({
  name: 'authorSuggestionColors',
  addOptions: () => ({
    colorFor: (author: string) => (author ? `var(--ct-collab-1)` : `var(--ct-text-muted)`),
    authorVisible: () => true,
  }),
  addProseMirrorPlugins() {
    const colorFor: SuggestionColor = (a) => this.options.colorFor(a);
    const authorVisible: SuggestionAuthorVisible = (a) => this.options.authorVisible(a);
    return [
      new Plugin<DecorationSet>({
        key: suggestionColorsKey,
        state: {
          init: (_, state: EditorState) => decorate(state.doc, colorFor, authorVisible),
          apply: (tr, old) =>
            tr.docChanged || tr.getMeta(suggestionColorsKey)
              ? decorate(tr.doc, colorFor, authorVisible)
              : old,
        },
        props: { decorations: (state) => suggestionColorsKey.getState(state) },
      }),
    ];
  },
});

/** Recompute colors after profile, agent list, or slot map changes. Does not touch content. */
export function refreshSuggestionColors(view: {
  state: EditorState;
  dispatch: (tr: EditorState['tr']) => void;
}) {
  view.dispatch(view.state.tr.setMeta(suggestionColorsKey, true).setMeta('addToHistory', false));
}
