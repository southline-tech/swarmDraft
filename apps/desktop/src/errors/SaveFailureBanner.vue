<script setup lang="ts">
/**
 * Save-failure banner (#62, mockup ob9). Shown while edits aren't on disk; the copy always comes
 * from `mapError`, never raw error text. "Save a copy" writes a .docx of the in-memory manuscript.
 */
import { ref } from 'vue';
import type { SaveFailureState } from './map-error';
import type { SaveCopyResult } from './save-copy';

const props = defineProps<{
  state: SaveFailureState;
  saveCopy: () => Promise<SaveCopyResult>;
}>();

const busy = ref(false);
const result = ref('');
const resultFailed = ref(false);

async function onSaveCopy() {
  if (busy.value) return;
  busy.value = true;
  result.value = '';
  try {
    const r = await props.saveCopy();
    resultFailed.value = r.status === 'failed';
    if (r.status === 'saved')
      result.value =
        `Copy saved to ${r.path}.` +
        (r.commentsLeftOut > 0 ? " Comments aren't included in the copy." : '');
    else if (r.status === 'failed') result.value = `${r.error.title}. ${r.error.message}`;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section
    v-if="state.failing && state.error"
    class="save-failure"
    role="alert"
    aria-labelledby="save-failure-title"
    data-test="save-failure"
  >
    <svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M8 4.5v4.5M8 11v.5"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
    <div class="body">
      <p id="save-failure-title" class="title" data-test="save-failure-title">
        {{ state.error.title }}
      </p>
      <p class="message" data-test="save-failure-message">{{ state.error.message }}</p>
      <p
        v-if="result"
        class="result"
        :class="{ failed: resultFailed }"
        data-test="save-copy-result"
      >
        {{ result }}
      </p>
    </div>
    <button
      type="button"
      class="action"
      data-test="save-copy"
      :disabled="busy"
      :aria-busy="busy"
      @click="onSaveCopy"
    >
      {{ busy ? 'Saving…' : state.error.actionLabel }}
    </button>
  </section>
</template>

<style scoped>
.save-failure {
  display: flex;
  align-items: flex-start;
  gap: var(--ct-space-3);
  margin: var(--ct-space-2) var(--ct-space-4);
  padding: var(--ct-space-3) var(--ct-space-4);
  border: 1px solid var(--ct-danger);
  border-radius: var(--ct-radius-md);
  background: var(--ct-danger-bg);
  color: var(--ct-text);
}
.icon {
  flex: none;
  margin-top: 2px;
  color: var(--ct-danger);
}
.body {
  flex: 1;
  min-width: 0;
}
.title {
  margin: 0;
  font-weight: 600;
}
.message,
.result {
  margin: var(--ct-space-1) 0 0;
  color: var(--ct-text-muted);
}
.result.failed {
  color: var(--ct-danger);
}
.action {
  flex: none;
  padding: var(--ct-space-1) var(--ct-space-3);
  border: 1px solid var(--ct-danger);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-surface);
  color: var(--ct-danger);
  font: inherit;
  cursor: pointer;
}
.action:disabled {
  cursor: progress;
  opacity: 0.7;
}
.action:focus-visible {
  outline: 2px solid var(--ct-focus-ring);
  outline-offset: 2px;
}
</style>
