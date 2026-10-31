<script setup lang="ts">
/**
 * Story notes beside the draft (#38): ordered notes with title, rich body, optional chapter link.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import type { Section } from '@coauthor/schema';
import type * as Y from 'yjs';
import EmptyState from '../shells/EmptyState.vue';
import { agentName } from '../agent-names';
import { collabColor } from '../author-colors';
import NoteBodyEditor from './NoteBodyEditor.vue';
import {
  addNote,
  listNotes,
  observeNotes,
  updateNoteSectionLink,
  updateNoteTitle,
  type NoteMeta,
} from './doc';

const props = defineProps<{
  notesDoc: Y.Doc;
  outline: Section[];
  readonly?: boolean;
  humanAuthor: { id: string; name: string };
}>();

const emit = defineEmits<{ 'select-section': [sectionId: string] }>();

const notes = shallowRef<NoteMeta[]>([]);
const selectedId = ref<string>();
const root = ref<HTMLElement>();

const refresh = () => {
  notes.value = listNotes(props.notesDoc);
  if (selectedId.value && !notes.value.some((n) => n.id === selectedId.value)) {
    selectedId.value = notes.value[0]?.id;
  }
  if (!selectedId.value && notes.value.length) selectedId.value = notes.value[0]!.id;
};

watch(() => props.notesDoc, refresh, { immediate: true });
watch(
  () => props.notesDoc,
  (doc, _prev, onCleanup) => {
    const off = observeNotes(doc, refresh);
    onCleanup(off);
  },
  { immediate: true },
);

const selected = computed(() => notes.value.find((n) => n.id === selectedId.value));

function labelOf(n: NoteMeta) {
  if (n.authorKind === 'agent') {
    return agentName(n.authorId, n.authorName);
  }
  return { name: n.authorName, note: undefined, agent: false };
}

function colorKey(n: NoteMeta) {
  return n.authorKind === 'agent' ? `agent:${n.authorId}` : n.authorName;
}

function onNewNote() {
  const meta = addNote(props.notesDoc, {
    kind: 'human',
    id: props.humanAuthor.id,
    name: props.humanAuthor.name,
  });
  refresh();
  selectedId.value = meta.id;
}

function onTitleInput(e: Event) {
  const id = selectedId.value;
  if (!id) return;
  updateNoteTitle(props.notesDoc, id, (e.target as HTMLInputElement).value);
}

function onSectionChange(e: Event) {
  const id = selectedId.value;
  if (!id) return;
  const v = (e.target as HTMLSelectElement).value;
  updateNoteSectionLink(props.notesDoc, id, v || null);
}

const sectionOptions = computed(() =>
  props.outline.filter((s) => s.kind === 'chapter' || s.kind === 'front_matter'),
);
</script>

<template>
  <aside class="story-notes" aria-label="Story notes" data-test="story-notes">
    <header class="story-notes__head">
      <h2>Story notes</h2>
      <button
        type="button"
        class="sh-btn"
        data-test="new-note"
        :disabled="readonly"
        @click="onNewNote"
      >
        New note
      </button>
    </header>
    <EmptyState
      v-if="!notes.length"
      data-test="empty"
      icon="sparkle"
      title="No story notes yet"
      text="Capture planning notes, character reminders, or research beside your draft."
    />
    <div v-else class="story-notes__body">
      <ul class="story-notes__list" data-test="note-list">
        <li v-for="n in notes" :key="n.id">
          <button
            type="button"
            class="story-notes__row"
            :class="{ 'story-notes__row--sel': n.id === selectedId }"
            data-test="note-row"
            @click="selectedId = n.id"
          >
            <span class="story-notes__title">{{ n.title || 'Untitled note' }}</span>
            <span
              class="story-notes__author agent-label"
              :style="{ borderLeftColor: collabColor(colorKey(n)) }"
              data-test="note-author"
            >
              <bdi class="agent-name" dir="auto">{{ labelOf(n).name }}</bdi>
              <span v-if="labelOf(n).agent" class="agent-tag" data-test="agent-tag">Bot</span>
            </span>
          </button>
        </li>
      </ul>
      <section v-if="selected" class="story-notes__detail" data-test="note-detail">
        <label class="story-notes__field">
          <span>Title</span>
          <input
            data-test="note-title"
            :value="selected.title"
            :readonly="readonly"
            @input="onTitleInput"
          />
        </label>
        <label class="story-notes__field">
          <span>Linked chapter</span>
          <select
            data-test="note-section"
            :value="selected.sectionId ?? ''"
            :disabled="readonly"
            @change="onSectionChange"
          >
            <option value="">None</option>
            <option v-for="s in sectionOptions" :key="s.id" :value="s.id">
              {{ s.title }}
            </option>
          </select>
        </label>
        <button
          v-if="selected.sectionId"
          type="button"
          class="sh-btn sh-btn--sm story-notes__jump"
          data-test="note-jump"
          @click="emit('select-section', selected.sectionId!)"
        >
          Go to linked chapter
        </button>
        <label class="story-notes__field">
          <span>Body</span>
          <NoteBodyEditor
            :key="selected.id"
            :notes-doc="notesDoc"
            :note-id="selected.id"
            :readonly="readonly"
          />
        </label>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.story-notes {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
  min-height: 0;
  min-width: 0;
  padding: var(--ct-space-3);
  background: var(--ct-surface);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  font-family: var(--ct-font-ui);
}
.story-notes__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ct-space-2);
}
.story-notes__head h2 {
  margin: 0;
  font-size: var(--ct-text-md);
  font-weight: var(--ct-weight-semibold);
}
.story-notes__body {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-3);
  min-height: 0;
  overflow: auto;
}
.story-notes__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-1);
}
.story-notes__row {
  width: 100%;
  text-align: left;
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-paper);
  padding: var(--ct-space-2);
  cursor: pointer;
  color: var(--ct-text);
}
.story-notes__row--sel {
  border-color: var(--ct-accent);
  background: var(--ct-selected-bg);
}
.story-notes__title {
  display: block;
  font-weight: var(--ct-weight-medium);
}
.story-notes__author {
  display: block;
  margin-top: var(--ct-space-1);
  font-size: var(--ct-text-xs);
  border-left: 3px solid;
  padding-left: var(--ct-space-1);
  color: var(--ct-text-muted);
}
.story-notes__detail {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
  min-height: 0;
}
.story-notes__field {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-1);
  font-size: var(--ct-text-sm);
  color: var(--ct-text-muted);
}
.story-notes__field input,
.story-notes__field select {
  font: inherit;
  color: var(--ct-text);
  background: var(--ct-paper);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-sm);
  padding: var(--ct-space-1) var(--ct-space-2);
}
.story-notes__jump {
  align-self: flex-start;
}
</style>
