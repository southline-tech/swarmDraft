/** Pilot QA #336: Ctrl+S in the unsaved state, and Save As can be repeated. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import { storedFixture } from './stored-fixture.test-helper';

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
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(async () => {}),
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

function proseDom(w: ReturnType<typeof mount>): HTMLElement {
  const lead = w.find('[data-test="lead-editor"] .ProseMirror');
  return (lead.exists() ? lead.element : w.get('.ProseMirror').element) as HTMLElement;
}

function editorOf(w: ReturnType<typeof mount>) {
  const lead = w.find('[data-test="lead-editor"] .tiptap');
  const el = (lead.exists() ? lead.element : w.get('.tiptap').element) as unknown as {
    editor: import('@tiptap/core').Editor;
  };
  return el.editor;
}

function keyOn(el: EventTarget, init: KeyboardEventInit) {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
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
    version: '0.2.2',
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
  draftOpen: vi.fn(async () => null),
  draftOpenPath: vi.fn(async () => null),
  draftSave: vi.fn(async () => ({ status: 'committed' as const, oid: 'abc' })),
  draftSaveAs: vi.fn(async () => null),
  draftCheckpoint: vi.fn(async () => null),
  draftHistory: vi.fn(async () => []),
  draftRestore: vi.fn(async () => 'oid'),
  draftReviewCommit: vi.fn(async () => null),
  saveManuscriptCopy: vi.fn(async () => 'D:\\Copies\\book.docx'),
  listenOpenDraftPath: vi.fn(async () => () => {}),
  draftTakeLaunchPath: vi.fn(async () => null),
}));

enableAutoUnmount(afterEach);

const RAW = 'io: database is locked C:\\secret\\coauthor.db';

async function openBook() {
  const w = mount(App, { attachTo: document.body });
  await settle();
  await chooseFile(w);
  await vi.waitFor(() => {
    const pm = proseDom(w);
    expect(pm.getAttribute('contenteditable')).toBe('true');
  });
  return w;
}

describe('Ctrl+S while changes are not saved yet (#336)', () => {
  it('from the editor, retries the save and writes the draft file when the retry works', async () => {
    const backend = await import('./backend');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = await openBook();
    vi.mocked(backend.draftSave).mockClear();
    keyOn(w.get('[data-test="open-docx"]').element, { key: 's', ctrlKey: true });
    await settle();
    expect(backend.draftSave).not.toHaveBeenCalled();

    vi.mocked(backend.saveSectionUpdate).mockRejectedValue(RAW);
    editorOf(w).commands.insertContentAt(1, 'UNSAVED ');
    await vi.waitFor(() => expect(w.find('[data-test="save-error"]').exists()).toBe(true));
    expect(w.find('[data-test="save-error"]').text()).toContain("aren't saved yet");
    expect(w.find('[data-test="save-error"]').text()).not.toContain('database is locked');
    expect(w.find('[data-test="save-error"]').text()).not.toContain('coauthor.db');

    const waiters: Array<() => void> = [];
    vi.mocked(backend.saveSectionUpdate).mockImplementation(
      () =>
        new Promise((resolve) => {
          waiters.push(() => resolve(undefined));
        }),
    );
    vi.mocked(backend.draftSave).mockClear();
    const savesBefore = vi.mocked(backend.saveSectionUpdate).mock.calls.length;
    keyOn(proseDom(w), { key: 's', ctrlKey: true });
    await vi.waitFor(() =>
      expect(vi.mocked(backend.saveSectionUpdate).mock.calls.length).toBeGreaterThan(savesBefore),
    );
    expect(w.find('[data-test="save-error"]').exists()).toBe(true);
    for (const release of waiters) release();
    await vi.waitFor(() => expect(backend.draftSave).toHaveBeenCalled());
    await vi.waitFor(() => expect(w.find('[data-test="save-error"]').exists()).toBe(false));
    w.unmount();
    log.mockRestore();
    vi.mocked(backend.saveSectionUpdate).mockReset().mockResolvedValue(undefined);
  });

  it('from the editor, shows the plain warning when the save still fails', async () => {
    const backend = await import('./backend');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = await openBook();
    vi.mocked(backend.saveSectionUpdate).mockRejectedValue(RAW);
    editorOf(w).commands.insertContentAt(1, 'STILL ');
    await vi.waitFor(() => expect(w.find('[data-test="save-error"]').exists()).toBe(true));
    vi.mocked(backend.draftSave).mockClear();
    const savesBefore = vi.mocked(backend.saveSectionUpdate).mock.calls.length;
    keyOn(proseDom(w), { key: 's', ctrlKey: true });
    await vi.waitFor(() =>
      expect(vi.mocked(backend.saveSectionUpdate).mock.calls.length).toBeGreaterThan(savesBefore),
    );
    await settle();
    expect(backend.draftSave).not.toHaveBeenCalled();
    const banner = w.find('[data-test="save-error"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("aren't saved yet");
    expect(banner.text()).not.toContain(RAW);
    expect(banner.text()).not.toContain('database is locked');
    w.unmount();
    log.mockRestore();
    vi.mocked(backend.saveSectionUpdate).mockReset().mockResolvedValue(undefined);
  });
});

describe('Save As can be repeated (#336)', () => {
  it('run, cancel, run, success — a second press while the first is open is ignored', async () => {
    const backend = await import('./backend');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = await openBook();
    let release!: (path: string | null) => void;
    vi.mocked(backend.draftSaveAs).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const press = () => keyOn(proseDom(w), { key: 's', ctrlKey: true, shiftKey: true });
    press();
    await vi.waitFor(() => expect(backend.draftSaveAs).toHaveBeenCalledTimes(1));
    press();
    await settle();
    expect(backend.draftSaveAs).toHaveBeenCalledTimes(1);
    release(null);
    await settle();
    expect(w.find('[data-test="save-error"]').exists()).toBe(false);

    press();
    await vi.waitFor(() => expect(backend.draftSaveAs).toHaveBeenCalledTimes(2));
    release('D:\\Books\\Pilot.draft');
    await vi.waitFor(() => expect(w.find('[data-test="save-error"]').exists()).toBe(false));
    expect(backend.draftSaveAs).toHaveBeenCalledTimes(2);
    w.unmount();
    log.mockRestore();
    vi.mocked(backend.draftSaveAs).mockReset().mockResolvedValue(null);
  });

  it('run, error, run, success — the guard resets and the banner clears', async () => {
    const backend = await import('./backend');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = await openBook();
    vi.mocked(backend.draftSaveAs).mockRejectedValueOnce(new Error(RAW));
    const press = () => keyOn(proseDom(w), { key: 'S', ctrlKey: true, shiftKey: true });
    press();
    await vi.waitFor(() => expect(w.find('[data-test="save-error"]').exists()).toBe(true));
    expect(w.find('[data-test="save-error"]').text()).toContain("aren't saved yet");
    expect(w.find('[data-test="save-error"]').text()).not.toContain(RAW);
    expect(w.find('[data-test="save-error"]').text()).not.toContain('coauthor.db');

    vi.mocked(backend.draftSaveAs).mockResolvedValueOnce('D:\\Books\\Pilot.draft');
    press();
    await vi.waitFor(() => expect(backend.draftSaveAs).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(w.find('[data-test="save-error"]').exists()).toBe(false));
    w.unmount();
    log.mockRestore();
    vi.mocked(backend.draftSaveAs).mockReset().mockResolvedValue(null);
  });
});
