<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ShellIcon from '../shells/ShellIcon.vue';
import {
  availableMessage,
  manualMessageCopy,
  type ManualCheckMessage,
  type UpdatePromptMode,
} from './update-prompt-logic';

defineProps<{
  mode: UpdatePromptMode;
  version: string | null;
  progress: number | null;
  manualMessage: ManualCheckMessage | null;
}>();

const emit = defineEmits<{
  'update-now': [];
  later: [];
  dismiss: [];
}>();

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
  <div role="status" aria-live="polite" data-test="update-toast-region">
    <div
      v-if="ready && mode === 'available' && version"
      class="update-toast"
      data-test="update-toast-available"
    >
      <span class="update-toast__icon" aria-hidden="true"><ShellIcon name="check" /></span>
      <p class="update-toast__msg">{{ availableMessage(version) }}</p>
      <div class="update-toast__actions">
        <button
          type="button"
          class="sh-btn sh-btn--primary"
          data-test="update-now"
          @click="emit('update-now')"
        >
          Update now
        </button>
        <button type="button" class="sh-btn" data-test="update-later" @click="emit('later')">
          Later
        </button>
      </div>
    </div>
    <div
      v-else-if="ready && mode === 'downloading'"
      class="update-toast"
      data-test="update-toast-progress"
    >
      <span class="update-toast__icon" aria-hidden="true"><ShellIcon name="check" /></span>
      <p class="update-toast__msg">Downloading update…</p>
      <progress
        class="update-toast__bar"
        data-test="update-progress"
        :value="progress ?? 0"
        max="100"
      />
    </div>
    <div
      v-else-if="ready && mode === 'manual-message' && manualMessage"
      class="update-toast"
      data-test="update-toast-manual"
    >
      <span class="update-toast__icon update-toast__icon--alert" aria-hidden="true"
        ><ShellIcon name="alert"
      /></span>
      <p class="update-toast__msg">{{ manualMessageCopy(manualMessage) }}</p>
      <button type="button" class="sh-btn" data-test="update-dismiss" @click="emit('dismiss')">
        Got it
      </button>
    </div>
  </div>
</template>

<style scoped>
.update-toast {
  display: flex;
  align-items: center;
  gap: var(--ct-space-3);
  max-width: 520px;
  padding: var(--ct-space-3);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-3);
  color: var(--ct-text);
}
.update-toast__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: var(--ct-space-6);
  height: var(--ct-space-6);
  border-radius: var(--ct-radius-md);
  background: var(--ct-success-bg);
  color: var(--ct-success);
}
.update-toast__icon--alert {
  background: var(--ct-warning-bg);
  color: var(--ct-warning);
}
.update-toast__msg {
  flex: 1;
  margin: 0;
}
.update-toast__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-2);
}
.update-toast__bar {
  width: 8rem;
  accent-color: var(--ct-accent);
}
</style>
