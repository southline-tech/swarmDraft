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
import { isBindingTransaction } from './ysource';
import { REVIEW_MARKS, SUGGESTION_MARKS, type ReviewMarkType } from './content';

let humanTrackActive: (() => boolean) | null = null;
let humanTrackAuthor: (() => string) | null = null;

/** Wired by HumanTrackChanges when the editor starts. */
export function registerHumanTrack(active: () => boolean, author: () => string): () => void {
  humanTrackActive = active;
  humanTrackAuthor = author;
  return () => {
    if (humanTrackActive === active) humanTrackActive = null;
    if (humanTrackAuthor === author) humanTrackAuthor = null;
  };
}

export function humanTrackState(): { active: boolean; author: string } {
  return { active: humanTrackActive?.() ?? false, author: humanTrackAuthor?.() ?? '' };
}

export function caretExtendsOwnInsert(doc: PMNode, pos: number, author: string): boolean {
  if (!author) return false;
  const $pos = doc.resolve(pos);
  const marks = [
    ...($pos.nodeBefore?.marks ?? []),
    ...($pos.nodeAfter?.marks ?? []),
    ...$pos.marks(),
  ];
  return marks.some(
    (m) =>
      m.type.name === 'suggestion_insert' && String(m.attrs.author ?? '').trim() === author.trim(),
  );
}

/**
 * Comments and tracked changes are read-only in the editor: they come from collaborators and
 * agents and are resolved elsewhere. The guard rejects any transaction that adds or removes a
 * review mark, pastes one in, or edits text inside a pending suggestion. Code that legitimately
 * changes them (a future accept/reject flow) marks the transaction with `allowReviewEdits(tr)`
 * from `@coauthor/editor/trusted`. The meta is an unforgeable token: a plain
 * `setMeta('allowReviewEdits', true)` from a plugin or bot is ignored. Changes the Yjs binding
 * applies from the section's Y.Doc pass, since the Y.Doc is the source of truth; the y-sync
 * meta alone is forgeable, so only transaction objects the binding itself dispatched pass
 * (tracked privately in ./ysource).
 */
export const reviewGuardKey = new PluginKey('coauthorReviewGuard');
/** Module-private token; only `allowReviewEdits` in ./trusted can attach it. */
export const REVIEW_EDIT_TOKEN: unique symbol = Symbol('coauthorReviewEdit');

const isReview = (m: PMMark) => (REVIEW_MARKS as readonly string[]).includes(m.type.name);
const isSuggestion = (m: PMMark) => (SUGGESTION_MARKS as readonly string[]).includes(m.type.name);

function touchesSuggestion(doc: PMNode, from: number, to: number): boolean {
  const track = humanTrackState();
  if (track.active && from === to && caretExtendsOwnInsert(doc, from, track.author)) return false;
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
          // Changes the Yjs binding applies from the bound Y.Doc (peers, agents; validated in
          // collab.ts): only the exact transactions the binding dispatched, never a plugin's
          // forged y-sync meta or a transaction appended in response.
          isBindingTransaction(tr) ||
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
