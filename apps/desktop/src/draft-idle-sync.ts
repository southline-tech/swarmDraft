/** Matches `CHECKPOINT_DEBOUNCE_MS` / pack debounce in `draft/service.rs` (#356). */
export const DRAFT_IDLE_SYNC_MS = 5000;

let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
let packTimer: ReturnType<typeof setTimeout> | undefined;

/** After a successful section save, commit git then pack the linked `.draft`, both debounced. */
export function scheduleIdleDraftSync(
  checkpoint: () => void,
  pack: () => void,
  delayMs = DRAFT_IDLE_SYNC_MS,
): void {
  clearTimeout(checkpointTimer);
  clearTimeout(packTimer);
  checkpointTimer = setTimeout(() => {
    checkpoint();
    packTimer = setTimeout(pack, delayMs);
  }, delayMs);
}

/** On blur or close: run any pending checkpoint and pack without waiting on the debounce. */
export function flushIdleDraftSync(checkpoint: () => void, pack: () => void): void {
  clearTimeout(checkpointTimer);
  clearTimeout(packTimer);
  checkpointTimer = undefined;
  packTimer = undefined;
  checkpoint();
  pack();
}

/** Test hook. */
export function resetIdleDraftSyncTimers(): void {
  clearTimeout(checkpointTimer);
  clearTimeout(packTimer);
  checkpointTimer = undefined;
  packTimer = undefined;
}
