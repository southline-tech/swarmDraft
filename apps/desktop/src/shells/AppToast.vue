<script setup lang="ts">
/**
 * ob7: success toast ("Your book is open…"). Purely presentational.
 *
 * The polite live region is rendered empty on mount and the toast content is
 * inserted into it one frame later. A live region created together with its
 * text is often skipped by screen readers (#79).
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ShellIcon from './ShellIcon.vue';
defineProps<{ lead: string; message: string; action?: string }>();
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
  <div role="status" aria-live="polite" data-test="toast">
    <div v-if="ready" class="toast">
      <span class="toast__icon"><ShellIcon name="check" /></span>
      <p class="toast__msg">
        <b>{{ lead }}</b> {{ message }}
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
.toast__msg {
  flex: 1;
  margin: 0;
  font-size: var(--ct-text-sm);
}
</style>
