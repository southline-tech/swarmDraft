/** New-draft QA regression coverage (#285). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import { storedFixture } from './stored-fixture.test-helper';
import { sessionFromDocx } from './manuscript-session';
import { overlayWrap } from './overlay/queries';

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

const fixture = resolve(
  __dirname,
  '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);
const bytes = () => new Uint8Array(readFileSync(fixture));

const settle = async () => {
  await flushPromises();
  await flushPromises();
};

async function chooseFile(w: ReturnType<typeof mount>) {
  const input = w.get('[data-test="open-docx"]');
  const file = new File([bytes()], 'synthetic.docx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes().buffer });
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await settle();
}

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
  peekResumeManuscript: vi.fn(async () => null),
  openLatestManuscript: vi.fn(async () => null),
  listManuscripts: vi.fn(async () => []),
  createBlankManuscript: vi.fn(async () => null),
  loadManuscript: vi.fn(async () => null),
  persistImport: vi.fn(async () => storedFixture()),
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
}));

enableAutoUnmount(afterEach);

describe('new-draft QA (#285)', () => {
  it('cold start opens the manuscript returned by openLatestManuscript (#280)', async () => {
    const backend = await import('./backend');
    const lastActive = storedFixture();
    lastActive.manuscript = {
      ...lastActive.manuscript,
      id: 'last-active-id',
      title: 'Last active draft',
    };
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(lastActive);
    vi.mocked(backend.peekResumeManuscript).mockResolvedValueOnce({
      id: lastActive.manuscript.id,
      title: lastActive.manuscript.title,
      createdAt: '2026-01-01T00:00:00Z',
      numberingStyle: 'chapter_arabic',
    });
    const w = mount(App, { attachTo: document.body });
    await settle();
    expect(backend.openLatestManuscript).toHaveBeenCalled();
    expect(w.find('[data-test="draft-picker"]').text()).toContain('Last active draft');
    w.unmount();
  });

  it('imported .docx title appears in the toolbar draft picker (#285)', async () => {
    const backend = await import('./backend');
    const imported = storedFixture();
    vi.mocked(backend.persistImport).mockResolvedValueOnce(imported);
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    expect(w.find('[data-test="draft-picker"]').text()).toContain(imported.manuscript.title);
    w.unmount();
  });

  it('toolbar New creates a blank draft without opening the docx picker (#285)', async () => {
    const backend = await import('./backend');
    const blank = storedFixture();
    blank.manuscript = { ...blank.manuscript, id: 'blank-toolbar', title: 'Untitled draft' };
    vi.mocked(backend.createBlankManuscript).mockResolvedValueOnce(blank);
    const w = mount(App, { attachTo: document.body });
    await settle();
    const session = sessionFromDocx(bytes(), 'm1');
    (w.vm as unknown as { open: (s: typeof session) => void }).open(session);
    await settle();
    vi.mocked(backend.createBlankManuscript).mockClear();
    vi.mocked(backend.persistImport).mockClear();
    const fileInput = w.get('[data-test="open-docx"]');
    const clickSpy = vi.spyOn(fileInput.element as HTMLInputElement, 'click');
    await w.find('[data-test="draft-picker"]').trigger('click');
    await settle();
    await overlayWrap('[data-test="draft-new"]').trigger('click');
    await settle();
    expect(backend.createBlankManuscript).toHaveBeenCalledTimes(1);
    expect(backend.persistImport).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    clickSpy.mockRestore();
    w.unmount();
  });
});
