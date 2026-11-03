import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NoteBodyEditor from './NoteBodyEditor.vue';
import NoteEditModal from './NoteEditModal.vue';
import {
  addNote,
  bodyField,
  createNotesDoc,
  listNotes,
  noteBodySnapshot,
  readNoteMeta,
  seedNoteBodyText,
} from './doc';
import { ensureOverlayLayer } from '../overlay/layer';
import { overlayWrap, queryInOverlay } from '../overlay/queries';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function waitModal() {
  await flushPromises();
  await vi.waitFor(() => expect(overlayWrap('[data-test="note-edit-modal"]').exists()).toBe(true));
}

function mutateDraftBody(w: ReturnType<typeof mount>, text: string) {
  const editor = w.findComponent(NoteBodyEditor);
  const draftDoc = editor.props('notesDoc') as import('yjs').Doc;
  seedNoteBodyText(draftDoc, '__draft__', text);
}

describe('NoteEditModal', () => {
  it('disables Save until title is non-empty', async () => {
    ensureOverlayLayer();
    const notesDoc = createNotesDoc();
    const w = mount(NoteEditModal, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        noteId: null,
      },
    });
    await waitModal();
    expect(overlayWrap('[data-test="note-edit-save"]').attributes('disabled')).toBeDefined();
    await overlayWrap('[data-test="note-edit-title"]').setValue('Beat sheet');
    expect(overlayWrap('[data-test="note-edit-save"]').attributes('disabled')).toBeUndefined();
    w.unmount();
  });

  it('saves on Ctrl+Enter when title is set', async () => {
    ensureOverlayLayer();
    const notesDoc = createNotesDoc();
    const w = mount(NoteEditModal, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        noteId: null,
      },
    });
    await waitModal();
    await overlayWrap('[data-test="note-edit-title"]').setValue('Timeline');
    mutateDraftBody(w, 'Body copy');
    await flushPromises();
    await overlayWrap('[data-test="note-edit-modal"]').trigger('keydown', {
      key: 'Enter',
      ctrlKey: true,
    });
    await flushPromises();
    expect(listNotes(notesDoc)).toHaveLength(1);
    const id = listNotes(notesDoc)[0]!.id;
    expect(listNotes(notesDoc)[0]!.title).toBe('Timeline');
    expect(noteBodySnapshot(notesDoc, id)).toContain('Body copy');
    expect(w.emitted('saved')).toHaveLength(1);
    w.unmount();
  });

  it('shows discard confirm on dirty Esc and skips when clean', async () => {
    ensureOverlayLayer();
    const notesDoc = createNotesDoc();
    const meta = addNote(notesDoc, { kind: 'human', id: 'h', name: 'Author' }, 'Note');
    const w = mount(NoteEditModal, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        noteId: meta.id,
      },
    });
    await waitModal();
    await overlayWrap('[data-test="note-edit-modal"]').trigger('keydown', { key: 'Escape' });
    expect(queryInOverlay('[data-test="note-edit-discard-confirm"]')).toBeNull();
    expect(w.emitted('close')).toHaveLength(1);
    w.unmount();

    const w2 = mount(NoteEditModal, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        noteId: meta.id,
      },
    });
    await waitModal();
    await overlayWrap('[data-test="note-edit-title"]').setValue('Changed');
    await overlayWrap('[data-test="note-edit-modal"]').trigger('keydown', { key: 'Escape' });
    expect(overlayWrap('[data-test="note-edit-discard-confirm"]').exists()).toBe(true);
    await overlayWrap('[data-test="note-edit-discard-yes"]').trigger('click');
    expect(w2.emitted('close')).toHaveLength(1);
    w2.unmount();
  });

  it('edit: body-only dirty shows discard and leaves persisted body unchanged', async () => {
    ensureOverlayLayer();
    const notesDoc = createNotesDoc();
    const meta = addNote(notesDoc, { kind: 'human', id: 'h', name: 'Author' }, 'Note');
    seedNoteBodyText(notesDoc, meta.id, 'Original');
    const before = noteBodySnapshot(notesDoc, meta.id);

    const w = mount(NoteEditModal, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        noteId: meta.id,
      },
    });
    await waitModal();
    mutateDraftBody(w, 'Mutated draft');
    await flushPromises();
    await overlayWrap('[data-test="note-edit-modal"]').trigger('keydown', { key: 'Escape' });
    expect(overlayWrap('[data-test="note-edit-discard-confirm"]').exists()).toBe(true);
    await overlayWrap('[data-test="note-edit-discard-yes"]').trigger('click');
    expect(noteBodySnapshot(notesDoc, meta.id)).toBe(before);
    w.unmount();
  });

  it('edit: save copies draft body to the real note without polluting notesDoc', async () => {
    ensureOverlayLayer();
    const notesDoc = createNotesDoc();
    const meta = addNote(notesDoc, { kind: 'human', id: 'h', name: 'Author' }, 'Note');
    seedNoteBodyText(notesDoc, meta.id, 'Before');

    const w = mount(NoteEditModal, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        noteId: meta.id,
      },
    });
    await waitModal();
    mutateDraftBody(w, 'After save');
    await flushPromises();
    await overlayWrap('[data-test="note-edit-save"]').trigger('click');
    await flushPromises();
    expect(noteBodySnapshot(notesDoc, meta.id)).toContain('After save');
    expect(notesDoc.getXmlFragment(bodyField('__draft__')).length).toBe(0);
    w.unmount();
  });

  it('create: body-only dirty shows discard and does not create a note', async () => {
    ensureOverlayLayer();
    const notesDoc = createNotesDoc();
    const w = mount(NoteEditModal, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        noteId: null,
      },
    });
    await waitModal();
    mutateDraftBody(w, 'Draft only');
    await flushPromises();
    await overlayWrap('[data-test="note-edit-modal"]').trigger('keydown', { key: 'Escape' });
    expect(overlayWrap('[data-test="note-edit-discard-confirm"]').exists()).toBe(true);
    await overlayWrap('[data-test="note-edit-discard-yes"]').trigger('click');
    expect(listNotes(notesDoc)).toHaveLength(0);
    w.unmount();
  });

  it('adds and removes tag chips and persists on save', async () => {
    ensureOverlayLayer();
    const notesDoc = createNotesDoc();
    const meta = addNote(notesDoc, { kind: 'human', id: 'h', name: 'Author' }, 'Note', {
      tags: ['old'],
    });
    const w = mount(NoteEditModal, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        noteId: meta.id,
      },
    });
    await waitModal();
    expect(overlayWrap('[data-test="note-edit-tag-chip"]').text()).toContain('old');
    const tagInput = queryInOverlay('[data-test="note-edit-tag-add"]') as HTMLInputElement;
    tagInput.value = 'new';
    tagInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    await overlayWrap('[data-test="note-edit-tag-add-btn"]').trigger('click');
    await flushPromises();
    expect(document.querySelectorAll('[data-test="note-edit-tag-chip"]').length).toBe(2);
    await overlayWrap('[data-test="note-edit-tag-chip"] button').trigger('click');
    expect(overlayWrap('[data-test="note-edit-tag-chip"]').text()).not.toContain('old');
    await overlayWrap('[data-test="note-edit-save"]').trigger('click');
    await flushPromises();
    expect(readNoteMeta(notesDoc, meta.id)?.tags).toEqual(['new']);
    w.unmount();
  });

  it('discard restores tags without save', async () => {
    ensureOverlayLayer();
    const notesDoc = createNotesDoc();
    const meta = addNote(notesDoc, { kind: 'human', id: 'h', name: 'Author' }, 'Note', {
      tags: ['keep'],
    });
    const w = mount(NoteEditModal, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        noteId: meta.id,
      },
    });
    await waitModal();
    const tagInput = queryInOverlay('[data-test="note-edit-tag-add"]') as HTMLInputElement;
    tagInput.value = 'drop';
    tagInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    await overlayWrap('[data-test="note-edit-tag-add-btn"]').trigger('click');
    await flushPromises();
    await overlayWrap('[data-test="note-edit-modal"]').trigger('keydown', { key: 'Escape' });
    await overlayWrap('[data-test="note-edit-discard-yes"]').trigger('click');
    expect(readNoteMeta(notesDoc, meta.id)?.tags).toEqual(['keep']);
    w.unmount();
  });
});
