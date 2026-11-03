import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NoteEditModal from './NoteEditModal.vue';
import { addNote, createNotesDoc, listNotes } from './doc';
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
      global: {
        stubs: { NoteBodyEditor: { template: '<div data-test="note-body" />' } },
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
      global: {
        stubs: { NoteBodyEditor: { template: '<div data-test="note-body" />' } },
      },
    });
    await waitModal();
    await overlayWrap('[data-test="note-edit-title"]').setValue('Timeline');
    await overlayWrap('[data-test="note-edit-modal"]').trigger('keydown', {
      key: 'Enter',
      ctrlKey: true,
    });
    await flushPromises();
    expect(listNotes(notesDoc)).toHaveLength(1);
    expect(listNotes(notesDoc)[0]!.title).toBe('Timeline');
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
      global: {
        stubs: { NoteBodyEditor: { template: '<div data-test="note-body" />' } },
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
      global: {
        stubs: { NoteBodyEditor: { template: '<div data-test="note-body" />' } },
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
});
