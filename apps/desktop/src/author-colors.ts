/**
 * One author → `--ct-collab-N` slot assignment shared by the review and comments panels (#72),
 * so a collaborator has the same color everywhere. Keys are the raw author id both panels use:
 * `agent:<id>` for agents, the stored name for people. Grok Bot is always collab-1; everyone
 * else gets 2..N in first-seen order (wrapping over 2..N). Once assigned, a slot never changes.
 */
import { COLLAB_TOKENS, GROK_BOT } from './review/review-state';

const slots = new Map<string, number>();
let next = 0;

export function collabSlotOf(key: string, displayName: string): number {
  if (displayName === GROK_BOT) return 1;
  let s = slots.get(key);
  if (s === undefined) {
    s = 2 + (next++ % (COLLAB_TOKENS - 1));
    slots.set(key, s);
  }
  return s;
}

/** The CSS color for an author: always a token, never a computed color. */
export const collabColor = (key: string, displayName: string) =>
  `var(--ct-collab-${collabSlotOf(key, displayName)})`;

/** Test hook (and for a fresh document): forget all assignments. */
export function resetCollabSlots() {
  slots.clear();
  next = 0;
}
