import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StoryNotesPanel from './StoryNotesPanel.vue';
import { addNote, createNotesDoc, updateNoteType } from './doc';

describe('StoryNotesPanel', () => {
  it('lists view-only cards without inline title or body editors', async () => {
    const notesDoc = createNotesDoc();
    addNote(notesDoc, { kind: 'human', id: 'h', name: 'Sample Person' }, 'Human note');
    const agent = addNote(
      notesDoc,
      { kind: 'agent', id: 'agent:a', name: 'Sample Bot' },
      'Agent note',
    );
    updateNoteType(notesDoc, agent.id, 'plot');
    const w = mount(StoryNotesPanel, {
      props: {
        notesDoc,
        outline: [{ id: 'c1', kind: 'chapter', title: 'Chapter One', docId: 'd1' }],
        humanAuthor: { id: 'h', name: 'Sample Person' },
      },
    });
    expect(w.find('[data-test="note-list"] li').exists()).toBe(true);
    expect(w.find('[data-test="note-title"]').exists()).toBe(false);
    expect(w.find('[data-test="note-body"]').exists()).toBe(false);
    expect(w.find('[data-test="note-detail"]').exists()).toBe(false);
    expect(w.text()).toContain('Human note');
    expect(w.text()).toContain('Plot');
    w.unmount();
  });

  it('emits create when New note is clicked', async () => {
    const notesDoc = createNotesDoc();
    const w = mount(StoryNotesPanel, {
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Sample Person' },
      },
    });
    expect(w.find('[data-test="empty"]').exists()).toBe(true);
    await w.get('[data-test="new-note"]').trigger('click');
    expect(w.emitted('create')).toHaveLength(1);
    w.unmount();
  });

  it('emits edit on Edit button, Enter, and double-click', async () => {
    const notesDoc = createNotesDoc();
    const meta = addNote(notesDoc, { kind: 'human', id: 'h', name: 'Author' }, 'Note');
    const w = mount(StoryNotesPanel, {
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
      },
    });
    await w.get('[data-test="note-edit"]').trigger('click');
    expect(w.emitted('edit')?.[0]?.[0]).toMatchObject({
      note: expect.objectContaining({ id: meta.id }),
    });
    await w.get('[data-test="note-card"]').trigger('keydown', { key: 'Enter' });
    expect(w.emitted('edit')?.length).toBeGreaterThanOrEqual(2);
    await w.get('[data-test="note-card"]').trigger('dblclick');
    expect(w.emitted('edit')?.length).toBeGreaterThanOrEqual(3);
    w.unmount();
  });

  it('hides the Edit control until the card or button is focused', async () => {
    const notesDoc = createNotesDoc();
    addNote(notesDoc, { kind: 'human', id: 'h', name: 'Author' }, 'Note');
    const w = mount(StoryNotesPanel, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
      },
    });
    const edit = w.get('[data-test="note-edit"]');
    expect(edit.classes()).toContain('story-notes__edit--hidden');
    await edit.trigger('focus');
    expect(edit.classes()).toContain('story-notes__edit--hidden');
    w.unmount();
  });

  it('emits close when the header close control is activated', async () => {
    const notesDoc = createNotesDoc();
    const w = mount(StoryNotesPanel, {
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Sample Person' },
      },
    });
    await w.get('[data-test=story-notes-close]').trigger('click');
    expect(w.emitted('close')).toHaveLength(1);
    w.unmount();
  });
});
