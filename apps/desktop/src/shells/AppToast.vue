<script setup lang="ts">
/** ob7: success toast ("Your book is open…"). Purely presentational. */
import ShellIcon from './ShellIcon.vue';
defineProps<{ lead: string; message: string; action?: string }>();
const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div class="toast" role="status" aria-live="polite" data-test="toast">
    <span class="toast__icon"><ShellIcon name="check" /></span>
    <p class="toast__msg">
      <b>{{ lead }}</b> {{ message }}
    </p>
    <button type="button" class="sh-btn" data-test="toast-dismiss" @click="emit('dismiss')">
      {{ action ?? 'Got it' }}
    </button>
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
