<script setup lang="ts">
/**
 * One scrollable manuscript (#107): every section's doc is visible in reading order. The active
 * section owns the shared toolbar, review rail, and status bar; scroll-spy keeps the outline in sync.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { Section } from '@coauthor/schema';
import type * as Y from 'yjs';
import type { CommentRow } from '@coauthor/editor';
import ManuscriptEditor from './ManuscriptEditor.vue';
import { sectionReviewMeta } from './backend';
import { sectionsInReadingOrder } from './manuscript-reading-order';
import type { SaveState } from './status/StatusBar.vue';
import type { EditorLayout } from './desk/outline-auto-collapse';
import type { AgentName } from './agent-names';
import type { DecisionRecord } from '@coauthor/editor';

const REVIEW_RAIL = '#continuous-review-rail';
const STATUS_RAIL = '#continuous-status-rail';

const props = defineProps<{
  outline: Section[];
  sections: Map<string, Y.Doc>;
  selectedId?: string;
  reloadToken: number;
  readonly?: boolean;
  readOnlyReason?: string;
  navigatorOpen?: boolean;
  navigatorControls?: string;
  chapterTitle?: string;
  sectionLabels?: ReadonlyMap<string, string>;
  bookDocs?: readonly Y.Doc[];
  chapterDocs?: Y.Doc[];
  saveState?: SaveState;
  authorLabels?: (author: string) => AgentName;
  toolbarTarget?: string;
  externalLoadError?: boolean;
  outlineForced?: boolean;
  notesHidden?: boolean;
  /** From `getAppInfo`; seeds track-changes writer name (#57). */
  computerName?: string;
  /** Persisted review decisions keyed by section id (#51). */
  decisionRecordsBySection?: Readonly<Record<string, DecisionRecord[]>>;
}>();

const commentRows = shallowRef<readonly CommentRow[]>([]);
const authorSavedNames = shallowRef<Readonly<Record<string, string>>>({});
const suggestionReasons = shallowRef<Readonly<Record<string, string>>>({});

watch(
  () => props.selectedId,
  async (sectionId) => {
    if (!sectionId) {
      commentRows.value = [];
      authorSavedNames.value = {};
      suggestionReasons.value = {};
      return;
    }
    try {
      const meta = await sectionReviewMeta(sectionId);
      commentRows.value = meta.comments;
      authorSavedNames.value = meta.authorSavedNames;
      suggestionReasons.value = meta.suggestionReasons;
    } catch (err) {
      console.error('Could not load review sidebar metadata', err);
      commentRows.value = [];
      authorSavedNames.value = {};
      suggestionReasons.value = {};
    }
  },
  { immediate: true },
);

const emit = defineEmits<{
  'update:selectedId': [id: string];
  reload: [];
  'toggle-navigator': [];
  decisions: [sectionId: string, records: DecisionRecord[]];
  'focus-mode': [on: boolean];
  'load-error': [message: string];
  layout: [layout: EditorLayout];
  'ask-bot': [];
}>();

const ordered = computed(() => sectionsInReadingOrder(props.outline));
const scrollRoot = shallowRef<HTMLElement | null>(null);
const editors = shallowRef(new Map<string, InstanceType<typeof ManuscriptEditor>>());
const chromeLayout = ref<EditorLayout | null>(null);
const reviewRailShown = computed(
  () => chromeLayout.value?.reviewShown && !chromeLayout.value?.focusMode,
);
let spyFromScroll = false;
let observer: IntersectionObserver | undefined;

function bindObserver() {
  observer?.disconnect();
  const root = scrollRoot.value;
  if (!root) return;
  observer = new IntersectionObserver(
    (entries) => {
      const hit = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const id = hit?.target.getAttribute('data-section-anchor');
      if (id && id !== props.selectedId) {
        spyFromScroll = true;
        emit('update:selectedId', id);
      }
    },
    { root, rootMargin: '-20% 0px -55% 0px', threshold: [0, 0.25, 0.5, 0.75] },
  );
  root.querySelectorAll('[data-section-anchor]').forEach((el) => observer!.observe(el));
}

function setEditorRef(id: string, el: unknown) {
  if (el) editors.value.set(id, el as InstanceType<typeof ManuscriptEditor>);
  else editors.value.delete(id);
}

function scrollToSection(id: string) {
  const root = scrollRoot.value;
  if (!root) return;
  const el = root.querySelector(`[data-section-anchor="${id}"]`);
  el?.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function onLeadLayout(layout: EditorLayout) {
  chromeLayout.value = layout;
  emit('layout', layout);
}

watch(
  () => props.selectedId,
  (id, prev) => {
    if (!id || spyFromScroll) {
      spyFromScroll = false;
      return;
    }
    if (id !== prev) void nextTick(() => scrollToSection(id));
  },
);

watch(
  () => props.selectedId,
  (id) => {
    if (!id) return;
    void nextTick(() => editors.value.get(id)?.reportLoadError());
  },
);

function focusSection(id: string) {
  editors.value.get(id)?.focusBody();
}

defineExpose({
  focusBody() {
    if (props.selectedId) focusSection(props.selectedId);
  },
  focusSection,
});

onMounted(async () => {
  await nextTick();
  bindObserver();
});

watch(ordered, async () => {
  await nextTick();
  bindObserver();
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="continuous-root min-h-0 flex h-full flex-col" data-test="continuous-root">
    <div
      class="continuous-layout min-h-0 flex-1"
      :class="{ 'continuous-layout--solo': !reviewRailShown }"
    >
      <div
        ref="scrollRoot"
        class="continuous-manuscript min-h-0 overflow-auto"
        data-test="continuous-manuscript"
      >
        <div
          v-for="sec in ordered"
          :key="`${sec.docId}#${reloadToken}`"
          :data-section-anchor="sec.id"
          :data-test="sec.id === selectedId ? 'lead-editor' : 'continuous-section'"
          class="continuous-section"
        >
          <ManuscriptEditor
            v-if="sections.get(sec.docId)"
            :ref="(el) => setEditorRef(sec.id, el)"
            :doc="sections.get(sec.docId)"
            :readonly="readonly"
            :read-only-reason="readOnlyReason"
            :navigator-open="navigatorOpen"
            :navigator-controls="navigatorControls"
            :slice-mode="sec.id !== selectedId"
            :toolbar-target="sec.id === selectedId ? toolbarTarget : undefined"
            :review-target="sec.id === selectedId ? REVIEW_RAIL : undefined"
            :status-target="sec.id === selectedId ? STATUS_RAIL : undefined"
            :chapter-title="sec.id === selectedId ? chapterTitle : undefined"
            :chapter-label="sectionLabels?.get(sec.id)"
            :book-docs="sec.id === selectedId ? bookDocs : undefined"
            :chapter-docs="sec.id === selectedId ? chapterDocs : undefined"
            :save-state="sec.id === selectedId ? saveState : undefined"
            :author-labels="authorLabels"
            :comment-rows="sec.id === selectedId ? commentRows : []"
            :author-saved-names="sec.id === selectedId ? authorSavedNames : undefined"
            :suggestion-reasons="sec.id === selectedId ? suggestionReasons : undefined"
            :external-load-error="externalLoadError"
            :outline-forced="outlineForced"
            :notes-hidden="notesHidden"
            :computer-name="computerName"
            :decision-records="decisionRecordsBySection?.[sec.id] ?? []"
            @reload="emit('reload')"
            @toggle-navigator="emit('toggle-navigator')"
            @decisions="(records) => emit('decisions', sec.id, records)"
            @focus-mode="emit('focus-mode', $event)"
            @load-error="(msg) => sec.id === selectedId && emit('load-error', msg)"
            @layout="(layout) => sec.id === selectedId && onLeadLayout(layout)"
            @ask-bot="emit('ask-bot')"
          />
        </div>
      </div>
      <div
        id="continuous-review-rail"
        class="continuous-review-rail min-h-0"
        data-test="continuous-review-rail"
      />
    </div>
    <div
      id="continuous-status-rail"
      class="continuous-status-rail"
      data-test="continuous-status-rail"
    />
  </div>
</template>

<style scoped>
.continuous-layout {
  display: grid;
  grid-template-columns: 1fr auto;
  min-height: 0;
}
.continuous-layout--solo {
  grid-template-columns: 1fr;
}
.continuous-review-rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.continuous-section + .continuous-section {
  border-top: 1px solid var(--ct-border-subtle);
}
</style>
