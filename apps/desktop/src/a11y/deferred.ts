import { onBeforeUnmount, ref, watch, type Ref, type WatchSource } from 'vue';

/**
 * Follows `source` one animation frame late when it becomes truthy, and
 * immediately when it clears. Render a live region always, and its content
 * only from this ref, so the region exists before its text (#79).
 */
export function useDeferredValue<T>(source: WatchSource<T>): Ref<T | undefined> {
  const out = ref<T>() as Ref<T | undefined>;
  let frame = 0;
  watch(
    source,
    (value) => {
      cancelAnimationFrame(frame);
      if (!value) {
        out.value = value;
        return;
      }
      frame = requestAnimationFrame(() => {
        out.value = value;
      });
    },
    { immediate: true },
  );
  onBeforeUnmount(() => cancelAnimationFrame(frame));
  return out;
}
