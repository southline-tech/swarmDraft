import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { addNote, createNotesDoc } from './doc';
import NoteBodyEditor from './NoteBodyEditor.vue';

describe('NoteBodyEditor', () => {
  it('names the editor surface Body for assistive tech', async () => {
    const notesDoc = createNotesDoc();
    const meta = addNote(notesDoc, { kind: 'human', id: 'h', name: 'Sample Person' }, 'Hook');
    const w = mount(NoteBodyEditor, {
      attachTo: document.body,
      props: { notesDoc, noteId: meta.id },
    });
    await flushPromises();
    await vi.waitFor(() => {
      expect(w.get('[data-test=note-body]').attributes('aria-label')).toBe('Body');
    });
    w.unmount();
  });
});
