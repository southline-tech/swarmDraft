/**
 * One author → `--ct-collab-N` slot assignment shared by the review and comments panels (#72),
 * so a collaborator has the same color everywhere. Keys are the raw author id both panels use:
 * `agent:<id>` for agents, the stored name for people. Every author, Grok Bot included, gets
 * 1..N in first-seen order (wrapping). No author is special-cased: display names are never used,
 * so a renamed agent keeps its color and an agent calling itself "Grok Bot" gets no privilege.
 * Once assigned, a slot never changes (until a different manuscript opens).
 */
import { COLLAB_TOKENS } from './review/review-state';

const slots = new Map<string, number>();
let next = 0;

export function collabSlotOf(key: string): number {
  let s = slots.get(key);
  if (s === undefined) {
    s = 1 + (next++ % COLLAB_TOKENS);
    slots.set(key, s);
  }
  return s;
}

/** The CSS color for an author: always a token, never a computed color. */
export const collabColor = (key: string) => `var(--ct-collab-${collabSlotOf(key)})`;

/** Test hook (and for a fresh document): forget all assignments. */
export function resetCollabSlots() {
  slots.clear();
  next = 0;
}
