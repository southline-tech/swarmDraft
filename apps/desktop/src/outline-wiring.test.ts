import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { openStored } from './manuscript-session';
import { storedFixture } from './stored-fixture.test-helper';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(async () => []),
}));

describe('openStored outline wiring (RAD-263)', () => {
  it('saves the outline through manuscript_save_outline with camelCase args and null parents', async () => {
    const stored = storedFixture();
    const s = openStored(stored, null);
    const next = s.outline.value.map((x, i) => (i === 0 ? { ...x, title: 'Renamed' } : x));
    await s.save(next);
    const calls = vi.mocked(invoke).mock.calls.filter(([c]) => c === 'manuscript_save_outline');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({
      manuscriptId: 'db-m',
      outline: next.map((x) => ({
        id: x.id,
        parentId: x.parentId ?? null,
        kind: x.kind,
        title: x.title,
        docId: x.docId,
      })),
    });
    const first = (calls[0]![1] as { outline: { parentId: unknown; title: string }[] }).outline[0]!;
    expect(first).toMatchObject({ parentId: null, title: 'Renamed' });
    await s.close();
  });
});
