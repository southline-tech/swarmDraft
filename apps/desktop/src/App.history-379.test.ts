/** #379: after a git checkpoint, History shows Saved and the new version. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import App from './App.vue';
import ContinuousManuscript from './ContinuousManuscript.vue';
import { DRAFT_IDLE_CHECKPOINT_MS } from './draft-idle-sync';
import { SAVE_DEBOUNCE_MS } from './manuscript-session';
import { storedFixture } from './stored-fixture.test-helper';

const historyGate = vi.hoisted(() => ({ ready: false }));

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: () => true,
  invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    onCloseRequested: vi.fn(async () => () => {}),
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

const emptyFeed = {
  rows: [],
  filterOptions: [],
  authorLabel: 'You',
  wordCount: 0,
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
  loadManuscript: vi.fn(async () => null),
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
  draftCheckpoint: vi.fn(async () => {
    historyGate.ready = true;
    return 'oid-1';
  }),
  draftFileBehind: vi.fn(async () => true),
  draftPackIfDue: vi.fn(async () => false),
  draftBeginSession: vi.fn(async () => 'sess'),
  draftEndSession: vi.fn(async () => {}),
  draftHistoryFeed: vi.fn(async () =>
    historyGate.ready
      ? {
          rows: [
            {
              id: 'newest',
              oid: 'newest',
              kind: 'authorEdit' as const,
              actorName: 'You',
              isBot: false,
              timeUnix: 1_700_000_000,
              summaryTitle: 'You edited One',
              chapterTitle: 'One',
            },
          ],
          filterOptions: [],
          authorLabel: 'You',
          wordCount: 30,
        }
      : emptyFeed,
  ),
  draftHistory: vi.fn(async () => []),
  draftRestore: vi.fn(async () => 'oid'),
  draftReviewCommit: vi.fn(async () => null),
  listenOpenDraftPath: vi.fn(async () => () => {}),
  draftTakeLaunchPath: vi.fn(async () => null),
}));

enableAutoUnmount(afterEach);

const settle = async () => {
  await flushPromises();
  await flushPromises();
};

function pokeSection(sections: Map<string, Y.Doc>): boolean {
  for (const doc of sections.values()) {
    const block = doc.getXmlFragment('prosemirror').get(0);
    if (!(block instanceof Y.XmlElement)) continue;
    const leaf = block.get(0);
    if (leaf instanceof Y.XmlText) {
      leaf.insert(0, 'q');
      return true;
    }
  }
  return false;
}

describe('history after autosave (#379)', () => {
  afterEach(() => {
    historyGate.ready = false;
    vi.useRealTimers();
  });

  it('shows Saved and the new version after a git checkpoint, without packing a draft', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.draftPackIfDue).mockClear();
    vi.mocked(backend.draftCheckpoint).mockClear();
    const w = mount(App, { attachTo: document.body });
    await settle();
    const tab = document.body.querySelector('[data-test="dock-tab-history"]') as HTMLElement;
    expect(tab).toBeTruthy();
    tab.click();
    await settle();
    expect(document.body.querySelector('[data-test="history-empty"]')?.textContent).toContain(
      'No history yet',
    );

    vi.useFakeTimers();
    const sections = w.findComponent(ContinuousManuscript).props('sections') as Map<string, Y.Doc>;
    expect(pokeSection(sections)).toBe(true);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50);
    await settle();
    await vi.advanceTimersByTimeAsync(DRAFT_IDLE_CHECKPOINT_MS + 50);
    await settle();

    expect(backend.draftCheckpoint).toHaveBeenCalled();
    expect(backend.draftPackIfDue).not.toHaveBeenCalled();
    const card = document.body.querySelector('[data-test="history-current-card"]');
    expect(card?.textContent).toContain('Saved');
    expect(card?.textContent).not.toContain('Unsaved changes');
    const row = document.body.querySelector('[data-test="history-row"]');
    expect(row?.textContent).toContain('You edited One');
    expect(document.body.textContent).not.toMatch(/Invalid Date|NaN/);
    w.unmount();
  });
});
