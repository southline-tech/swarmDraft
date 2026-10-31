import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';

vi.mock('../backend', () => ({
  notesApplyUpdate: vi.fn(async () => {}),
}));

import { notesApplyUpdate } from '../backend';
import { addNote, createNotesDoc, listNotes, updateNoteSectionLink, updateNoteTitle } from './doc';
import { readNotesSaveStatus, subscribeNotesSaveStatus, watchNotesDoc } from './persist';

describe('story notes doc', () => {
  it('creates ordered notes with human attribution', () => {
    const doc = createNotesDoc();
    const n = addNote(doc, { kind: 'human', id: 'human:1', name: 'Sample Person' }, 'Beat sheet');
    expect(listNotes(doc)).toEqual([
      expect.objectContaining({
        id: n.id,
        title: 'Beat sheet',
        authorKind: 'human',
        authorName: 'Sample Person',
        sectionId: null,
      }),
    ]);
  });

  it('updates title and section link', () => {
    const doc = createNotesDoc();
    const n = addNote(doc, { kind: 'agent', id: 'agent:bot', name: 'Sample Bot' });
    updateNoteTitle(doc, n.id, 'Timeline');
    updateNoteSectionLink(doc, n.id, 'ch-2');
    expect(listNotes(doc).find((x) => x.id === n.id)).toMatchObject({
      title: 'Timeline',
      sectionId: 'ch-2',
      authorKind: 'agent',
    });
  });

  it('survives Yjs round-trip like storage', () => {
    const doc = createNotesDoc();
    addNote(doc, { kind: 'human', id: 'h', name: 'Author' }, 'One');
    const remote = createNotesDoc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    expect(listNotes(remote)).toHaveLength(1);
    expect(listNotes(remote)[0]!.title).toBe('One');
  });
});

describe('watchNotesDoc', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces saves through notesApplyUpdate', async () => {
    const spy = vi.mocked(notesApplyUpdate);
    spy.mockClear();
    const doc = createNotesDoc();
    addNote(doc, { kind: 'human', id: 'h', name: 'Author' });
    watchNotesDoc('m-1', doc, { debounceMs: 50 });
    const id = listNotes(doc)[0]!.id;
    updateNoteTitle(doc, id, 'Saved');
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(spy).toHaveBeenCalledWith('m-1', expect.any(Uint8Array));
  });

  it('notifies subscribers when a save completes', async () => {
    const doc = createNotesDoc();
    addNote(doc, { kind: 'human', id: 'h', name: 'Author' });
    const persister = watchNotesDoc('m-1', doc, { debounceMs: 50 });
    const id = listNotes(doc)[0]!.id;
    let rev = 0;
    subscribeNotesSaveStatus(doc, () => {
      rev += 1;
    });
    updateNoteTitle(doc, id, 'Saved');
    await vi.advanceTimersByTimeAsync(50);
    await persister.flush();
    expect(readNotesSaveStatus(doc).phase).toBe('saved');
    expect(rev).toBeGreaterThan(0);
  });
});
