<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
const props = defineProps<{ x: number; y: number; title: string; removeLine: boolean }>();
const emit = defineEmits<{
  close: [];
  confirm: [payload: { title: string; removeLine: boolean }];
}>();
const draftTitle = ref(props.title);
const removeLine = ref(props.removeLine);
onMounted(() =>
  nextTick(() =>
    document.querySelector<HTMLInputElement>('[data-test="split-chapter-title"]')?.focus(),
  ),
);
</script>
<template>
  <div
    class="split-popover sh-menu"
    role="dialog"
    data-test="split-chapter-popover"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @keydown.esc.prevent="emit('close')"
    @keydown.enter.prevent="emit('confirm', { title: draftTitle, removeLine })"
  >
    <label
      >New chapter title<input
        v-model="draftTitle"
        class="sh-input"
        data-test="split-chapter-title"
    /></label>
    <label
      ><input v-model="removeLine" type="checkbox" data-test="split-chapter-remove-line" /> Remove
      this line from the text (use it as the title)</label
    >
    <div class="split-popover__actions">
      <button type="button" class="sh-btn" data-test="split-chapter-cancel" @click="emit('close')">
        Cancel
      </button>
      <button
        type="button"
        class="sh-btn sh-btn--primary"
        data-test="split-chapter-confirm"
        @click="emit('confirm', { title: draftTitle, removeLine })"
      >
        Split
      </button>
    </div>
  </div>
</template>
<style scoped>
.split-popover {
  position: fixed;
  z-index: var(--ct-z-dropdown);
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
  min-width: 280px;
  padding: var(--ct-space-3);
}
.split-popover__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--ct-space-2);
}
</style>
