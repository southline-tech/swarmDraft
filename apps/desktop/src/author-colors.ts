/**
 * One author → `--ct-collab-N` slot assignment shared by the review and comments panels (#72),
 * so a collaborator has the same color everywhere. Keys are the raw author id both panels use:
 * `agent:<id>` for agents, the stored name for people. The primary agent (P1 bot, #76) is pinned
 * to collab-1 by agent id, never by display name. Everyone else gets 1..N in first-seen order
 * (wrapping), skipping collab-1 when a primary is set. Once assigned, a slot never changes
 * (until a different manuscript opens).
 */
import { COLLAB_TOKENS } from './review/review-state';

const AGENT_KEY_PREFIX = 'agent:';

const slots = new Map<string, number>();
let next = 0;
let primaryKey: string | null = null;

/** Pin the built-in bot to collab-1; pass null when none is primary. */
export function pinPrimaryAgent(agentId: string | null) {
  primaryKey = agentId ? `${AGENT_KEY_PREFIX}${agentId}` : null;
}

function allocateSlot(): number {
  if (!primaryKey) {
    return 1 + (next++ % COLLAB_TOKENS);
  }
  const pool = COLLAB_TOKENS - 1;
  return 2 + (next++ % pool);
}

export function collabSlotOf(key: string): number {
  if (primaryKey && key === primaryKey) return 1;
  let s = slots.get(key);
  if (s === undefined) {
    s = allocateSlot();
    slots.set(key, s);
  }
  return s;
}

/** The CSS color for an author: always a token, never a computed color. */
export const collabColor = (key: string) => `var(--ct-collab-${collabSlotOf(key)})`;

/** Test hook (and for a fresh document): forget slot assignments; primary pin is unchanged. */
export function resetCollabSlots() {
  slots.clear();
  next = 0;
}
