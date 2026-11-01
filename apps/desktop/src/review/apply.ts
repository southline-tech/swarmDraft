/** Human-only review decisions. The trusted import stays inside review/. */
import type { DocNode } from '@swarmdraft/schema';
import type { EditorState } from '@tiptap/pm/state';
import {
  applyReviewDecisionWithPortResult,
  allowReviewEdits,
  type ReviewDecisionOp,
  type ReviewView,
} from '@swarmdraft/editor/trusted';
import type { PortResult, SuggestionTarget } from '@swarmdraft/editor';
import { markSectionSuggestionsOutdated, dismissSectionOutdatedSuggestions } from '../backend';

export { applyReviewDecisionWithPortResult, allowReviewEdits } from '@swarmdraft/editor/trusted';

const docFromState = (state: EditorState): DocNode => state.doc.toJSON() as DocNode;

/** Apply a human accept/reject on the live editor and report outdated side effects (#178). */
export function applyHumanReviewDecision(
  view: ReviewView,
  op: ReviewDecisionOp,
): PortResult & { applied: boolean } {
  return applyReviewDecisionWithPortResult(view, op, allowReviewEdits, docFromState);
}

/** Persist outdated rows in the suggestion index after an accept (Tauri only). */
export async function persistOutdatedAfterAccept(
  manuscriptId: string | undefined,
  sectionId: string | undefined,
  outdated: readonly SuggestionTarget[],
): Promise<void> {
  if (!manuscriptId || !sectionId || !outdated.length) return;
  const ids = [...new Set(outdated.map((t) => t.id))];
  await markSectionSuggestionsOutdated(manuscriptId, sectionId, ids);
}

/** Remove outdated rows from the suggestion index after dismiss (#179). */
export async function persistDismissOutdated(
  manuscriptId: string | undefined,
  sectionId: string | undefined,
  targets: readonly SuggestionTarget[],
): Promise<void> {
  if (!manuscriptId || !sectionId || !targets.length) return;
  const ids = [...new Set(targets.map((t) => t.id))];
  await dismissSectionOutdatedSuggestions(manuscriptId, sectionId, ids);
}

/** Strip outdated marks on the live editor without recording a reject decision. */
export function dismissOutdatedOnView(
  view: ReviewView,
  targets: readonly SuggestionTarget[],
): boolean {
  if (!targets.length) return false;
  return applyReviewDecisionWithPortResult(
    view,
    { targets: [...targets], decision: 'reject' },
    allowReviewEdits,
    docFromState,
  ).applied;
}

/** Back-compat for tests that only need the boolean applied result. */
export function applyReviewDecision(view: ReviewView, op: ReviewDecisionOp): boolean {
  return applyHumanReviewDecision(view, op).applied;
}
