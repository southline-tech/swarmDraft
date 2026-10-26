import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { yDocToDoc } from '@coauthor/docx';
import { sessionFromStored, UnsavedEditsError } from './manuscript-session';
import { storedFixture } from './stored-fixture.test-helper';

const firstText = (doc: Y.Doc) => {
  const p = doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
  return p.get(0) as Y.XmlText;
};

afterEach(() => vi.useRealTimers());

describe('sessionFromStored', () => {
  it('uses exactly the stored ids, parents and doc ids, with the stored content', () => {
    const stored = storedFixture();
    expect(stored.sections.some((s) => s.parentId)).toBe(true);
    const s = sessionFromStored(stored, null);
    expect(s.id).toBe('db-m');
    expect(s.outline.value.map((x) => [x.id, x.docId, x.parentId ?? null])).toEqual(
      stored.sections.map((x) => [x.id, x.docId, x.parentId]),
    );
    for (const x of stored.sections) {
      const expected = new Y.Doc();
      Y.applyUpdate(expected, Uint8Array.from(x.state));
      expect(yDocToDoc(s.sections.get(x.docId)!)).toEqual(yDocToDoc(expected));
    }
    s.close();
  });
  it('debounces edits into one saved delta per section that replays onto the stored state', async () => {
    vi.useFakeTimers();
    const stored = storedFixture();
    const saved: [string, Uint8Array][] = [];
    const s = sessionFromStored(stored, null, {
      save: async (id, u) => void saved.push([id, u]),
      debounceMs: 100,
    });
    const sec = stored.sections[1]!;
    const doc = s.sections.get(sec.docId)!;
    firstText(doc).insert(0, 'A');
    firstText(doc).insert(0, 'B');
    expect(saved).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(saved.map(([id]) => id)).toEqual([sec.id]);
    // The backend's copy: stored state + the delta equals the editor's doc.
    const backend = new Y.Doc();
    Y.applyUpdate(backend, Uint8Array.from(sec.state));
    Y.applyUpdate(backend, saved[0]![1]);
    expect(yDocToDoc(backend)).toEqual(yDocToDoc(doc));
    expect(firstText(backend).toString().startsWith('BA')).toBe(true);
    await s.close();
  });

  it('flushes pending edits on close, and drops them when closing with discard', async () => {
    const stored = storedFixture();
    const save = vi.fn(async () => {});
    const s = sessionFromStored(stored, null, { save, debounceMs: 60_000 });
    firstText(s.sections.get(stored.sections[1]!.docId)!).insert(0, 'X');
    await s.close();
    expect(save).toHaveBeenCalledTimes(1);

    const save2 = vi.fn(async () => {});
    const t = sessionFromStored(stored, null, { save: save2, debounceMs: 60_000 });
    firstText(t.sections.get(stored.sections[1]!.docId)!).insert(0, 'X');
    await t.close({ discard: true });
    expect(save2).not.toHaveBeenCalled();
  });

  it('never drops edits: after failures it resends the full state, and both edits survive a reload', async () => {
    vi.useFakeTimers();
    const stored = storedFixture();
    const sec = stored.sections[1]!;
    // A fake backend: accepted updates per section; fails while `down`.
    const accepted: Uint8Array[] = [];
    let down = true;
    const save = vi.fn(async (_id: string, u: Uint8Array) => {
      if (down) throw new Error('database is locked');
      accepted.push(u);
    });
    const onError = vi.fn();
    const onSaved = vi.fn();
    const s = sessionFromStored(stored, null, {
      save,
      onError,
      onSaved,
      debounceMs: 60_000,
      retryMs: 1000,
    });
    const doc = s.sections.get(sec.docId)!;
    firstText(doc).insert(0, 'LOST ');
    await expect(s.flush()).rejects.toBeInstanceOf(UnsavedEditsError); // failure 1
    await vi.advanceTimersByTimeAsync(1000); // backoff retry: failure 2
    await vi.advanceTimersByTimeAsync(2000); // failure 3
    expect(save).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onSaved).not.toHaveBeenCalled();
    firstText(doc).insert(0, 'LATER ');
    down = false;
    await s.flush();
    expect(onSaved).toHaveBeenCalledTimes(1);
    // The successful save is the full state, not just LATER's delta.
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Uint8Array.from(sec.state));
    for (const u of accepted) Y.applyUpdate(reload, u);
    expect(firstText(reload).toString()).toContain('LATER LOST ');
    // Sending a full state the backend already has is a no-op (idempotent).
    Y.applyUpdate(reload, accepted[0]!);
    expect(firstText(reload).toString().match(/LOST/g)).toHaveLength(1);
    // Nothing left unsaved: later edits go back to deltas, no more retries.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(4);
    await s.close();
  });

  it('flush rejects with the unsaved sections while a save keeps failing', async () => {
    const stored = storedFixture();
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    const s = sessionFromStored(stored, null, { save, debounceMs: 60_000, retryMs: 60_000 });
    firstText(s.sections.get(stored.sections[2]!.docId)!).insert(0, 'Z');
    const err = await s.flush().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsavedEditsError);
    expect((err as UnsavedEditsError).sectionIds).toEqual([stored.sections[2]!.id]);
    expect((err as Error).message).toContain('disk full');
    await s.close({ discard: true });
  });

  it('a rejected close keeps the session open and retrying until the edits are saved', async () => {
    vi.useFakeTimers();
    const stored = storedFixture();
    let down = true;
    const save = vi.fn(async () => {
      if (down) throw new Error('locked');
    });
    const s = sessionFromStored(stored, null, { save, debounceMs: 60_000, retryMs: 1000 });
    const doc = s.sections.get(stored.sections[1]!.docId)!;
    firstText(doc).insert(0, 'KEEP ');
    await expect(s.close()).rejects.toBeInstanceOf(UnsavedEditsError);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2); // the backoff retry still runs
    firstText(doc).insert(0, 'MORE '); // still observed
    down = false;
    await vi.advanceTimersByTimeAsync(60_000);
    const sent = save.mock.calls.at(-1)! as unknown as [string, Uint8Array];
    const d = new Y.Doc();
    Y.applyUpdate(d, Uint8Array.from(stored.sections[1]!.state));
    Y.applyUpdate(d, sent[1]);
    expect(firstText(d).toString()).toContain('MORE KEEP ');
    await s.close();
    const calls = save.mock.calls.length;
    firstText(doc).insert(0, 'AFTER ');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(calls); // closed for real now
  });

  it('a save that hangs past the timeout counts as failed and is resent as full state', async () => {
    vi.useFakeTimers();
    const stored = storedFixture();
    const save = vi
      .fn<(id: string, u: Uint8Array) => Promise<void>>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const s = sessionFromStored(stored, null, {
      save,
      onError,
      debounceMs: 60_000,
      retryMs: 1000,
      saveTimeoutMs: 10_000,
    });
    const sec = stored.sections[1]!;
    firstText(s.sections.get(sec.docId)!).insert(0, 'SLOW ');
    const flushed = s.flush().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await flushed).toBeInstanceOf(UnsavedEditsError);
    expect(String(onError.mock.calls[0]![0])).toContain('timed out');
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
    const d = new Y.Doc();
    Y.applyUpdate(d, save.mock.calls[1]![1]); // the full state on its own rebuilds the doc
    expect(firstText(d).toString()).toContain('SLOW ');
    await s.close();
  });
});

describe('outline saves (RAD-263)', () => {
  it('saves the outline to storage before changing it, and refuses it if that fails', async () => {
    const stored = storedFixture();
    const saveOutline = vi.fn(async () => {});
    const s = sessionFromStored(stored, null, { save: async () => {} }, saveOutline);
    const renamed = s.outline.value.map((x, i) => (i === 1 ? { ...x, title: 'Renamed' } : x));
    await s.save(renamed);
    expect(saveOutline).toHaveBeenCalledWith(renamed);
    expect(s.outline.value[1]!.title).toBe('Renamed');

    saveOutline.mockRejectedValueOnce(new Error('database is locked'));
    const reordered = [...s.outline.value].reverse();
    await expect(s.save(reordered)).rejects.toThrow('database is locked');
    expect(s.outline.value[1]!.title).toBe('Renamed');
    expect(s.outline.value[0]!.id).toBe(stored.sections[0]!.id);
    await s.close();
  });

  it('gives an added section a doc whose edits are saved', async () => {
    vi.useFakeTimers();
    const stored = storedFixture();
    const saved: string[] = [];
    const s = sessionFromStored(
      stored,
      null,
      { save: async (id) => void saved.push(id), debounceMs: 50 },
      async () => {},
    );
    const added = {
      id: 'new1',
      kind: 'chapter' as const,
      title: 'Added',
      docId: 'manuscript/db-m/section/new1',
    };
    await s.save([...s.outline.value, added]);
    const doc = s.sections.get(added.docId)!;
    expect(doc).toBeDefined();
    doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlElement('paragraph')]);
    await vi.advanceTimersByTimeAsync(50);
    expect(saved).toEqual(['new1']);
    await s.close();
  });
});

describe('outline edits and section saves together (RAD-263)', () => {
  /** A fake backend: section rows plus accepted updates per section, like SQLite. */
  function fakeBackend(stored: ReturnType<typeof storedFixture>) {
    const rows = new Map(stored.sections.map((x) => [x.id, { ...x }]));
    const updates = new Map(stored.sections.map((x) => [x.id, [Uint8Array.from(x.state)]]));
    let order = stored.sections.map((x) => x.id);
    return {
      rows,
      persist: {
        save: async (id: string, u: Uint8Array) => {
          if (!rows.has(id)) throw new Error(`section ${id} not found`);
          updates.get(id)!.push(u);
        },
        debounceMs: 50,
      },
      saveOutline: async (next: import('@coauthor/schema').Section[]) => {
        for (const x of next) {
          if (!rows.has(x.id)) updates.set(x.id, []);
          rows.set(x.id, {
            id: x.id,
            manuscriptId: 'db-m',
            kind: x.kind,
            parentId: x.parentId ?? null,
            position: 0,
            title: x.title,
            docId: x.docId,
            state: [],
          });
        }
        const keep = new Set(next.map((x) => x.id));
        for (const id of [...rows.keys()]) if (!keep.has(id)) rows.delete(id);
        order = next.map((x) => x.id);
      },
      reload: () => ({
        manuscript: stored.manuscript,
        sections: order.map((id, i) => {
          const d = new Y.Doc();
          for (const u of updates.get(id)!) Y.applyUpdate(d, u);
          return { ...rows.get(id)!, position: i, state: Array.from(Y.encodeStateAsUpdate(d)) };
        }),
      }),
    };
  }

  it('deleting a section with unsaved edits saves them first, then close succeeds', async () => {
    vi.useFakeTimers();
    const stored = storedFixture();
    const be = fakeBackend(stored);
    const s = sessionFromStored(stored, null, be.persist, be.saveOutline);
    const victim = stored.sections.find((x) => !s.outline.value.some((c) => c.parentId === x.id))!;
    const other = stored.sections.find((x) => x.id !== victim.id)!;
    const victimDoc = s.sections.get(victim.docId)!;
    firstText(victimDoc).insert(0, 'LOST? ');
    firstText(s.sections.get(other.docId)!).insert(0, 'KEPT ');
    // Delete before the debounce fires.
    await s.save(s.outline.value.filter((x) => x.id !== victim.id));
    expect(s.sections.has(victim.docId)).toBe(false);
    // A late keystroke into the deleted (still open) doc is ignored, not retried forever.
    firstText(victimDoc).insert(0, 'late ');
    await vi.advanceTimersByTimeAsync(100);
    await expect(s.close()).resolves.toBeUndefined();
    const again = sessionFromStored(be.reload(), null);
    expect(again.outline.value.some((x) => x.id === victim.id)).toBe(false);
    expect(firstText(again.sections.get(other.docId)!).toString().startsWith('KEPT ')).toBe(true);
    await again.close();
  });

  it('refuses the delete if pending edits cannot be saved first', async () => {
    vi.useFakeTimers();
    const stored = storedFixture();
    const be = fakeBackend(stored);
    const saveOutline = vi.fn(be.saveOutline);
    const s = sessionFromStored(
      stored,
      null,
      { ...be.persist, save: async () => Promise.reject(new Error('database is locked')) },
      saveOutline,
    );
    const victim = stored.sections[1]!;
    firstText(s.sections.get(victim.docId)!).insert(0, 'X');
    await expect(s.save(s.outline.value.filter((x) => x.id !== victim.id))).rejects.toThrow(
      UnsavedEditsError,
    );
    expect(saveOutline).not.toHaveBeenCalled();
    expect(s.outline.value.some((x) => x.id === victim.id)).toBe(true);
    await s.close({ discard: true });
  });

  it('add, rename, reorder, type in the new section, reopen: text is in the right section', async () => {
    vi.useFakeTimers();
    const stored = storedFixture();
    const be = fakeBackend(stored);
    const s = sessionFromStored(stored, null, be.persist, be.saveOutline);
    const part = s.outline.value.find((x) => x.kind === 'part');
    const added = {
      id: 'new1',
      kind: 'chapter' as const,
      title: 'Added',
      docId: 'manuscript/db-m/section/new1',
      ...(part ? { parentId: part.id } : {}),
    };
    await s.save([...s.outline.value, added]);
    const renamed = s.outline.value.map((x) => (x.id === 'new1' ? { ...x, title: 'Fresh' } : x));
    await s.save(renamed);
    const i = renamed.findIndex((x) => x.id === 'new1');
    const reordered = [...renamed];
    reordered.splice(i, 1);
    reordered.splice(part ? renamed.findIndex((x) => x.id === part.id) + 1 : 0, 0, renamed[i]!);
    await s.save(reordered);
    const doc = s.sections.get(added.docId)!;
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('Synthetic new text.')]);
    doc.getXmlFragment('prosemirror').insert(0, [p]);
    await s.flush();
    await s.close();
    const again = sessionFromStored(be.reload(), null);
    const row = again.outline.value.find((x) => x.id === 'new1')!;
    expect(row.title).toBe('Fresh');
    expect(again.outline.value.map((x) => x.id)).toEqual(reordered.map((x) => x.id));
    expect(firstText(again.sections.get(row.docId)!).toString()).toBe('Synthetic new text.');
    for (const x of stored.sections) {
      expect(again.sections.get(x.docId)!.getXmlFragment('prosemirror').toString()).not.toContain(
        'Synthetic new',
      );
    }
    await again.close();
  });

  it('save() on a closed session rejects and calls nothing', async () => {
    const stored = storedFixture();
    const saveOutline = vi.fn(async () => {});
    const save = vi.fn(async () => {});
    const s = sessionFromStored(stored, null, { save }, saveOutline);
    await s.close();
    await expect(s.save([...s.outline.value].reverse())).rejects.toThrow('closed');
    expect(saveOutline).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
