/** #193 review: native Quit flushes, and Finder opens are not dropped before the listener exists. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { invoke } from '@tauri-apps/api/core';
import App from './App.vue';
import { MACOS_QUIT_EVENT } from './backend';
import { storedFixture } from './stored-fixture.test-helper';

const bridge = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  destroy: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: () => true,
  invoke: vi.fn(async (cmd: string) => (cmd === 'agents_list' ? [] : null)),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn(async () => {}),
    destroy: bridge.destroy,
    onCloseRequested: vi.fn(async () => () => {}),
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: () => void) => {
    bridge.listeners.set(name, cb);
    return () => {
      bridge.listeners.delete(name);
    };
  }),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(async () => false),
}));
vi.mock('./pairing-client', () => ({
  pairingApi: {
    listPending: vi.fn(async () => []),
    approve: vi.fn(async () => ({})),
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

vi.mock('./backend', async (orig) => ({
  ...(await orig<typeof import('./backend')>()),
  agentsApi: {
    list: vi.fn(async () => []),
    primaryId: vi.fn(async () => null),
    tokens: vi.fn(async () => []),
    setUserDisplayName: vi.fn(async (name: string) => name),
  },
  getAppInfo: vi.fn(async () => null),
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
  draftSave: vi.fn(async () => ({ status: 'committed' as const, oid: null })),
  draftSaveAs: vi.fn(async () => null),
  draftCheckpoint: vi.fn(async () => null),
  draftHistory: vi.fn(async () => []),
  draftRestore: vi.fn(async () => 'oid'),
  draftReviewCommit: vi.fn(async () => null),
  listenOpenDraftPath: vi.fn(async () => () => {}),
  draftTakeLaunchPath: vi.fn(async () => null),
}));

enableAutoUnmount(afterEach);

afterEach(() => {
  bridge.listeners.clear();
  bridge.destroy.mockReset();
});

async function chooseFile(w: ReturnType<typeof mount>) {
  const input = w.get('[data-test="open-docx"]');
  const file = new File([bytes()], 'synthetic.docx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes().buffer });
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await settle();
}

function editorOf(w: ReturnType<typeof mount>) {
  const lead = w.find('[data-test="lead-editor"] .tiptap');
  const el = (lead.exists() ? lead.element : w.get('.tiptap').element) as unknown as {
    editor: import('@tiptap/core').Editor;
  };
  return el.editor;
}

describe('macOS quit and Finder open (#193 review)', () => {
  it('takes the launch path only after the Finder listener is registered', async () => {
    const backend = await import('./backend');
    let releaseListen: (unlisten: () => void) => void = () => {};
    vi.mocked(backend.listenOpenDraftPath).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseListen = resolve;
        }),
    );
    vi.mocked(backend.draftTakeLaunchPath).mockResolvedValue('/tmp/finder.draft');
    const w = mount(App, { attachTo: document.body });
    await settle();
    expect(backend.draftTakeLaunchPath).not.toHaveBeenCalled();
    expect(backend.draftOpenPath).not.toHaveBeenCalled();
    releaseListen(() => {});
    await settle();
    expect(backend.draftTakeLaunchPath).toHaveBeenCalledTimes(1);
    expect(backend.draftOpenPath).toHaveBeenCalledWith('/tmp/finder.draft', false);
    w.unmount();
  });

  it('native Quit flushes a dirty section before the window is destroyed', async () => {
    const backend = await import('./backend');
    const w = mount(App, { attachTo: document.body });
    await settle();
    expect(bridge.listeners.has(MACOS_QUIT_EVENT)).toBe(true);
    await chooseFile(w);
    await vi.waitFor(() => {
      const pm = w.get('.ProseMirror').element as HTMLElement;
      expect(pm.getAttribute('contenteditable')).toBe('true');
    });
    let releaseSave: () => void = () => {};
    vi.mocked(backend.saveSectionUpdate).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSave = () => resolve(undefined);
        }),
    );
    editorOf(w).commands.insertContentAt(1, 'UNSAVED ');
    bridge.listeners.get(MACOS_QUIT_EVENT)!();
    await flushPromises();
    expect(backend.saveSectionUpdate).toHaveBeenCalled();
    expect(bridge.destroy).not.toHaveBeenCalled();
    releaseSave();
    await vi.waitFor(() => expect(bridge.destroy).toHaveBeenCalledTimes(1));
    w.unmount();
  });

  it('declining an unsaved quit clears the macOS quit gate', async () => {
    const backend = await import('./backend');
    const w = mount(App, { attachTo: document.body });
    await settle();
    await chooseFile(w);
    await vi.waitFor(() => {
      const pm = w.get('.ProseMirror').element as HTMLElement;
      expect(pm.getAttribute('contenteditable')).toBe('true');
    });
    vi.mocked(backend.saveSectionUpdate).mockRejectedValue(new Error('locked'));
    const before = vi
      .mocked(invoke)
      .mock.calls.filter((call) => call[0] === 'macos_quit_cancelled').length;
    editorOf(w).commands.insertContentAt(1, 'UNSAVED ');
    bridge.listeners.get(MACOS_QUIT_EVENT)!();
    await vi.waitFor(() => {
      const after = vi
        .mocked(invoke)
        .mock.calls.filter((call) => call[0] === 'macos_quit_cancelled').length;
      expect(after).toBe(before + 1);
    });
    expect(bridge.destroy).not.toHaveBeenCalled();
    w.unmount();
  });
});
