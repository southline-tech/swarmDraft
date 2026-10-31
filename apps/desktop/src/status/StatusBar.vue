<script setup lang="ts">
/**
 * Window status footer (#204): word count, track-changes state, manuscript save status, Story notes
 * toggle. 26px tall; zoom lives on the toolbar row (mockup fb1–fb4 omit footer zoom).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { formatWords as words, formatCount } from './wordcount';
import { saveStatusLabel, type ManuscriptSaveView } from './save-status';

const props = defineProps<{
  /** Whole-book or current-chapter count when book total is unavailable. */
  wordCount?: number;
  selectionWords?: number;
  trackChanges?: boolean;
  save?: ManuscriptSaveView;
  storyNotesOpen?: boolean;
  /** Target panel for `aria-controls` on the Story notes toggle. */
  storyNotesPanelId?: string;
}>();

const emit = defineEmits<{
  'toggle-track-changes': [];
  'toggle-story-notes': [];
  'save-retry': [];
}>();

const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  tick = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});
onBeforeUnmount(() => clearInterval(tick));

const saveLabel = computed(() => (props.save ? saveStatusLabel(props.save, now.value) : ''));

const wordLine = computed(() => {
  if (props.wordCount === undefined) return '';
  let line = words(props.wordCount);
  if (props.selectionWords) {
    const n = props.selectionWords;
    line += ` · ${n === 1 ? '1 selected' : `${formatCount(n)} selected`}`;
  }
  return line;
});

const trackLabel = computed(() =>
  props.trackChanges ? 'Track changes: On' : 'Track changes: Off',
);
</script>

<template>
  <footer
    class="fixed inset-x-0 bottom-0 z-10 box-border flex h-[26px] items-center gap-4 border-t border-border bg-surface px-4 font-ui text-xs text-muted"
    role="contentinfo"
    aria-label="Status bar"
    data-test="status-bar"
  >
    <span
      v-if="wordCount !== undefined"
      class="tabular-nums text-muted"
      data-test="status-word-count"
    >
      {{ wordLine }}
    </span>
    <button
      v-if="trackChanges !== undefined"
      type="button"
      class="border-0 bg-transparent p-0 font-ui text-xs text-muted cursor-pointer hover:text-text"
      data-test="status-track-changes"
      :aria-pressed="trackChanges ? 'true' : 'false'"
      @click="emit('toggle-track-changes')"
    >
      {{ trackLabel }}
    </button>
    <span class="flex-1" aria-hidden="true" />
    <span
      v-if="save && save.phase !== 'idle'"
      role="status"
      aria-live="polite"
      class="flex items-center gap-1.5"
      data-test="status-save"
      :data-state="save.phase"
    >
      <template v-if="save.phase === 'error'">
        <span class="text-danger">{{ saveLabel }}</span>
        <button
          type="button"
          class="border-0 bg-transparent p-0 font-ui text-xs font-medium text-danger underline cursor-pointer"
          data-test="status-save-retry"
          @click="emit('save-retry')"
        >
          Retry
        </button>
      </template>
      <template v-else>
        <svg
          v-if="save.phase === 'saved'"
          class="size-3 fill-none stroke-current stroke-[1.8] text-muted [stroke-linecap:round] [stroke-linejoin:round]"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
        <span :class="save.phase === 'saving' ? 'text-muted' : 'text-muted'">{{ saveLabel }}</span>
      </template>
    </span>
    <button
      v-if="storyNotesPanelId"
      type="button"
      class="border-0 bg-transparent p-0 font-ui text-xs font-medium text-text cursor-pointer hover:text-accent"
      data-test="status-notes-toggle"
      :aria-pressed="storyNotesOpen ? 'true' : 'false'"
      :aria-controls="storyNotesPanelId"
      @click="emit('toggle-story-notes')"
    >
      Story notes
    </button>
  </footer>
</template>
