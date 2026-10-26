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
});
