/** Matches `CHECKPOINT_DEBOUNCE_MS` in `draft/service.rs` (#356). */
export const DRAFT_IDLE_CHECKPOINT_MS = 5000;

let checkpointTimer: ReturnType<typeof setTimeout> | undefined;

/** After a successful section save, debounce a git checkpoint in the app cache (no `.draft` pack). */
export function scheduleIdleDraftCheckpoint(
  checkpoint: () => void,
  delayMs = DRAFT_IDLE_CHECKPOINT_MS,
): void {
  clearTimeout(checkpointTimer);
  checkpointTimer = setTimeout(checkpoint, delayMs);
}

/** Run any pending checkpoint immediately (comment edits), still without packing. */
export function flushIdleDraftCheckpoint(checkpoint: () => void): void {
  clearTimeout(checkpointTimer);
  checkpointTimer = undefined;
  checkpoint();
}

/** Test hook. */
export function resetIdleDraftCheckpointTimers(): void {
  clearTimeout(checkpointTimer);
  checkpointTimer = undefined;
}
