import { onBeforeUnmount, shallowRef, type ShallowRef } from 'vue';

/**
 * Track changes is one preference for the whole book. Every mounted section
 * editor reads this ref, so a lower chapter records suggestions when the lead
 * toggles. The ref is re-read from storage only when no editor is mounted.
 */
const bookTracking = shallowRef(false);
let holders = 0;

export function useBookTracking(stored: boolean): ShallowRef<boolean> {
  if (holders === 0 && bookTracking.value !== stored) bookTracking.value = stored;
  holders += 1;
  onBeforeUnmount(() => {
    holders = Math.max(0, holders - 1);
  });
  return bookTracking;
}
