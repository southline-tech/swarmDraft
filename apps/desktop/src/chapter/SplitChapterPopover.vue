<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { trapTab } from '../settings/focus-trap';

const props = defineProps<{
  x: number;
  y: number;
  title: string;
  removeLine: boolean;
  returnFocus?: HTMLElement | null;
}>();
const emit = defineEmits<{
  close: [];
  confirm: [payload: { title: string; removeLine: boolean }];
}>();

const draftTitle = ref(props.title);
const removeLine = ref(props.removeLine);
const root = ref<HTMLElement | null>(null);
const titleInput = ref<HTMLInputElement | null>(null);
const pos = ref({ left: props.x, top: props.y });

const titleId = 'split-chapter-heading';

function closeAndReturn() {
  emit('close');
  props.returnFocus?.focus?.();
}

function onSubmit() {
  emit('confirm', { title: draftTitle.value, removeLine: removeLine.value });
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAndReturn();
    return;
  }
  if (root.value) trapTab(e, root.value);
}

function clampToViewport() {
  const el = root.value;
  if (!el) return;
  const MARGIN = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = el.getBoundingClientRect();
  pos.value = {
    left: Math.max(MARGIN, Math.min(props.x, vw - rect.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(props.y, vh - rect.height - MARGIN)),
  };
}

onMounted(() => {
  void nextTick(() => {
    clampToViewport();
    titleInput.value?.focus();
  });
});

onBeforeUnmount(() => props.returnFocus?.focus?.());
</script>
<template>
  <Teleport to="body">
    <div
      class="split-popover-dismiss"
      data-test="split-chapter-dismiss"
      @mousedown.self="closeAndReturn"
    />
    <form
      ref="root"
      class="split-popover sh-menu"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      data-test="split-chapter-popover"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      @keydown="onKeydown"
      @submit.prevent="onSubmit"
    >
      <h2 :id="titleId" class="split-popover__title">Split chapter</h2>
      <label
        >New chapter title<input
          ref="titleInput"
          v-model="draftTitle"
          class="sh-input"
          data-test="split-chapter-title"
          @keydown.enter.prevent="onSubmit"
      /></label>
      <label
        ><input v-model="removeLine" type="checkbox" data-test="split-chapter-remove-line" /> Remove
        this line from the text (use it as the title)</label
      >
      <div class="split-popover__actions">
        <button
          type="button"
          class="sh-btn"
          data-test="split-chapter-cancel"
          @click="closeAndReturn"
        >
          Cancel
        </button>
        <button type="submit" class="sh-btn sh-btn--primary" data-test="split-chapter-confirm">
          Split
        </button>
      </div>
    </form>
  </Teleport>
</template>
<style scoped>
.split-popover-dismiss {
  position: fixed;
  inset: 0;
  z-index: calc(var(--ct-z-flyout) - 1);
}
.split-popover {
  position: fixed;
  z-index: var(--ct-z-flyout);
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
  min-width: 280px;
  padding: var(--ct-space-3);
  margin: 0;
  border: 0;
}
.split-popover__title {
  margin: 0;
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
}
.split-popover__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--ct-space-2);
}
</style>
