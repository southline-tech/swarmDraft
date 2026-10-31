<script setup lang="ts">
/**
 * Window status footer (#204, #207): three segments under the workspace columns; word count,
 * page estimate (#216), save, zoom in the center; track changes and Story notes on the right.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { formatWords as words, formatCount } from './wordcount';
import { saveStatusLabel, type ManuscriptSaveView } from './save-status';
import {
  estimatedCurrentPage,
  estimatedPageTotal,
  pageStatusLabel,
  PAGE_ESTIMATE_TOOLTIP,
} from './pageEstimate';
import StatusBarZoom from './StatusBarZoom.vue';

const props = defineProps<{
  chapterCount?: number;
  /** When false, the left segment is hidden (chapter list collapsed / hidden). */
  showChapterSegment?: boolean;
  /** CSS grid track sizes matching the workspace (e.g. `18rem 1fr`). */
  columnTracks?: string;
  wordCount?: number;
  selectionWords?: number;
  wordsBeforeCaretInBook?: number;
  trackChanges?: boolean;
  save?: ManuscriptSaveView;
  storyNotesOpen?: boolean;
  storyNotesPanelId?: string;
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

const centerSeg = ref<HTMLElement | null>(null);
const centerNarrow = ref(false);
let centerObserver: ResizeObserver | undefined;
onMounted(() => {
  if (!centerSeg.value || typeof ResizeObserver === 'undefined') return;
  centerObserver = new ResizeObserver(() => {
    centerNarrow.value = (centerSeg.value?.clientWidth ?? 999) < 420;
  });
  centerObserver.observe(centerSeg.value);
});
onBeforeUnmount(() => centerObserver?.disconnect());

const saveLabel = computed(() => (props.save ? saveStatusLabel(props.save, now.value) : ''));

const selectionSuffix = computed(() => {
  if (!props.selectionWords) return '';
  const n = props.selectionWords;
  if (centerNarrow.value) return ` · ${formatCount(n)}`;
  return ` · ${n === 1 ? '1 selected' : `${formatCount(n)} selected`}`;
});

const trackLabel = computed(() =>
  props.trackChanges ? 'Track changes: On' : 'Track changes: Off',
);

const pageReadout = computed(() => {
  const bookWords = props.wordCount ?? 0;
  const before = props.wordsBeforeCaretInBook ?? 0;
  const total = estimatedPageTotal(bookWords);
  const current = estimatedCurrentPage(before, bookWords);
  return pageStatusLabel(current, total, centerNarrow.value);
});

const showTrackChangesReadout = computed(
  () =>
    props.trackChanges !== undefined &&
    !centerNarrow.value &&
    (!props.storyNotesPanelId || props.storyNotesOpen),
);

const chapterLabel = computed(() => {
  const n = props.chapterCount ?? 0;
  return `${formatCount(n)} ${n === 1 ? 'chapter' : 'chapters'}`;
});

const footerStyle = computed(() =>
  props.columnTracks ? { gridTemplateColumns: props.columnTracks } : undefined,
);
</script>

<template>
  <footer
    class="status-bar"
    role="contentinfo"
    aria-label="Status bar"
    data-test="status-bar"
    :style="footerStyle"
  >
    <div
      v-if="showChapterSegment && chapterCount !== undefined"
      class="status-seg status-seg-left"
      data-test="status-seg-left"
    >
      <span class="status-bar__muted tabular-nums" data-test="status-chapter-count">{{
        chapterLabel
      }}</span>
    </div>
    <div ref="centerSeg" class="status-seg status-seg-center" data-test="status-seg-center">
      <span
        v-if="wordCount !== undefined"
        class="status-bar__cluster tabular-nums"
        data-test="status-word-count"
      >
        <span class="status-bar__muted">{{ words(wordCount) }}</span
        ><span v-if="selectionWords" class="status-bar__text">{{ selectionSuffix }}</span>
      </span>
      <span
        v-if="wordCount !== undefined"
        class="status-bar__page status-bar__muted tabular-nums"
        data-test="status-page"
        :title="PAGE_ESTIMATE_TOOLTIP"
        :aria-label="pageReadout.ariaLabel"
      >
        {{ pageReadout.visible }}
      </span>
      <span
        v-if="save && save.phase !== 'idle'"
        role="status"
        aria-live="polite"
        class="status-bar__cluster status-bar__save"
        data-test="status-save"
        :data-state="save.phase"
      >
        <template v-if="save.phase === 'error'">
          <span class="status-bar__danger">{{ saveLabel }}</span>
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
            class="status-bar__check"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
          <span class="status-bar__muted">{{ saveLabel }}</span>
        </template>
      </span>
      <span class="status-seg-center__spacer" aria-hidden="true" />
      <StatusBarZoom
        v-if="zoom !== undefined"
        :model-value="zoom"
        :compact="centerNarrow"
        @update:model-value="emit('update:zoom', $event)"
      />
    </div>
    <div class="status-seg status-seg-right" data-test="status-seg-right">
      <span
        v-if="showTrackChangesReadout"
        class="status-bar__muted"
        data-test="status-track-changes"
      >
        {{ trackLabel }}
      </span>
      <button
        v-if="storyNotesPanelId"
        type="button"
        class="status-bar__notes-toggle"
        data-test="status-notes-toggle"
        :aria-pressed="storyNotesOpen ? 'true' : 'false'"
        :aria-controls="storyNotesPanelId"
        @click="emit('toggle-story-notes')"
      >
        Story notes
      </button>
    </div>
  </footer>
</template>

<style scoped>
.status-bar {
  box-sizing: border-box;
  display: grid;
  flex: none;
  height: 26px;
  overflow: hidden;
  border-top: 1px solid var(--ct-border);
  background: var(--ct-surface);
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-xs);
  color: var(--ct-text-muted);
}
.status-seg {
  display: flex;
  align-items: center;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  white-space: nowrap;
}
.status-seg-left {
  padding: 0 var(--ct-space-4);
  border-right: 1px solid var(--ct-border);
}
.status-seg-center {
  gap: var(--ct-space-4);
  padding: 0 var(--ct-space-4);
  border-right: 1px solid var(--ct-border);
}
.status-seg-center__spacer {
  flex: 1;
  min-width: 0;
}
.status-seg-right {
  gap: var(--ct-space-4);
  padding: 0 var(--ct-space-3) 0 var(--ct-space-4);
  padding-right: 12px;
}
.status-bar__cluster {
  display: inline-flex;
  align-items: center;
  gap: var(--ct-space-1);
}
.status-bar__muted {
  color: var(--ct-text-muted);
}
.status-bar__text {
  color: var(--ct-text);
}
.status-bar__danger {
  color: var(--ct-danger);
}
.status-bar__page {
  flex: none;
}
.status-bar__check {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--ct-text-muted);
}
.status-bar__notes-toggle {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: inherit;
  font-weight: var(--ct-weight-medium);
  color: var(--ct-text);
  cursor: pointer;
}
.status-bar__notes-toggle:hover {
  color: var(--ct-accent);
}
.status-bar__notes-toggle[aria-pressed='true'] {
  background: var(--ct-selected-bg);
  color: var(--ct-accent);
}
.status-bar__notes-toggle:focus-visible {
  outline: none;
  box-shadow: var(--ct-focus-ring);
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
