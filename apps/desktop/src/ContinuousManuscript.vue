<script setup lang="ts">
/**
 * One scrollable manuscript (#107): every section's doc is visible in reading order. The active
 * section owns the shared toolbar and status bar; scroll-spy keeps the outline selection in sync.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import type { Section } from '@coauthor/schema';
import type * as Y from 'yjs';
import ManuscriptEditor from './ManuscriptEditor.vue';
import { sectionsInReadingOrder } from './manuscript-reading-order';
import type { SaveState } from './status/StatusBar.vue';
import type { EditorLayout } from './desk/outline-auto-collapse';
import type { AgentName } from './agent-names';
import type { DecisionRecord } from '@coauthor/editor';

const props = defineProps<{
  outline: Section[];
  sections: Map<string, Y.Doc>;
  selectedId?: string;
  reloadToken: number;
  readonly?: boolean;
  readOnlyReason?: string;
  navigatorOpen?: boolean;
  chapterTitle?: string;
  chapterLabel?: string;
  bookDocs?: readonly Y.Doc[];
  chapterDocs?: Y.Doc[];
  saveState?: SaveState;
  authorLabels?: (author: string) => AgentName;
  toolbarTarget?: string;
  externalLoadError?: boolean;
  outlineForced?: boolean;
  notesHidden?: boolean;
}>();

const emit = defineEmits<{
  'update:selectedId': [id: string];
  reload: [];
  'toggle-navigator': [];
  decisions: [records: DecisionRecord[]];
  'focus-mode': [on: boolean];
  'load-error': [message: string];
  layout: [layout: EditorLayout];
}>();

const ordered = computed(() => sectionsInReadingOrder(props.outline));
const scrollRoot = shallowRef<HTMLElement | null>(null);
const editors = shallowRef(new Map<string, InstanceType<typeof ManuscriptEditor>>());
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
        :slice-mode="sec.id !== selectedId"
        :toolbar-target="sec.id === selectedId ? toolbarTarget : undefined"
        :chapter-title="sec.id === selectedId ? chapterTitle : undefined"
        :chapter-label="sec.id === selectedId ? chapterLabel : undefined"
        :book-docs="sec.id === selectedId ? bookDocs : undefined"
        :chapter-docs="sec.id === selectedId ? chapterDocs : undefined"
        :save-state="sec.id === selectedId ? saveState : undefined"
        :author-labels="authorLabels"
        :external-load-error="externalLoadError"
        :outline-forced="outlineForced"
        :notes-hidden="notesHidden"
        @reload="emit('reload')"
        @toggle-navigator="emit('toggle-navigator')"
        @decisions="emit('decisions', $event)"
        @focus-mode="emit('focus-mode', $event)"
        @load-error="(msg) => sec.id === selectedId && emit('load-error', msg)"
        @layout="(layout) => sec.id === selectedId && emit('layout', layout)"
      />
    </div>
  </div>
</template>

<style scoped>
.continuous-section + .continuous-section {
  border-top: 1px solid var(--ct-border-subtle);
}
</style>
