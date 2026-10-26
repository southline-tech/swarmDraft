/**
 * Trusted-only helpers, imported from `@coauthor/editor/trusted` by app code. Not re-exported
 * from the package root, so editor plugins and agent-facing code do not get them.
 */
import type { Transaction } from '@tiptap/pm/state';
import { REVIEW_EDIT_TOKEN, reviewGuardKey } from './review';

/** Let this transaction add, remove or edit review marks. */
export function allowReviewEdits(tr: Transaction): Transaction {
  return tr.setMeta(reviewGuardKey, REVIEW_EDIT_TOKEN);
}
