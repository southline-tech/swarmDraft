/** Human-authored comment anchors (trusted path only). */
import type { EditorView } from '@tiptap/pm/view';
import { allowReviewEdits } from '@coauthor/editor/trusted';

export function applyCommentAnchor(
  view: EditorView,
  from: number,
  to: number,
  id: string,
): boolean {
  const type = view.state.schema.marks.comment_anchor;
  if (!type || from >= to) return false;
  view.dispatch(allowReviewEdits(view.state.tr.addMark(from, to, type.create({ id }))));
  return true;
}
