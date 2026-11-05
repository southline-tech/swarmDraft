<script setup lang="ts">
/**
 * Save-failure banner (#62, mockup ob9). Shown while edits aren't on disk; the copy always comes
 * from `mapError`, never raw error text. "Save a copy" writes a .docx of the in-memory manuscript.
 */
import { ref } from 'vue';
import type { SaveFailureState } from './map-error';
import type { SaveCopyResult } from './save-copy';
import { BUSY_NOTICE } from './busy';
import ErrorCard from '../shells/ErrorCard.vue';

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
    resultFailed.value = r.status === 'failed' || r.status === 'busy';
    if (r.status === 'saved') result.value = `Copy saved to ${r.path}.`;
    else if (r.status === 'failed') result.value = `${r.error.title}. ${r.error.message}`;
    else if (r.status === 'busy') result.value = BUSY_NOTICE;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="state.failing && state.error" class="save-failure" data-test="save-failure">
    <ErrorCard
      variant="banner"
      role="alert"
      icon="save"
      tone="danger"
      :title="state.error.title"
      :text="state.error.message"
      :action="busy ? 'Saving…' : state.error.actionLabel"
      action-data-test="save-copy"
      :action-disabled="busy"
      :action-aria-busy="busy"
      @action="onSaveCopy"
    />
    <p
      v-if="result"
      class="save-failure__result"
      :class="{ 'save-failure__result--failed': resultFailed }"
      data-test="save-copy-result"
    >
      {{ result }}
    </p>
  </div>
</template>

<style scoped>
.save-failure {
  margin: var(--ct-space-2) var(--ct-space-4);
}
.save-failure__result {
  margin: var(--ct-space-2) 0 0;
  padding: 0 var(--ct-space-4);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.save-failure__result--failed {
  color: var(--ct-danger);
}
</style>
