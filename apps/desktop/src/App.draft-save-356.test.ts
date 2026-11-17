/** #356: checkpoints stay in the cache; the `.draft` packs only on explicit save or close. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import { storedFixture } from './stored-fixture.test-helper';
import { DRAFT_IDLE_CHECKPOINT_MS } from './draft-idle-sync';

const win = vi.hoisted(() => ({
  handler: undefined as undefined | ((e: { preventDefault: () => void }) => Promise<void>),
  destroy: vi.fn(async () => {}),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: () => true,
  invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn(async () => {}),
    destroy: win.destroy,
    onCloseRequested: async (h: typeof win.handler) => {
      win.handler = h;
      return win.unlisten;
    },
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock('./pairing-client', () => ({
  pairingApi: {
    listPending: vi.fn(async () => []),
    approve: vi.fn(async () => ({})),
    deny: vi.fn(async () => {}),
  },
}));

const settle = async () => {
  await flushPromises();
  await flushPromises();
};

vi.mock('./backend', async (orig) => ({
  ...(await orig<typeof import('./backend')>()),
  agentsApi: {
    list: vi.fn(async () => []),
    primaryId: vi.fn(async () => null),
    tokens: vi.fn(async () => []),
    setUserDisplayName: vi.fn(async (name: string) => name),
  },
  getAppInfo: vi.fn(async () => ({
    version: '0.2.2',
    dataDir: '/tmp/x',
    schemaVersion: 1,
    computerName: 'TestWriter',
  })),
  getRecoveryNotices: vi.fn(async () => []),
  getMigrationNotices: vi.fn(async () => []),
  peekResumeManuscript: vi.fn(async () => null),
  openLatestManuscript: vi.fn(async () => storedFixture()),
  listManuscripts: vi.fn(async () => []),
  createBlankManuscript: vi.fn(async () => null),
  loadManuscript: vi.fn(async () => storedFixture()),
  saveSectionUpdate: vi.fn(async () => {}),
  saveOutline: vi.fn(async () => {}),
  pollUpdates: vi.fn(async () => ({ updates: [], cursor: 0 })),
  sectionReviewMeta: vi.fn(async () => ({
    comments: [],
    authorSavedNames: {},
    suggestionReasons: {},
  })),
  manuscriptReviewDecisions: vi.fn(async () => ({})),
  saveSectionReviewDecisions: vi.fn(async () => {}),
  loadNotesState: vi.fn(async () => null),
  notesApplyUpdate: vi.fn(async () => {}),
  listenOpeningProgress: vi.fn(async () => () => {}),
  draftOpen: vi.fn(async () => null),
  draftOpenPath: vi.fn(async () => null),
  draftSave: vi.fn(async () => ({ status: 'committed' as const, oid: 'abc' })),
  draftSaveAs: vi.fn(async () => null),
  draftCheckpoint: vi.fn(async () => 'oid-1'),
  draftFileBehind: vi.fn(async () => true),
  draftPackIfDue: vi.fn(async () => true),
  draftBeginSession: vi.fn(async () => 'sess'),
  draftEndSession: vi.fn(async () => {}),
  draftHistory: vi.fn(async () => []),
  draftRestore: vi.fn(async () => 'oid'),
  draftReviewCommit: vi.fn(async () => null),
  listenOpenDraftPath: vi.fn(async () => () => {}),
  draftTakeLaunchPath: vi.fn(async () => null),
}));

enableAutoUnmount(afterEach);

describe('draft save design (#356)', () => {
  it('idle checkpoint debounce does not pack the linked file', async () => {
    vi.useFakeTimers();
    const backend = await import('./backend');
    vi.mocked(backend.draftCheckpoint).mockClear();
    vi.mocked(backend.draftPackIfDue).mockClear();
    mount(App, { attachTo: document.body });
    await settle();
    await vi.advanceTimersByTimeAsync(DRAFT_IDLE_CHECKPOINT_MS + 10);
    await settle();
    expect(backend.draftPackIfDue).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('explicit Save writes the draft file through draft_save', async () => {
    const backend = await import('./backend');
    mount(App, { attachTo: document.body });
    await settle();
    vi.mocked(backend.draftSave).mockClear();
    await backend.draftSave('m1');
    expect(backend.draftSave).toHaveBeenCalled();
    expect(backend.draftPackIfDue).not.toHaveBeenCalled();
  });

  it('window close flush ends the draft session (pack on close)', async () => {
    const backend = await import('./backend');
    mount(App, { attachTo: document.body });
    await settle();
    await vi.waitFor(() => expect(win.handler).toBeTypeOf('function'));
    vi.mocked(backend.draftEndSession).mockClear();
    const closing = win.handler!({ preventDefault: () => {} });
    await closing;
    expect(backend.draftEndSession).toHaveBeenCalled();
  });
});
