/**
 * Selected/hover styling for comment anchors (#211): decoration-only so ProseMirror owns
 * the DOM and text selection is not broken by classList toggles after copy/cut.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export const commentAnchorUiKey = new PluginKey<DecorationSet>('swarmdraftCommentAnchorUi');

export type CommentAnchorUiState = () => { selectedId: string | null; hoverId: string | null };

function decorate(doc: PMNode, selectedId: string | null, hoverId: string | null): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === 'comment_anchor');
    if (!mark) return;
    const id = String(mark.attrs.id ?? '');
    const classes: string[] = [];
    if (id && id === selectedId) classes.push('comment-anchor--selected');
    else if (id && id === hoverId) classes.push('comment-anchor--hover');
    if (classes.length) {
      decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: classes.join(' ') }));
    }
  });
  return DecorationSet.create(doc, decos);
}

export const CommentAnchorUi = Extension.create<{ uiState: CommentAnchorUiState }>({
  name: 'commentAnchorUi',
  addOptions: () => ({
    uiState: () => ({ selectedId: null, hoverId: null }),
  }),
  addProseMirrorPlugins() {
    const uiState = () => this.options.uiState();
    return [
      new Plugin<DecorationSet>({
        key: commentAnchorUiKey,
        state: {
          init: (_, state: EditorState) => {
            const { selectedId, hoverId } = uiState();
            return decorate(state.doc, selectedId, hoverId);
          },
          apply: (tr, old, _oldState, newState) => {
            if (tr.docChanged || tr.getMeta(commentAnchorUiKey)) {
              const { selectedId, hoverId } = uiState();
              return decorate(newState.doc, selectedId, hoverId);
            }
            return old;
          },
        },
        props: { decorations: (state) => commentAnchorUiKey.getState(state) },
      }),
    ];
  },
});

/** Refresh anchor selected/hover decorations; does not touch document content. */
export function refreshCommentAnchorUi(view: {
  state: EditorState;
  dispatch: (tr: EditorState['tr']) => void;
}) {
  view.dispatch(view.state.tr.setMeta(commentAnchorUiKey, true).setMeta('addToHistory', false));
}
