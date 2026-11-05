<script setup lang="ts">
import { ref } from 'vue';
defineProps<{ targetTitle: string; sourceTitle: string; skipAskSession: boolean }>();
const emit = defineEmits<{ close: []; confirm: [dontAskAgain: boolean] }>();
const dontAsk = ref(false);
</script>
<template>
  <div
    class="st-dlg-scrim"
    data-test="merge-chapter-confirm-backdrop"
    @mousedown.self="emit('close')"
  >
    <div
      class="merge-confirm st-dlg"
      role="alertdialog"
      aria-modal="true"
      data-test="merge-chapter-confirm"
      @keydown.esc="emit('close')"
    >
      <h2>Merge “{{ sourceTitle }}” into “{{ targetTitle }}”?</h2>
      <p>
        {{ sourceTitle }}'s title is kept as a line at the start of its text. Notes and comments
        move with the text.
      </p>
      <label v-if="!skipAskSession"
        ><input v-model="dontAsk" type="checkbox" data-test="merge-dont-ask" /> Don't ask again this
        session</label
      >
      <div class="merge-confirm__actions">
        <button type="button" class="sh-btn" data-test="merge-cancel" @click="emit('close')">
          Cancel
        </button>
        <button
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
@import '../settings/settings.css';
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
