import type { DecisionRecord } from '@swarmdraft/editor';

function recordsEqual(a: readonly DecisionRecord[], b: readonly DecisionRecord[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => JSON.stringify(row) === JSON.stringify(b[i]));
}

/** Apply persisted rows unless the user changed a section's log while the load was in flight (#51). */
export function mergeLoadedDecisionRecords(
  atLoadStart: Readonly<Record<string, DecisionRecord[]>>,
  incoming: Readonly<Record<string, DecisionRecord[]>>,
  current: Readonly<Record<string, DecisionRecord[]>>,
): Record<string, DecisionRecord[]> {
  const out: Record<string, DecisionRecord[]> = {};
  for (const [sectionId, rows] of Object.entries(incoming)) {
    out[sectionId] = [...rows];
  }
  for (const [sectionId, rows] of Object.entries(current)) {
    const start = atLoadStart[sectionId] ?? [];
    if (!recordsEqual(start, rows)) {
      out[sectionId] = [...rows];
    }
  }
  return out;
}
