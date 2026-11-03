/** Last-active draft resume and Recent flyout width (#280). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: () => true,
  invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn(async () => {}),
    onCloseRequested: vi.fn(async () => () => {}),
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('./pairing-client', () => ({
  pairingApi: {
    listPending: vi.fn(async () => []),
    approve: vi.fn(async () => ({
      id: 'a1',
      name: 'Bot',
      color: '#3366ff',
      createdAt: '2026-01-01T00:00:00Z',
      revokedAt: null,
      isPrimary: false,
      lastSeenAt: null,
    })),
    deny: vi.fn(async () => {}),
  },
}));

vi.mock('./backend', async (orig) => ({
  ...(await orig<typeof import('./backend')>()),
  agentsApi: {
    list: vi.fn(async () => []),
    primaryId: vi.fn(async () => null),
    tokens: vi.fn(async () => []),
    setUserDisplayName: vi.fn(async (name: string) => name),
    draftAccessList: vi.fn(async () => []),
    setDraftAccessMode: vi.fn(async () => {}),
    grantDraft: vi.fn(async () => {}),
    revokeDraft: vi.fn(async () => {}),
    bulkGrantCurrentDraft: vi.fn(async () => {}),
    bulkGrantAllDrafts: vi.fn(async () => {}),
    bulkRevokeAllDrafts: vi.fn(async () => {}),
  },
  getAppInfo: vi.fn(async () => ({
    version: '0.1.0',
    dataDir: '/tmp/x',
    schemaVersion: 1,
    computerName: 'TestWriter',
  })),
  getRecoveryNotices: vi.fn(async () => []),
  getMigrationNotices: vi.fn(async () => []),
  peekResumeManuscript: vi.fn(async () => ({
    id: 'resume-id',
    title: 'Resume Me',
    createdAt: '2020-01-01T00:00:00Z',
    numberingStyle: 'chapter_arabic',
  })),
  listManuscripts: vi.fn(async () => [
    {
      id: 'newest-list',
      title: 'Wrong List Title',
      createdAt: '2026-06-01T00:00:00Z',
      numberingStyle: 'chapter_arabic',
    },
  ]),
  openLatestManuscript: vi.fn(async () => null),
  listenOpeningProgress: vi.fn(async () => () => {}),
  loadManuscript: vi.fn(async () => null),
  createBlankManuscript: vi.fn(async () => null),
  persistImport: vi.fn(async () => null),
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
}));

enableAutoUnmount(afterEach);

describe('last-active draft (#280)', () => {
  it('opening progress title matches peek resume candidate, not listManuscripts order', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = await import('./backend');
    let finish!: () => void;
    const pending = new Promise<null>((resolve) => {
      finish = () => resolve(null);
    });
    vi.mocked(backend.openLatestManuscript).mockImplementationOnce(() => pending);
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(200);
    const progress = w.find('[data-test="opening-progress"]');
    expect(progress.exists()).toBe(true);
    expect(progress.text()).toContain('Resume Me');
    expect(progress.text()).not.toContain('Wrong List Title');
    finish();
    await flushPromises();
    w.unmount();
    vi.useRealTimers();
  });

  it('Recent flyout uses 220px width with higher specificity than the 240px book menu', () => {
    const sfc = readFileSync(resolve(__dirname, 'App.vue'), 'utf8');
    const css = [...sfc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
    expect(css).toMatch(
      /\.topbar__menu-list\.sh-menu\.topbar__recent-flyout\s*\{[^}]*width:\s*220px/,
    );
    expect(css.split('\n').some((line) => /^\s*\.topbar__recent-flyout\s*\{/.test(line))).toBe(
      false,
    );
  });
});
