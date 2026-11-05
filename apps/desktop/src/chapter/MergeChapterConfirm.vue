<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { trapTab } from '../settings/focus-trap';

const props = defineProps<{
  targetTitle: string;
  sourceTitle: string;
  skipAskSession: boolean;
  returnFocus?: HTMLElement | null;
}>();
const emit = defineEmits<{ close: []; confirm: [dontAskAgain: boolean] }>();

const dontAsk = ref(false);
const dialog = ref<HTMLElement | null>(null);
const mergeBtn = ref<HTMLButtonElement | null>(null);

const titleId = 'merge-chapter-title';
const descId = 'merge-chapter-desc';

function closeAndReturn() {
  emit('close');
  props.returnFocus?.focus?.();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeAndReturn();
    return;
  }
  if (dialog.value) trapTab(e, dialog.value);
}

onMounted(() => {
  void nextTick(() => mergeBtn.value?.focus());
});

onBeforeUnmount(() => props.returnFocus?.focus?.());
</script>
<template>
  <div
    class="st-dlg-scrim"
    data-test="merge-chapter-confirm-backdrop"
    @mousedown.self="closeAndReturn"
  >
    <div
      ref="dialog"
      class="merge-confirm st-dlg"
      role="alertdialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-describedby="descId"
      tabindex="-1"
      data-test="merge-chapter-confirm"
      @keydown="onKeydown"
    >
      <h2 :id="titleId">Merge “{{ sourceTitle }}” into “{{ targetTitle }}”?</h2>
      <p :id="descId">
        “{{ sourceTitle }}” stays as the first line of its text. Notes and comments move with it.
      </p>
      <label v-if="!skipAskSession"
        ><input v-model="dontAsk" type="checkbox" data-test="merge-dont-ask" /> Don't ask again this
        session</label
      >
      <div class="merge-confirm__actions">
        <button type="button" class="sh-btn" data-test="merge-cancel" @click="closeAndReturn">
          Cancel
        </button>
        <button
          ref="mergeBtn"
          type="button"
          class="sh-btn sh-btn--primary"
          data-test="merge-confirm"
          @click="emit('confirm', dontAsk)"
        >
          Merge
        </button>
      </div>
    </div>
  </div>
</template>
<style scoped>
.merge-confirm {
  max-width: 480px;
}
.merge-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--ct-space-2);
  margin-top: var(--ct-space-3);
}
</style>
