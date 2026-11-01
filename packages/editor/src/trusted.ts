/**
 * Trusted-only helpers, imported from `@swarmdraft/editor/trusted` by app code. Not re-exported
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
import {
  decideSuggestions,
  type DecisionOp,
  type LiveDocStore,
  type ReviewTransactionPort,
} from './decisions';

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

export type { LiveDocStore } from './decisions';

// TODO(RAD-211 wiring): replace this stub with applyReviewDecision above, editing the live
// editor state by attrs.id in one trusted transaction instead of committing a whole doc.
export function createReviewPort(store: LiveDocStore): ReviewTransactionPort {
  return {
    applyReviewDecision(op: DecisionOp) {
      const { doc, decided, outdated, superseded } = decideSuggestions(store.read(), op);
      if (decided.length) store.commit(doc);
      return { decided, outdated, superseded };
    },
  };
}
