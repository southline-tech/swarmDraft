<script setup lang="ts">
/**
 * ob7: success toast ("Your book is open…"). Purely presentational.
 *
 * Render this component unconditionally and drive it with `open`. The polite
 * live region is always in the DOM (empty while closed); only the inner
 * `.toast` content comes and goes. A live region created together with its
 * text is often skipped by screen readers (#79), so parents must not wrap
 * AppToast in v-if. Content is also held back one frame after mount so a
 * toast that is open on first render still lands in an existing region.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ShellIcon from './ShellIcon.vue';
defineProps<{
  open: boolean;
  lead?: string;
  message: string;
  action?: string;
  /** #98: 'alert' for a cue that explains why something didn't happen. */
  icon?: 'check' | 'alert';
}>();
const emit = defineEmits<{ dismiss: [] }>();

const ready = ref(false);
let frame = 0;
onMounted(() => {
  frame = requestAnimationFrame(() => {
    ready.value = true;
  });
});
onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>

<template>
  <div role="status" aria-live="polite" data-test="toast-region">
    <div v-if="open && ready" class="toast" data-test="toast">
      <span class="toast__icon" :class="{ 'toast__icon--alert': icon === 'alert' }"
        ><ShellIcon :name="icon ?? 'check'"
      /></span>
      <p class="toast__msg">
        <template v-if="lead"
          ><b>{{ lead }}</b> </template
        >{{ message }}
      </p>
      <button type="button" class="sh-btn" data-test="toast-dismiss" @click="emit('dismiss')">
        {{ action ?? 'Got it' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.toast {
  display: flex;
  align-items: center;
  gap: var(--ct-space-3);
  max-width: 512px;
  padding: var(--ct-space-3) var(--ct-space-3) var(--ct-space-3) var(--ct-space-3);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-3);
  color: var(--ct-text);
}
.toast__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: var(--ct-space-6);
  height: var(--ct-space-6);
  border-radius: var(--ct-radius-md);
  background: var(--ct-success-bg);
  color: var(--ct-success);
}
.toast__icon--alert {
  background: var(--ct-warning-bg);
  color: var(--ct-warning);
}
.toast__msg {
  flex: 1;
  margin: 0;
  font-size: var(--ct-text-sm);
}
</style>
