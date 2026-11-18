<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { trapTab } from '../settings/focus-trap';
import type { FindBreakRow } from './chapter-app-handlers';

const rows = defineModel<FindBreakRow[]>('rows', { required: true });
const props = defineProps<{
  skipMessage?: string | null;
  skipJumpKey?: string | null;
  returnFocus?: HTMLElement | null;
}>();
const emit = defineEmits<{
  close: [];
  confirm: [];
  show: [key: string];
}>();

const root = ref<HTMLElement | null>(null);
const closeBtn = ref<HTMLButtonElement | null>(null);
const titleId = 'find-breaks-heading';

function close() {
  emit('close');
}

function submit() {
  if (!rows.value.some((row) => row.selected)) return;
  emit('confirm');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    const target = e.target;
    if (target instanceof HTMLButtonElement && target.type === 'button') return;
    e.preventDefault();
    if (!rows.value.length) {
      close();
      return;
    }
    submit();
    return;
  }
  if (root.value) trapTab(e, root.value);
}

onMounted(() => {
  void nextTick(() => {
    if (!rows.value.length) {
      closeBtn.value?.focus();
      return;
    }
    root.value?.querySelector<HTMLElement>('[data-test="find-breaks-include"]')?.focus();
  });
});

onBeforeUnmount(() => props.returnFocus?.focus?.());
</script>
<template>
  <div class="st-dlg-scrim" data-test="find-breaks-backdrop" @mousedown.self="close">
    <div
      ref="root"
      class="find-breaks st-dlg"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
      data-test="find-breaks-dialog"
      @keydown="onKeydown"
    >
      <h2 :id="titleId" class="find-breaks__title">Find chapter breaks</h2>
      <p v-if="skipMessage" class="find-breaks__skip" role="status" data-test="find-breaks-skip">
        {{ skipMessage }}
        <button
          v-if="skipJumpKey"
          type="button"
          class="sh-btn sh-btn--link"
          data-test="find-breaks-skip-show"
          @click="emit('show', skipJumpKey)"
        >
          Show
        </button>
      </p>
      <p v-if="!rows.length" class="find-breaks__empty" data-test="find-breaks-empty">
        No chapter breaks found.
      </p>
      <ul v-else class="find-breaks__list" aria-label="Proposed chapter breaks">
        <li v-for="row in rows" :key="row.key" class="find-breaks__row" :data-break-key="row.key">
          <label class="find-breaks__include">
            <input
              v-model="row.selected"
              type="checkbox"
              data-test="find-breaks-include"
              :aria-label="`Include ${row.title}`"
            />
          </label>
          <button
            type="button"
            class="find-breaks__jump"
            data-test="find-breaks-row"
            @click="emit('show', row.key)"
          >
            <span class="find-breaks__name">{{ row.title }}</span>
            <span class="find-breaks__from">From “{{ row.sourceTitle }}”</span>
            <span v-if="row.snippet" class="find-breaks__snippet">{{ row.snippet }}</span>
          </button>
          <button
            type="button"
            class="sh-btn sh-btn--link find-breaks__show"
            data-test="find-breaks-show"
            :aria-label="`Show ${row.title}`"
            @click="emit('show', row.key)"
          >
            Show
          </button>
          <label class="find-breaks__remove">
            <input v-model="row.removeLine" type="checkbox" data-test="find-breaks-remove-line" />
            Remove this line from the text (use it as the title)
          </label>
        </li>
      </ul>
      <div class="find-breaks__actions">
        <button
          v-if="!rows.length"
          ref="closeBtn"
          type="button"
          class="sh-btn"
          data-test="find-breaks-close"
          @click="close"
        >
          Close
        </button>
        <template v-else>
          <button type="button" class="sh-btn" data-test="find-breaks-cancel" @click="close">
            Cancel
          </button>
          <button
            type="button"
            class="sh-btn sh-btn--primary"
            data-test="find-breaks-confirm"
            :disabled="!rows.some((row) => row.selected)"
            :aria-disabled="rows.some((row) => row.selected) ? undefined : 'true'"
            @click="submit"
          >
            Split selected
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
<style scoped>
.find-breaks {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-3);
  width: min(36rem, 100%);
  max-height: min(32rem, calc(100vh - var(--ct-space-8)));
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
}
.find-breaks__title {
  margin: 0;
  font-size: var(--ct-text-md);
  font-weight: var(--ct-weight-semibold);
}
.find-breaks__empty,
.find-breaks__skip {
  margin: 0;
  font-size: var(--ct-text-sm);
}
.find-breaks__skip {
  color: var(--ct-text);
}
.find-breaks__list {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
}
.find-breaks__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: var(--ct-space-2);
  align-items: start;
  padding: var(--ct-space-2);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface);
}
.find-breaks__include {
  display: flex;
  align-items: center;
  min-height: var(--ct-space-8);
}
.find-breaks__jump {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ct-space-1);
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ct-text);
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.find-breaks__jump:focus-visible,
.find-breaks__show:focus-visible {
  outline: var(--ct-focus-outline);
  outline-offset: var(--ct-focus-offset);
}
.find-breaks__name {
  font-weight: var(--ct-weight-semibold);
}
.find-breaks__from,
.find-breaks__snippet {
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.find-breaks__snippet {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.find-breaks__remove {
  grid-column: 1 / -1;
  display: flex;
  gap: var(--ct-space-2);
  align-items: flex-start;
  font-size: var(--ct-text-sm);
}
.find-breaks__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--ct-space-2);
}
</style>
