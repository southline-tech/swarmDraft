import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { yDocToDoc } from '@coauthor/docx';
import { sessionFromStored } from './manuscript-session';
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

  it('keeps a failed save pending and retries it on the next flush', async () => {
    const stored = storedFixture();
    const save = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue(undefined);
    const onError = vi.fn();
    const s = sessionFromStored(stored, null, { save, onError, debounceMs: 60_000 });
    const doc = s.sections.get(stored.sections[1]!.docId)!;
    firstText(doc).insert(0, 'Y');
    await s.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    await s.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![1]).toEqual(save.mock.calls[0]![1]);
    await s.close();
  });

  it('retries a failing batch on its own, then drops it after maxAttempts', async () => {
    const stored = storedFixture();
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('locked'))
      .mockRejectedValueOnce(new Error('locked'))
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const s = sessionFromStored(stored, null, {
      save,
      onError,
      debounceMs: 60_000,
      maxAttempts: 3,
    });
    const doc = s.sections.get(stored.sections[1]!.docId)!;
    firstText(doc).insert(0, 'A');
    await s.flush(); // attempt 1 fails
    const bad = save.mock.calls[0]![1];
    firstText(doc).insert(0, 'B');
    await s.flush(); // attempt 2 of the failed batch alone; B waits, unmerged
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![1]).toEqual(bad);
    await s.flush(); // attempt 3 fails: dropped; B is saved on its own
    expect(onError.mock.calls.map((c) => c[1])).toEqual([
      { dropped: false },
      { dropped: false },
      { dropped: true },
    ]);
    expect(save).toHaveBeenCalledTimes(4);
    const later = save.mock.calls[3]![1] as Uint8Array;
    expect(later).not.toEqual(bad);
    const d = new Y.Doc();
    Y.applyUpdate(d, Uint8Array.from(stored.sections[1]!.state));
    Y.applyUpdate(d, bad);
    Y.applyUpdate(d, later);
    expect(firstText(d).toString().startsWith('BA')).toBe(true);
    await s.flush();
    expect(save).toHaveBeenCalledTimes(4);
    await s.close();
  });
});
