<script setup lang="ts">
/**
 * Window status bar (RAD-256, WP1): current chapter, chapter / selection word counts, book word
 * count, then save status and zoom on the right. It spans the full window width on the surface
 * token. Items whose data is not available are left out, never shown with placeholder values.
 */
import ZoomControl from '../desk/ZoomControl.vue';
import { formatWords as words } from './wordcount';

export type SaveState = 'saved' | 'saving' | 'offline';

defineProps<{
  chapterTitle?: string;
  chapterWords?: number;
  /** Words in the current selection; shown instead of nothing when text is selected. */
  selectionWords?: number;
  bookWords?: number;
  saveState?: SaveState;
}>();
const zoom = defineModel<number>('zoom', { required: true });

const SAVE: Record<SaveState, { label: string; cls: string; title?: string }> = {
  saved: { label: 'Saved', cls: 'text-success' },
  saving: { label: 'Saving…', cls: 'text-muted' },
  offline: {
    label: 'Not saved, retrying',
    cls: 'text-warning',
    title: 'Your changes are kept in this window and saving keeps retrying.',
  },
};
</script>

<template>
  <footer
    class="fixed inset-x-0 bottom-0 z-10 box-border flex h-7 items-center gap-5 border-t border-border bg-surface px-4 font-ui text-xs text-muted"
    aria-label="Status bar"
    data-test="status-bar"
  >
    <slot />
    <span
      v-if="chapterTitle"
      class="max-w-64 truncate text-text"
      data-test="status-chapter"
      :title="chapterTitle"
      >{{ chapterTitle }}</span
    >
    <span v-if="chapterWords !== undefined" class="tabular-nums" data-test="status-chapter-words">
      {{ words(chapterWords) }} in chapter
    </span>
    <span v-if="selectionWords" class="tabular-nums text-text" data-test="status-selection-words">
      {{ words(selectionWords) }} selected
    </span>
    <span v-if="bookWords !== undefined" class="tabular-nums" data-test="status-book-words">
      {{ words(bookWords) }} in book
    </span>
    <span class="flex-1" />
    <span role="status" aria-live="polite" class="flex items-center" data-test="status-save">
      <span
        v-if="saveState"
        class="flex items-center gap-1"
        :class="SAVE[saveState].cls"
        :title="SAVE[saveState].title"
        :data-state="saveState"
      >
        <svg
          v-if="saveState === 'saved'"
          class="size-3.5 fill-none stroke-current stroke-[1.8] [stroke-linecap:round] [stroke-linejoin:round]"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
        {{ SAVE[saveState].label }}
      </span>
    </span>
    <span v-if="saveState" class="h-4 w-px bg-border" aria-hidden="true" />
    <ZoomControl v-model="zoom" />
  </footer>
</template>
