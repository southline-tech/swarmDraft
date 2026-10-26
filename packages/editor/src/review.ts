import { Extension } from '@tiptap/core';
import type { Node as PMNode, Mark as PMMark } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import {
  AddMarkStep,
  RemoveMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
} from '@tiptap/pm/transform';
import { REVIEW_MARKS, SUGGESTION_MARKS, type ReviewMarkType } from './content';

/**
 * Comments and tracked changes are read-only in the editor: they come from collaborators and
 * agents and are resolved elsewhere. The guard rejects any transaction that adds or removes a
 * review mark, pastes one in, or edits text inside a pending suggestion. Code that legitimately
 * changes them (a future accept/reject flow) marks the transaction with `allowReviewEdits(tr)`
 * from `@coauthor/editor/trusted`. The meta is an unforgeable token: a plain
 * `setMeta('allowReviewEdits', true)` from a plugin or bot is ignored.
 */
export const reviewGuardKey = new PluginKey('coauthorReviewGuard');
/** Module-private token; only `allowReviewEdits` in ./trusted can attach it. */
export const REVIEW_EDIT_TOKEN: unique symbol = Symbol('coauthorReviewEdit');

const isReview = (m: PMMark) => (REVIEW_MARKS as readonly string[]).includes(m.type.name);
const isSuggestion = (m: PMMark) => (SUGGESTION_MARKS as readonly string[]).includes(m.type.name);

function touchesSuggestion(doc: PMNode, from: number, to: number): boolean {
  if (from < to) {
    let hit = false;
    doc.nodesBetween(from, to, (n) => {
      if (n.isText && n.marks.some(isSuggestion)) hit = true;
      return !hit;
    });
    if (hit) return true;
  }
  // An insertion strictly inside a suggestion (same suggestion on both sides) changes it too.
  const $pos = doc.resolve(from);
  const before = $pos.nodeBefore?.marks.filter(isSuggestion) ?? [];
  const after = doc.resolve(to).nodeAfter?.marks ?? [];
  return before.some((m) => after.some((a) => a.eq(m)));
}

function sliceHasReviewMarks(step: ReplaceStep | ReplaceAroundStep): boolean {
  let hit = false;
  step.slice.content.descendants((n) => {
    if (n.marks.some(isReview)) hit = true;
    return !hit;
  });
  return hit;
}

export function stepChangesReview(step: Step, doc: PMNode): boolean {
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return isReview(step.mark);
  if (step instanceof ReplaceAroundStep) {
    // Wrapping/retyping a block (e.g. a paragraph style change) keeps the gap content as-is.
    const s = step as unknown as { from: number; to: number; gapFrom: number; gapTo: number };
    return (
      sliceHasReviewMarks(step) ||
      touchesSuggestion(doc, s.from, s.gapFrom) ||
      touchesSuggestion(doc, s.gapTo, s.to)
    );
  }
  if (step instanceof ReplaceStep) {
    const s = step as unknown as { from: number; to: number };
    return sliceHasReviewMarks(step) || touchesSuggestion(doc, s.from, s.to);
  }
  return false;
}

export function transactionChangesReview(tr: Transaction): boolean {
  return tr.steps.some((step, i) => stepChangesReview(step, tr.docs[i] ?? tr.doc));
}

export const ReviewGuard = Extension.create({
  name: 'reviewGuard',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: reviewGuardKey,
        filterTransaction: (tr) =>
          !tr.docChanged ||
          tr.getMeta(reviewGuardKey) === REVIEW_EDIT_TOKEN ||
          !transactionChangesReview(tr),
      }),
    ];
  },
});

export interface ReviewItem {
  type: ReviewMarkType;
  id: string;
  author?: string;
  ts?: string;
  /** Text the mark covers (joined across text nodes). */
  text: string;
}

/** Collect the comments and suggestions in a document, in reading order, one entry per id. */
export function collectReviewItems(doc: PMNode): ReviewItem[] {
  const byKey = new Map<string, ReviewItem>();
  doc.descendants((n) => {
    if (!n.isText) return;
    for (const m of n.marks) {
      if (!isReview(m)) continue;
      const key = `${m.type.name}--${m.attrs.id}`;
      const item = byKey.get(key);
      if (item) item.text += n.text ?? '';
      else
        byKey.set(key, {
          type: m.type.name as ReviewMarkType,
          id: String(m.attrs.id),
          ...(m.attrs.author ? { author: String(m.attrs.author) } : {}),
          ...(m.attrs.ts ? { ts: String(m.attrs.ts) } : {}),
          text: n.text ?? '',
        });
    }
  });
  return [...byKey.values()];
}
