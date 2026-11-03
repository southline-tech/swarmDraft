<script setup lang="ts">
/**
 * Create/edit story note in a centered modal (#278).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { Section } from '@swarmdraft/schema';
import * as Y from 'yjs';
import { APP_OVERLAY_LAYER, ensureOverlayLayer } from '../overlay/layer';
import { trapTab } from '../settings/focus-trap';
import '../settings/settings.css';
import NoteBodyEditor from './NoteBodyEditor.vue';
import {
  addNote,
  bodyField,
  copyNoteBodyBetween,
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
const tags = ref<string[]>([]);
const tagInput = ref('');

const draftDoc = shallowRef<Y.Doc | null>(null);
const bodyRevision = ref(0);
let bodyObserverOff: (() => void) | undefined;

const initialSnapshot = ref('');

function bodyFingerprint(): string {
  const doc = draftDoc.value;
  if (!doc) return '';
  return doc.getXmlFragment(bodyField(DRAFT_BODY_ID)).toString();
}

function snapshot(): string {
  void bodyRevision.value;
  return JSON.stringify({
    title: title.value.trim(),
    noteType: noteType.value,
    sectionIds: [...sectionIds.value].sort(),
    tags: [...tags.value].sort(),
    body: bodyFingerprint(),
  });
}

const isEdit = computed(() => props.noteId != null);
const heading = computed(() => (isEdit.value ? 'Edit note' : 'New note'));
const canSave = computed(() => title.value.trim().length > 0 && !props.readonly);
const dirty = computed(() => snapshot() !== initialSnapshot.value);

const sectionOptions = computed(() =>
  props.outline.filter((s) => s.kind === 'chapter' || s.kind === 'front_matter'),
);

function attachBodyObserver(doc: Y.Doc) {
  bodyObserverOff?.();
  const frag = doc.getXmlFragment(bodyField(DRAFT_BODY_ID));
  const bump = () => {
    bodyRevision.value += 1;
  };
  frag.observeDeep(bump);
  bodyObserverOff = () => frag.unobserveDeep(bump);
}

function destroyDraftDoc() {
  bodyObserverOff?.();
  bodyObserverOff = undefined;
  draftDoc.value?.destroy();
  draftDoc.value = null;
}

function initDraftDoc(noteId: string | null) {
  destroyDraftDoc();
  const doc = new Y.Doc();
  if (noteId) {
    copyNoteBodyBetween(props.notesDoc, noteId, doc, DRAFT_BODY_ID);
  }
  draftDoc.value = doc;
  attachBodyObserver(doc);
}

function loadMetaFromNote(id: string) {
  const meta = readNoteMeta(props.notesDoc, id);
  if (!meta) return;
  title.value = meta.title;
  noteType.value = meta.noteType;
  sectionIds.value = [...meta.sectionIds];
  tags.value = [...meta.tags];
}

function loadCreateMeta() {
  title.value = '';
  noteType.value = 'other';
  sectionIds.value = [];
  tags.value = [];
  tagInput.value = '';
}

function syncForm(noteId: string | null) {
  if (noteId) loadMetaFromNote(noteId);
  else loadCreateMeta();
  initDraftDoc(noteId);
  initialSnapshot.value = snapshot();
}

watch(
  () => props.noteId,
  (id) => syncForm(id),
  { immediate: true },
);

function toggleSection(id: string) {
  const set = new Set(sectionIds.value);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  sectionIds.value = [...set];
}

function addTagFromInput() {
  const t = tagInput.value.trim();
  if (!t || tags.value.includes(t)) {
    tagInput.value = '';
    return;
  }
  tags.value = [...tags.value, t];
  tagInput.value = '';
}

function removeTag(tag: string) {
  tags.value = tags.value.filter((x) => x !== tag);
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
  if (!canSave.value || !draftDoc.value) return;
  const trimmed = title.value.trim();
  const tagList = [...tags.value];
  if (isEdit.value && props.noteId) {
    updateNoteTitle(props.notesDoc, props.noteId, trimmed);
    updateNoteType(props.notesDoc, props.noteId, noteType.value);
    updateNoteSectionIds(props.notesDoc, props.noteId, sectionIds.value);
    updateNoteTags(props.notesDoc, props.noteId, tagList);
    copyNoteBodyBetween(draftDoc.value, DRAFT_BODY_ID, props.notesDoc, props.noteId);
    emit('saved');
    return;
  }
  const meta = addNote(
    props.notesDoc,
    { kind: 'human', id: props.humanAuthor.id, name: props.humanAuthor.name },
    trimmed,
    { noteType: noteType.value, tags: tagList, sectionIds: sectionIds.value },
  );
  copyNoteBodyBetween(draftDoc.value, DRAFT_BODY_ID, props.notesDoc, meta.id);
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
  destroyDraftDoc();
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

        <label v-if="draftDoc" class="note-edit-modal__field">
          <span>Body</span>
          <NoteBodyEditor :notes-doc="draftDoc" :note-id="DRAFT_BODY_ID" :readonly="readonly" />
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

        <div class="note-edit-modal__field">
          <span>Tags</span>
          <div class="note-edit-modal__chips" data-test="note-edit-tags">
            <span
              v-for="tag in tags"
              :key="tag"
              class="note-edit-modal__tag-chip"
              data-test="note-edit-tag-chip"
            >
              {{ tag }}
              <button
                type="button"
                class="note-edit-modal__tag-remove"
                :aria-label="`Remove tag ${tag}`"
                :disabled="readonly"
                @click="removeTag(tag)"
              >
                ×
              </button>
            </span>
            <input
              v-model="tagInput"
              class="st-inp note-edit-modal__tag-input"
              data-test="note-edit-tag-add"
              placeholder="Add tag"
              :readonly="readonly"
              @keydown.enter.prevent="addTagFromInput"
            />
            <button
              type="button"
              class="sh-btn note-edit-modal__tag-add-btn"
              data-test="note-edit-tag-add-btn"
              :disabled="readonly"
              @click="addTagFromInput"
            >
              Add
            </button>
          </div>
        </div>

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
  align-items: center;
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
.note-edit-modal__tag-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--ct-space-1);
  font-size: var(--ct-text-xs);
  padding: var(--ct-space-1) var(--ct-space-2);
  border-radius: var(--ct-radius-full);
  border: 1px solid var(--ct-border);
  background: var(--ct-surface);
  color: var(--ct-text);
}
.note-edit-modal__tag-remove {
  font: inherit;
  line-height: 1;
  border: 0;
  background: none;
  color: var(--ct-text-muted);
  cursor: pointer;
  padding: 0;
}
.note-edit-modal__tag-input {
  flex: 1;
  min-width: 8rem;
}
.note-edit-modal__tag-add-btn {
  flex: none;
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
