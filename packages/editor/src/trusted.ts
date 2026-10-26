/**
 * Trusted-only helpers, imported from `@coauthor/editor/trusted` by app code. Not re-exported
 * from the package root, so editor plugins and agent-facing code do not get them. Also hosts
 * the review decision port (RAD-211): accept/reject as one trusted ProseMirror transaction.
 */
import type { Transaction } from '@tiptap/pm/state';
import { REVIEW_EDIT_TOKEN, reviewGuardKey } from './review';
import {
  applyReviewDecision as applyWith,
  type ReviewDecisionOp as Op,
  type ReviewView as View,
} from './reviewtx';

/** Let this transaction add, remove or edit review marks. */
export function allowReviewEdits(tr: Transaction): Transaction {
  return tr.setMeta(reviewGuardKey, REVIEW_EDIT_TOKEN);
}

export {
  applyReviewDecision as applyReviewDecisionWith,
  buildReviewTransaction,
  type ReviewDecision,
  type ReviewDecisionOp,
  type ReviewTarget,
  type ReviewTrust,
  type ReviewView,
  type SuggestionMarkType,
} from './reviewtx';

/** Apply an accept/reject decision on the live editor as one trusted transaction. */
export function applyReviewDecision(view: View, op: Op): boolean {
  return applyWith(view, op, allowReviewEdits);
}
