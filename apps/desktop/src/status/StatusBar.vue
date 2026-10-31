<script setup lang="ts">
/**
 * Window status footer (#204): word count, track-changes readout, save status, Story notes toggle,
 * zoom (− / % / +). 26px tall.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { formatWords as words, formatCount } from './wordcount';
import { saveStatusLabel, type ManuscriptSaveView } from './save-status';
import StatusBarZoom from './StatusBarZoom.vue';

const props = defineProps<{
  /** Whole-book or current-chapter count when book total is unavailable. */
  wordCount?: number;
  selectionWords?: number;
  trackChanges?: boolean;
  save?: ManuscriptSaveView;
  storyNotesOpen?: boolean;
  /** Target panel for `aria-controls` on the Story notes toggle. */
  storyNotesPanelId?: string;
  /** Page zoom percent; when set, footer shows zoom after Story notes. */
  zoom?: number;
}>();

const emit = defineEmits<{
  'toggle-story-notes': [];
  'save-retry': [];
  'update:zoom': [value: number];
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

const selectionSuffix = computed(() => {
  if (!props.selectionWords) return '';
  const n = props.selectionWords;
  return ` · ${n === 1 ? '1 selected' : `${formatCount(n)} selected`}`;
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
    <span v-if="wordCount !== undefined" class="tabular-nums" data-test="status-word-count">
      <span class="text-muted">{{ words(wordCount) }}</span
      ><span v-if="selectionWords" class="text-text">{{ selectionSuffix }}</span>
    </span>
    <span
      v-if="trackChanges !== undefined"
      class="font-ui text-xs text-muted"
      data-test="status-track-changes"
    >
      {{ trackLabel }}
    </span>
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
          class="status-bar__retry"
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
      class="border-0 bg-transparent p-0 font-ui text-xs font-medium text-text cursor-pointer hover:text-accent aria-pressed:bg-selected aria-pressed:text-accent"
      data-test="status-notes-toggle"
      :aria-pressed="storyNotesOpen ? 'true' : 'false'"
      :aria-controls="storyNotesPanelId"
      @click="emit('toggle-story-notes')"
    >
      Story notes
    </button>
    <template v-if="zoom !== undefined">
      <span v-if="storyNotesPanelId" class="status-bar__sep" aria-hidden="true" />
      <StatusBarZoom :model-value="zoom" @update:model-value="emit('update:zoom', $event)" />
    </template>
  </footer>
</template>

<style scoped>
.status-bar__sep {
  flex: none;
  align-self: center;
  width: 1px;
  height: 12px;
  background: var(--ct-border);
}
.status-bar__retry {
  padding: 0 var(--ct-space-2);
  border: 1px solid var(--ct-danger);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-danger-bg);
  color: var(--ct-danger);
  font: inherit;
  font-size: inherit;
  cursor: pointer;
}
.status-bar__retry:focus-visible {
  outline: none;
  box-shadow: var(--ct-focus-ring);
}
</style>
