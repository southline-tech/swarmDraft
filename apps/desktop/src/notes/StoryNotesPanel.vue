<script setup lang="ts">
/**
 * Story notes under the draft (#38): ordered notes with title, rich body, optional chapter link.
 */
import { computed, onUnmounted, ref, shallowRef, watch, watchEffect } from 'vue';
import type { Section } from '@coauthor/schema';
import type * as Y from 'yjs';
import EmptyState from '../shells/EmptyState.vue';
import AppIcon from '../icons/AppIcon.vue';
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
import {
  notesSaveStatus,
  retryNotesSave,
  type NotesSavePhase,
} from './persist';

const SAVED_CHECK_MS = 2500;

function saveStatusLabel(phase: NotesSavePhase, savedAt: number | null, nowMs: number) {
  if (phase === 'idle') return null;
  if (phase === 'saving') return { kind: 'saving' as const, text: 'Saving…' };
  if (phase === 'error') return { kind: 'error' as const, text: "Couldn't save. Retrying…" };
  if (phase === 'saved' && savedAt != null) {
    const age = nowMs - savedAt;
    if (age < SAVED_CHECK_MS) return { kind: 'saved' as const, text: 'Saved', check: true };
    if (age < 60_000) return { kind: 'relative' as const, text: 'Saved just now' };
    const mins = Math.floor(age / 60_000);
    return { kind: 'relative' as const, text: `Saved ${mins} min ago` };
  }
  return null;
}

const props = defineProps<{
  notesDoc: Y.Doc;
  outline: Section[];
  readonly?: boolean;
  humanAuthor: { id: string; name: string };
}>();

const emit = defineEmits<{ 'select-section': [sectionId: string]; close: [] }>();

const notes = shallowRef<NoteMeta[]>([]);
const selectedId = ref<string>();

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

const saveStatus = ref<{ phase: NotesSavePhase; savedAt: number | null }>({
  phase: 'idle',
  savedAt: null,
});
watchEffect(() => {
  const v = notesSaveStatus(props.notesDoc).value;
  saveStatus.value = { phase: v.phase, savedAt: v.savedAt };
});
const nowMs = ref(Date.now());
let saveTick: ReturnType<typeof setInterval> | undefined;
watch(
  () => saveStatus.value.phase,
  (phase) => {
    if (saveTick) clearInterval(saveTick);
    saveTick = undefined;
    if (phase === 'saved' || phase === 'saving') {
      nowMs.value = Date.now();
      saveTick = setInterval(() => {
        nowMs.value = Date.now();
      }, 10_000);
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  if (saveTick) clearInterval(saveTick);
});

const saveLabel = computed(() =>
  saveStatusLabel(saveStatus.value.phase, saveStatus.value.savedAt, nowMs.value),
);
</script>

<template>
  <aside class="story-notes" aria-label="Story notes" data-test="story-notes">
    <header class="story-notes__head">
      <h2>Story notes</h2>
      <div class="story-notes__actions">
        <button
          type="button"
          class="sh-btn"
          data-test="new-note"
          :disabled="readonly"
          @click="onNewNote"
        >
          New note
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
        <header v-if="saveLabel" class="story-notes__detail-head">
          <div
            class="story-notes__save"
            role="status"
            aria-live="polite"
            data-test="notes-save-status"
            :data-state="saveStatus.phase"
          >
            <template v-if="saveLabel.kind === 'saving' || saveLabel.kind === 'relative'">
              <span class="story-notes__save-text story-notes__save-text--muted">{{
                saveLabel.text
              }}</span>
            </template>
            <template v-else-if="saveLabel.kind === 'saved'">
              <svg class="story-notes__save-check" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
              <span class="story-notes__save-text story-notes__save-text--ok">{{ saveLabel.text }}</span>
            </template>
            <template v-else-if="saveLabel.kind === 'error'">
              <span class="story-notes__save-text story-notes__save-text--err">{{ saveLabel.text }}</span>
              <button
                type="button"
                class="story-notes__retry"
                data-test="notes-save-retry"
                @click="retryNotesSave(notesDoc)"
              >
                Retry
              </button>
            </template>
          </div>
        </header>
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
.story-notes__actions {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  flex-shrink: 0;
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

.story-notes__detail-head {
  display: flex;
  justify-content: flex-end;
  min-height: var(--ct-space-5);
}
.story-notes__save {
  display: flex;
  align-items: center;
  gap: var(--ct-space-1);
  font-size: var(--ct-text-xs);
}
.story-notes__save-text--muted {
  color: var(--ct-text-muted);
}
.story-notes__save-text--ok {
  color: var(--ct-success);
  font-weight: var(--ct-weight-medium);
}
.story-notes__save-text--err {
  color: var(--ct-danger);
}
.story-notes__save-check {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: var(--ct-success);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex-shrink: 0;
}
.story-notes__retry {
  font: inherit;
  font-size: var(--ct-text-xs);
  font-weight: var(--ct-weight-medium);
  padding: var(--ct-space-1) var(--ct-space-2);
  border: 1px solid var(--ct-danger);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-danger-bg);
  color: var(--ct-danger);
  cursor: pointer;
}
.story-notes__retry:hover {
  filter: brightness(0.97);
}
.story-notes__retry:focus-visible {
  outline: 2px solid var(--ct-focus-ring-color);
  outline-offset: 2px;
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
