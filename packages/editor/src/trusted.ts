/**
 * Trusted review entry point (`@coauthor/editor/trusted`). Only the desktop review UI may
 * import this; agent/MCP code paths must not (enforced by trusted.test.ts).
 *
 * Until the editor (#7) is on main this is a stub port over a document store: it re-reads the
 * live document at apply time and runs the reference transform. With #7 it becomes a
 * ProseMirror transaction that finds marks by attrs.id and sets `allowReviewEdits(tr)`.
 */
import type { DocNode } from '@coauthor/schema';
import { decideSuggestions, type DecisionOp, type ReviewTransactionPort } from './decisions';

export interface LiveDocStore {
  /** Current document at the moment of apply (not a snapshot taken earlier). */
  read(): DocNode;
  /** Commit in one trusted, undoable transaction. */
  commit(next: DocNode): void;
}

// TODO(RAD-211, when #7 is wired): replace this stub with a ProseMirror transaction that finds
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
