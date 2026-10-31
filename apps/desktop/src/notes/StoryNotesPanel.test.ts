import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import StoryNotesPanel from './StoryNotesPanel.vue';
import { addNote, createNotesDoc } from './doc';

describe('StoryNotesPanel', () => {
  it('shows empty state then lists human and agent notes with badges', async () => {
    const notesDoc = createNotesDoc();
    addNote(notesDoc, { kind: 'human', id: 'h', name: 'Sample Person' }, 'Human note');
    addNote(notesDoc, { kind: 'agent', id: 'agent:a', name: 'Sample Bot' }, 'Agent note');
    const w = mount(StoryNotesPanel, {
      props: {
        notesDoc,
        outline: [{ id: 'c1', kind: 'chapter', title: 'Chapter One', docId: 'd1' }],
        humanAuthor: { id: 'h', name: 'Sample Person' },
      },
    });
    expect(w.find('[data-test="note-list"] li').exists()).toBe(true);
    expect(w.findAll('[data-test="agent-tag"]')).toHaveLength(1);
    expect(w.text()).toContain('Human note');
    expect(w.text()).toContain('Agent note');
  });

  it('creates a note from New note', async () => {
    const notesDoc = createNotesDoc();
    const w = mount(StoryNotesPanel, {
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Sample Person' },
      },
    });
    expect(w.find('[data-test="empty"]').exists()).toBe(true);
    await w.find('[data-test="new-note"]').trigger('click');
    expect(w.find('[data-test="empty"]').exists()).toBe(false);
    expect(w.find('[data-test="note-detail"]').exists()).toBe(true);
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
  });

  it('names the note body editor for assistive tech', async () => {
    const notesDoc = createNotesDoc();
    addNote(notesDoc, { kind: 'human', id: 'h', name: 'Sample Person' }, 'Note');
    const w = mount(StoryNotesPanel, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Sample Person' },
      },
    });
    await flushPromises();
    await vi.waitFor(() => {
      expect(w.find('[data-test=note-body]').attributes('aria-label')).toBe('Body');
    });
    expect(w.get('[data-test=note-detail]').text()).toContain('Body');
    w.unmount();
  });
});
