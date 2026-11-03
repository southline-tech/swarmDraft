import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('uses at least 11rem min-height on the body wrap (#278)', () => {
    const src = readFileSync(resolve(__dirname, 'NoteBodyEditor.vue'), 'utf8');
    expect(src).toMatch(/\.story-note-body-wrap\s*\{[^}]*min-height:\s*11rem/s);
    expect(src).toMatch(/\.tiptap\)[^}]*min-height:\s*10rem/s);
  });
});
