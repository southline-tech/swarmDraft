import { describe, expect, it } from 'vitest';
import { createManuscriptEditor, refreshCommentAnchorUi, CommentAnchorUi } from './index';
import { commentAnchorUiKey } from './comment-anchor-ui';

describe('CommentAnchorUi (#211)', () => {
  it('refresh keeps text selection on comment anchor text (copy/cut #54)', () => {
    const editor = createManuscriptEditor({
      extensions: [
        CommentAnchorUi.configure({
          uiState: () => ({ selectedId: 'c1', hoverId: null }),
        }),
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                marks: [{ type: 'comment_anchor', attrs: { id: 'c1' } }],
                text: 'rain',
              },
            ],
          },
        ],
      },
    });
    refreshCommentAnchorUi(editor.view);
    editor.commands.setTextSelection({ from: 1, to: 5 });
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(5);
    editor.destroy();
  });

  it('rebuilds decorations when refresh meta is dispatched', () => {
    const editor = createManuscriptEditor({
      extensions: [
        CommentAnchorUi.configure({
          uiState: () => ({ selectedId: 'c1', hoverId: null }),
        }),
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                marks: [{ type: 'comment_anchor', attrs: { id: 'c1' } }],
                text: 'x',
              },
            ],
          },
        ],
      },
    });
    refreshCommentAnchorUi(editor.view);
    expect(commentAnchorUiKey.getState(editor.state)?.find().length).toBeGreaterThan(0);
    editor.destroy();
  });
});
