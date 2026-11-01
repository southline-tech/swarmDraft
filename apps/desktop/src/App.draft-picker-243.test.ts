/** Toolbar draft picker wiring (#243): needs isTauri() true (ESM-safe mock). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import { storedFixture } from './stored-fixture.test-helper';
import { sessionFromDocx } from './manuscript-session';

const setTitle = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: () => true,
  invoke: vi.fn(async () => []),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: setTitle,
    onCloseRequested: vi.fn(async () => () => {}),
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

const fixture = resolve(
  __dirname,
  '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);
const bytes = () => new Uint8Array(readFileSync(fixture));
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
  createBackup: vi.fn(async () => true),
  getRecoveryNotices: vi.fn(async () => []),
  persistImport: vi.fn(async () => storedFixture()),
  openLatestManuscript: vi.fn(async () => null),
  listManuscripts: vi.fn(async () => []),
  createBlankManuscript: vi.fn(async () => null),
  loadManuscript: vi.fn(async () => null),
  saveSectionUpdate: vi.fn(async () => {}),
  saveOutline: vi.fn(async () => {}),
  dismissRecoveryNotices: vi.fn(async () => {}),
  getMigrationNotices: vi.fn(async () => []),
  dismissMigrationNotices: vi.fn(async () => {}),
  saveManuscriptCopy: vi.fn(async () => 'D:\\Copies\\book.docx'),
  restoreBackup: vi.fn(async () => ({ tokensRevoked: 2 })),
  listenOpeningProgress: vi.fn(async () => () => {}),
  manuscriptReviewDecisions: vi.fn(async () => ({})),
  saveSectionReviewDecisions: vi.fn(async () => {}),
  sectionReviewMeta: vi.fn(async () => ({
    comments: [],
    authorSavedNames: {},
    suggestionReasons: {},
  })),
}));

enableAutoUnmount(afterEach);

async function withManuscript() {
  const w = mount(App, { attachTo: document.body });
  await flushPromises();
  const session = sessionFromDocx(bytes(), 'm1');
  (w.vm as unknown as { open: (s: typeof session) => void }).open(session);
  await settle();
  return { w, session };
}

describe('toolbar draft picker (#243)', () => {
  it('creates a blank draft from the picker', async () => {
    const backend = await import('./backend');
    const blank = storedFixture();
    blank.manuscript = { ...blank.manuscript, id: 'blank-new', title: 'Untitled draft' };
    vi.mocked(backend.createBlankManuscript).mockResolvedValueOnce(blank);
    const { w } = await withManuscript();
    await w.find('[data-test="draft-picker"]').trigger('click');
    await settle();
    await w.find('[data-test="draft-new"]').trigger('click');
    await settle();
    expect(backend.createBlankManuscript).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="draft-picker"]').text()).toContain('Untitled draft');
    await vi.waitFor(
      () => {
        expect(document.activeElement?.closest('.ProseMirror')).not.toBeNull();
      },
      { timeout: 12_000 },
    );
    w.unmount();
  }, 20_000);

  it('switches drafts from the picker', async () => {
    const backend = await import('./backend');
    const stored = storedFixture();
    const other = {
      ...stored,
      manuscript: { ...stored.manuscript, id: 'draft-b', title: 'Second draft' },
    };
    vi.mocked(backend.listManuscripts).mockResolvedValue([
      {
        id: 'm1',
        title: 'First',
        createdAt: '2026-01-01T00:00:00Z',
        numberingStyle: 'chapter_arabic',
      },
      {
        id: other.manuscript.id,
        title: other.manuscript.title,
        createdAt: '2026-01-02T00:00:00Z',
        numberingStyle: 'chapter_arabic',
      },
    ]);
    vi.mocked(backend.loadManuscript).mockResolvedValueOnce(other);
    const { w } = await withManuscript();
    await w.find('[data-test="draft-picker"]').trigger('click');
    await settle();
    await w.find(`[data-test="draft-item"][data-draft="${other.manuscript.id}"]`).trigger('click');
    await settle();
    expect(backend.loadManuscript).toHaveBeenCalledWith(other.manuscript.id);
    expect(w.find('[data-test="draft-picker"]').text()).toContain('Second draft');
    w.unmount();
  });
});
