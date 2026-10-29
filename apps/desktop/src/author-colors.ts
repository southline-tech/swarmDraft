/**
 * One author → `--ct-collab-N` slot assignment shared by the review and comments panels (#72),
 * manuscript suggestion marks (#48), so a collaborator has the same color everywhere. Keys are
 * the raw author id both panels use: `agent:<id>` for agents, the stored name for people. The
 * primary agent (P1 bot, #76) is pinned to collab-1 by agent id, never by display name.
 * Display names are never used, so a renamed agent keeps its color.
 *
 * People use the writer profile swatch from settings (#57) when the mark author matches that
 * profile name. Everyone else gets 1..N in first-seen order (wrapping), skipping collab-1 when
 * a primary is set. Once assigned, a slot never changes (until a different manuscript opens).
 */
import { swatchVar } from './shells/colors';
import { COLLAB_TOKENS } from './review/review-state';

const AGENT_KEY_PREFIX = 'agent:';

const slots = new Map<string, number>();
let next = 0;
let primaryKey: string | null = null;

function takeNextFreeSlot(): number {
  const used = new Set(slots.values());
  if (primaryKey) used.add(1);
  for (let s = primaryKey ? 2 : 1; s <= COLLAB_TOKENS; s++) {
    if (!used.has(s)) return s;
  }
  return allocateSlot();
}

/** Pin the built-in bot to collab-1; pass null when none is primary. */
export function pinPrimaryAgent(agentId: string | null) {
  const nextPrimary = agentId ? `${AGENT_KEY_PREFIX}${agentId}` : null;
  if (nextPrimary === primaryKey) return;
  primaryKey = nextPrimary;
  if (!primaryKey) return;
  for (const [key, slot] of [...slots.entries()]) {
    if (slot === 1 && key !== primaryKey) slots.set(key, takeNextFreeSlot());
  }
  slots.set(primaryKey, 1);
}

function allocateSlot(): number {
  if (!primaryKey) {
    return 1 + (next++ % COLLAB_TOKENS);
  }
  const pool = COLLAB_TOKENS - 1;
  return 2 + (next++ % pool);
}

/** Writer display name + swatch id from settings (#57). */
let writerProfile: { name: string; color: number } | undefined;

/** Legacy marks with no author: neutral suggester, not a collab slot (#48 PM). */
export const NEUTRAL_SUGGESTER = 'var(--ct-text-muted)';

export function collabSlotOf(key: string): number {
  if (primaryKey && key === primaryKey) return 1;
  let s = slots.get(key);
  if (s === undefined) {
    s = allocateSlot();
    slots.set(key, s);
  }
  return s;
}

/** Keep manuscript/review colors aligned with the writer profile (#57). */
export function setWriterProfileForColors(name: string, color: number) {
  writerProfile = { name, color };
}

/** The CSS color for an author: always a token, never a computed color. */
export function collabColor(key: string): string {
  const author = key.trim();
  if (!author) return NEUTRAL_SUGGESTER;
  if (!author.startsWith(AGENT_KEY_PREFIX) && writerProfile && author === writerProfile.name) {
    return swatchVar(writerProfile.color);
  }
  return `var(--ct-collab-${collabSlotOf(author)})`;
}

/** Test hook (and for a fresh document): forget slot assignments; primary pin is unchanged. */
export function resetCollabSlots() {
  slots.clear();
  next = 0;
  writerProfile = undefined;
}
