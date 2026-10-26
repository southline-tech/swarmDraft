/**
 * Trusted-only helpers, imported from `@coauthor/editor/trusted` by app code. Not re-exported
 * from the package root, so editor plugins and agent-facing code do not get them.
 * Also hosts the review decision port (RAD-211).
 */
import type { Transaction } from '@tiptap/pm/state';
import { REVIEW_EDIT_TOKEN, reviewGuardKey } from './review';
import type { DocNode } from '@coauthor/schema';
import { decideSuggestions, type DecisionOp, type ReviewTransactionPort } from './decisions';

/** Let this transaction add, remove or edit review marks. */
export function allowReviewEdits(tr: Transaction): Transaction {
  return tr.setMeta(reviewGuardKey, REVIEW_EDIT_TOKEN);
}

export interface LiveDocStore {
  /** Current document at the moment of apply (not a snapshot taken earlier). */
  read(): DocNode;
  /** Commit in one trusted, undoable transaction. */
  commit(next: DocNode): void;
}

// TODO(RAD-211, next: #7 is now on main): replace this stub with a ProseMirror transaction that finds
// each target mark by attrs.id on the live editor state, applies the change, and is tagged with
// `allowReviewEdits(tr)` from the editor's trusted module so the review guard lets it through.
export function createReviewPort(store: LiveDocStore): ReviewTransactionPort {
  return {
    applyReviewDecision(op: DecisionOp) {
      const { doc, decided, superseded } = decideSuggestions(store.read(), op);
      if (decided.length) store.commit(doc);
      return { decided, superseded };
    },
  };
}
