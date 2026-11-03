<script setup lang="ts">
/**
 * Story notes under the draft (#38): view-only cards; edit in modal (#278).
 */
import { computed, ref, shallowRef, watch } from 'vue';
import type { Section } from '@swarmdraft/schema';
import type * as Y from 'yjs';
import EmptyState from '../shells/EmptyState.vue';
import AppIcon from '../icons/AppIcon.vue';
import { noteBodyPreview } from './body-preview';
import { listNotes, observeNotes, NOTE_TYPES, type NoteMeta, type NoteType } from './doc';
import { NOTE_TYPE_LABELS } from './note-type-labels';

const props = defineProps<{
  notesDoc: Y.Doc;
  outline: Section[];
  readonly?: boolean;
  humanAuthor: { id: string; name: string };
}>();

const emit = defineEmits<{
  close: [];
  'select-section': [sectionId: string];
  create: [from: HTMLElement | undefined];
  edit: [payload: { note: NoteMeta; from?: HTMLElement }];
}>();

const notes = shallowRef<NoteMeta[]>([]);
const typeFilter = ref<NoteType | 'all'>('all');
const previewRev = ref(0);

const refresh = () => {
  notes.value = listNotes(props.notesDoc);
  previewRev.value += 1;
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

const filtered = computed(() => {
  if (typeFilter.value === 'all') return notes.value;
  return notes.value.filter((n) => n.noteType === typeFilter.value);
});

function sectionTitle(id: string): string {
  return props.outline.find((s) => s.id === id)?.title ?? id;
}

function previewFor(id: string): string {
  void previewRev.value;
  return noteBodyPreview(props.notesDoc, id);
}

function onNew(from: Event) {
  emit('create', from.currentTarget as HTMLElement | undefined);
}

function openEdit(note: NoteMeta, from?: HTMLElement) {
  emit('edit', { note, from });
}

function onCardKeydown(e: KeyboardEvent, note: NoteMeta) {
  if (e.key === 'Enter') {
    e.preventDefault();
    openEdit(note, e.currentTarget as HTMLElement);
  }
}

function onCardDblclick(note: NoteMeta, el: EventTarget | null) {
  openEdit(note, el as HTMLElement | undefined);
}
</script>

<template>
  <aside class="story-notes" aria-label="Story notes" data-test="story-notes">
    <header class="story-notes__head">
      <h2>Story notes</h2>
      <div class="story-notes__actions">
        <label class="story-notes__filter">
          <span class="visually-hidden">Filter by type</span>
          <select v-model="typeFilter" data-test="note-type-filter">
            <option value="all">All types</option>
            <option v-for="t in NOTE_TYPES" :key="t" :value="t">{{ NOTE_TYPE_LABELS[t] }}</option>
          </select>
        </label>
        <button
          type="button"
          class="sh-btn"
          data-test="new-note"
          :disabled="readonly"
          @click="onNew"
        >
          + New note
        </button>
        <button
          type="button"
          class="sh-tbtn sh-icon"
          data-test="story-notes-close"
          aria-label="Close story notes"
          @click="emit('close')"
        >
          <AppIcon name="x" />
        </button>
      </div>
    </header>
    <EmptyState
      v-if="!filtered.length"
      data-test="empty"
      icon="sparkle"
      :title="notes.length ? 'No notes match this filter' : 'No story notes yet'"
      text="Capture planning notes, character reminders, or research beside your draft."
    />
    <ul v-else class="story-notes__list" data-test="note-list">
      <li v-for="n in filtered" :key="n.id">
        <article
          class="story-notes__card"
          tabindex="0"
          data-test="note-card"
          @keydown="onCardKeydown($event, n)"
          @dblclick="onCardDblclick(n, $event.currentTarget)"
        >
          <div class="story-notes__card-head">
            <span class="story-notes__pill" data-test="note-type-pill">{{
              NOTE_TYPE_LABELS[n.noteType]
            }}</span>
            <button
              type="button"
              class="story-notes__edit sh-tbtn sh-icon"
              data-test="note-edit"
              aria-label="Edit note"
              :disabled="readonly"
              @click="openEdit(n, $event.currentTarget as HTMLElement)"
            >
              <AppIcon name="pencil" />
            </button>
          </div>
          <h3 class="story-notes__card-title">{{ n.title || 'Untitled note' }}</h3>
          <p class="story-notes__preview" data-test="note-preview">{{ previewFor(n.id) }}</p>
          <p v-if="n.sectionIds.length" class="story-notes__chapters" data-test="note-chapters">
            <button
              v-for="sid in n.sectionIds"
              :key="sid"
              type="button"
              class="story-notes__chapter-link"
              @click.stop="emit('select-section', sid)"
            >
              {{ sectionTitle(sid) }}
            </button>
          </p>
        </article>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.story-notes {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
  min-height: 0;
  min-width: 0;
  height: 100%;
  padding: var(--ct-space-3);
  background: transparent;
  font-family: var(--ct-font-ui);
}
.story-notes__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ct-space-2);
  flex-shrink: 0;
}
.story-notes__head h2 {
  margin: 0;
  font-size: var(--ct-text-md);
  font-weight: var(--ct-weight-semibold);
}
.story-notes__actions {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  flex-shrink: 0;
}
.story-notes__filter select {
  font: inherit;
  font-size: var(--ct-text-xs);
  padding: var(--ct-space-1) var(--ct-space-2);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-paper);
  color: var(--ct-text);
}
.story-notes__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
  min-height: 0;
  overflow: auto;
}
.story-notes__card {
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-paper);
  padding: var(--ct-space-3);
  color: var(--ct-text);
  outline: none;
}
.story-notes__card:focus-visible {
  outline: 2px solid var(--ct-focus-ring-color);
  outline-offset: 2px;
}
.story-notes__card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ct-space-2);
}
.story-notes__pill {
  font-size: var(--ct-text-xs);
  font-weight: var(--ct-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px var(--ct-space-2);
  border-radius: var(--ct-radius-full);
  border: 1px solid var(--ct-border);
  color: var(--ct-text-muted);
}
.story-notes__card-title {
  margin: var(--ct-space-2) 0 var(--ct-space-1);
  font-size: var(--ct-text-md);
  font-weight: var(--ct-weight-medium);
}
.story-notes__preview {
  margin: 0;
  font-size: var(--ct-text-sm);
  color: var(--ct-text-muted);
  line-height: var(--ct-leading-body);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.story-notes__chapters {
  margin: var(--ct-space-2) 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-1);
}
.story-notes__chapter-link {
  font: inherit;
  font-size: var(--ct-text-xs);
  padding: 2px var(--ct-space-2);
  border-radius: var(--ct-radius-full);
  border: 1px solid var(--ct-border);
  background: var(--ct-surface);
  color: var(--ct-accent);
  cursor: pointer;
}
</style>
