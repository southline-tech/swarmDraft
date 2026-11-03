<script setup lang="ts">
/**
 * Create/edit story note in a centered modal (#278).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Section } from '@swarmdraft/schema';
import type * as Y from 'yjs';
import { APP_OVERLAY_LAYER, ensureOverlayLayer } from '../overlay/layer';
import { trapTab } from '../settings/focus-trap';
import '../settings/settings.css';
import NoteBodyEditor from './NoteBodyEditor.vue';
import {
  addNote,
  bodyField,
  copyNoteBody,
  deleteNote,
  readNoteMeta,
  updateNoteSectionIds,
  updateNoteTags,
  updateNoteTitle,
  updateNoteType,
  type NoteType,
  NOTE_TYPES,
} from './doc';
import { NOTE_TYPE_LABELS } from './note-type-labels';

const DRAFT_BODY_ID = '__draft__';

const props = defineProps<{
  notesDoc: Y.Doc;
  outline: Section[];
  humanAuthor: { id: string; name: string };
  noteId: string | null;
  readonly?: boolean;
}>();

const emit = defineEmits<{ close: []; saved: []; deleted: [] }>();

const dialog = ref<HTMLElement | null>(null);
const titleInput = ref<HTMLInputElement | null>(null);
const overlayReady = ref(false);
const confirmDiscard = ref(false);

const title = ref('');
const noteType = ref<NoteType>('other');
const sectionIds = ref<string[]>([]);
const tagsText = ref('');
const draftBodyId = ref<string>(DRAFT_BODY_ID);

const initialSnapshot = ref('');

function snapshot(): string {
  return JSON.stringify({
    title: title.value.trim(),
    noteType: noteType.value,
    sectionIds: [...sectionIds.value].sort(),
    tags: tagsText.value.trim(),
  });
}

const isEdit = computed(() => props.noteId != null);
const heading = computed(() => (isEdit.value ? 'Edit note' : 'New note'));
const canSave = computed(() => title.value.trim().length > 0 && !props.readonly);
const dirty = computed(() => snapshot() !== initialSnapshot.value);

const sectionOptions = computed(() =>
  props.outline.filter((s) => s.kind === 'chapter' || s.kind === 'front_matter'),
);

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function loadFromNote(id: string) {
  const meta = readNoteMeta(props.notesDoc, id);
  if (!meta) return;
  title.value = meta.title;
  noteType.value = meta.noteType;
  sectionIds.value = [...meta.sectionIds];
  tagsText.value = meta.tags.join(', ');
  draftBodyId.value = id;
}

function resetDraftBody() {
  const frag = props.notesDoc.getXmlFragment(bodyField(DRAFT_BODY_ID));
  frag.delete(0, frag.length);
  draftBodyId.value = DRAFT_BODY_ID;
}

function loadCreate() {
  title.value = '';
  noteType.value = 'other';
  sectionIds.value = [];
  tagsText.value = '';
  resetDraftBody();
  draftBodyId.value = DRAFT_BODY_ID;
  props.notesDoc.getXmlFragment(bodyField(DRAFT_BODY_ID));
}

watch(
  () => props.noteId,
  (id) => {
    if (id) loadFromNote(id);
    else loadCreate();
    initialSnapshot.value = snapshot();
  },
  { immediate: true },
);

function toggleSection(id: string) {
  const set = new Set(sectionIds.value);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  sectionIds.value = [...set];
}

function requestClose() {
  if (dirty.value) {
    confirmDiscard.value = true;
    return;
  }
  emit('close');
}

function confirmDiscardYes() {
  confirmDiscard.value = false;
  if (!isEdit.value) resetDraftBody();
  emit('close');
}

function onDialogKeydown(e: KeyboardEvent) {
  if (confirmDiscard.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      confirmDiscard.value = false;
    }
    return;
  }
  trapTab(e, dialog.value!);
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    requestClose();
    return;
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canSave.value) {
    e.preventDefault();
    void save();
  }
}

async function save() {
  if (!canSave.value) return;
  const trimmed = title.value.trim();
  const tags = parseTags(tagsText.value);
  if (isEdit.value && props.noteId) {
    updateNoteTitle(props.notesDoc, props.noteId, trimmed);
    updateNoteType(props.notesDoc, props.noteId, noteType.value);
    updateNoteSectionIds(props.notesDoc, props.noteId, sectionIds.value);
    updateNoteTags(props.notesDoc, props.noteId, tags);
    emit('saved');
    return;
  }
  const draftId = draftBodyId.value;
  const meta = addNote(
    props.notesDoc,
    { kind: 'human', id: props.humanAuthor.id, name: props.humanAuthor.name },
    trimmed,
    { noteType: noteType.value, tags, sectionIds: sectionIds.value },
  );
  if (draftId === DRAFT_BODY_ID) {
    copyNoteBody(props.notesDoc, DRAFT_BODY_ID, meta.id);
    resetDraftBody();
  }
  emit('saved');
}

async function onDelete() {
  if (!props.noteId || props.readonly) return;
  if (!window.confirm('Delete this note? This cannot be undone.')) return;
  deleteNote(props.notesDoc, props.noteId);
  emit('deleted');
}

onMounted(async () => {
  ensureOverlayLayer();
  overlayReady.value = true;
  await nextTick();
  titleInput.value?.focus();
});

onBeforeUnmount(() => {
  if (!isEdit.value) resetDraftBody();
});
</script>

<template>
  <Teleport v-if="overlayReady" :to="APP_OVERLAY_LAYER">
    <div
      class="st-dlg-scrim note-edit-scrim"
      data-test="note-edit-modal-scrim"
      @mousedown.self.prevent
    >
      <div
        ref="dialog"
        class="st-dlg note-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-edit-heading"
        data-test="note-edit-modal"
        @keydown="onDialogKeydown"
      >
        <h2 id="note-edit-heading" class="st-h2">{{ heading }}</h2>

        <label class="note-edit-modal__field">
          <span>Title</span>
          <input
            ref="titleInput"
            v-model="title"
            class="st-inp"
            data-test="note-edit-title"
            :readonly="readonly"
          />
        </label>

        <label class="note-edit-modal__field">
          <span>Type</span>
          <select v-model="noteType" class="st-inp" data-test="note-edit-type" :disabled="readonly">
            <option v-for="t in NOTE_TYPES" :key="t" :value="t">{{ NOTE_TYPE_LABELS[t] }}</option>
          </select>
        </label>

        <label class="note-edit-modal__field">
          <span>Body</span>
          <NoteBodyEditor
            :key="draftBodyId"
            :notes-doc="notesDoc"
            :note-id="draftBodyId"
            :readonly="readonly"
          />
        </label>

        <fieldset class="note-edit-modal__field">
          <legend>Linked chapters</legend>
          <div class="note-edit-modal__chips" data-test="note-edit-sections">
            <button
              v-for="s in sectionOptions"
              :key="s.id"
              type="button"
              class="note-edit-modal__chip"
              :class="{ 'note-edit-modal__chip--on': sectionIds.includes(s.id) }"
              :disabled="readonly"
              @click="toggleSection(s.id)"
            >
              {{ s.title }}
            </button>
          </div>
        </fieldset>

        <label class="note-edit-modal__field">
          <span>Tags</span>
          <input
            v-model="tagsText"
            class="st-inp"
            data-test="note-edit-tags"
            placeholder="Comma-separated"
            :readonly="readonly"
          />
        </label>

        <footer class="note-edit-modal__foot">
          <button
            v-if="isEdit"
            type="button"
            class="note-edit-modal__delete"
            data-test="note-edit-delete"
            :disabled="readonly"
            @click="onDelete"
          >
            Delete
          </button>
          <span v-else aria-hidden="true" />
          <div class="note-edit-modal__actions">
            <button type="button" class="sh-btn" data-test="note-edit-cancel" @click="requestClose">
              Cancel
            </button>
            <button
              type="button"
              class="sh-btn sh-btn--primary"
              data-test="note-edit-save"
              :disabled="!canSave"
              @click="save"
            >
              Save
            </button>
          </div>
        </footer>

        <div
          v-if="confirmDiscard"
          class="note-edit-modal__confirm"
          role="alertdialog"
          aria-labelledby="note-discard-title"
          data-test="note-edit-discard-confirm"
        >
          <p id="note-discard-title">Discard unsaved changes?</p>
          <div class="note-edit-modal__actions">
            <button
              type="button"
              class="sh-btn"
              data-test="note-edit-discard-no"
              @click="confirmDiscard = false"
            >
              Keep editing
            </button>
            <button
              type="button"
              class="sh-btn sh-btn--primary"
              data-test="note-edit-discard-yes"
              @click="confirmDiscardYes"
            >
              Discard
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.note-edit-scrim {
  z-index: var(--ct-z-modal);
}
.note-edit-modal {
  width: min(560px, calc(100vw - 48px));
  max-height: 80vh;
  overflow: auto;
  position: relative;
}
.note-edit-modal__field {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-1);
  margin-top: var(--ct-space-3);
  font-size: var(--ct-text-sm);
  color: var(--ct-text-muted);
  border: 0;
  padding: 0;
}
.note-edit-modal__field legend {
  font-size: var(--ct-text-sm);
  color: var(--ct-text-muted);
  margin-bottom: var(--ct-space-1);
}
.note-edit-modal__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-1);
}
.note-edit-modal__chip {
  font: inherit;
  font-size: var(--ct-text-xs);
  padding: var(--ct-space-1) var(--ct-space-2);
  border-radius: var(--ct-radius-full);
  border: 1px solid var(--ct-border);
  background: var(--ct-paper);
  color: var(--ct-text);
  cursor: pointer;
}
.note-edit-modal__chip--on {
  border-color: var(--ct-accent);
  background: var(--ct-selected-bg);
}
.note-edit-modal__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ct-space-3);
  margin-top: var(--ct-space-5);
}
.note-edit-modal__delete {
  font: inherit;
  font-size: var(--ct-text-sm);
  color: var(--ct-danger);
  background: none;
  border: 0;
  cursor: pointer;
  padding: var(--ct-space-2);
}
.note-edit-modal__actions {
  display: flex;
  gap: var(--ct-space-2);
  margin-left: auto;
}
.note-edit-modal__confirm {
  position: absolute;
  inset: var(--ct-space-4);
  padding: var(--ct-space-4);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-2);
}
</style>
