/** Change-link toasts and a failed flush before switching books (#117). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { docToYDoc, writeStructure } from '@swarmdraft/docx';
import { addSection } from '@swarmdraft/editor';
import App from '../App.vue';
import { SAMPLE_DOC } from '../fixtures/sample';
import { COPY_LINK_FAILURE, COPY_LINK_SUCCESS } from './link-codec';
import { openSession, sessionFromDocx } from '../manuscript-session';
import { ensureOverlayLayer } from '../overlay/layer';
import { storedFixture } from '../stored-fixture.test-helper';

const captured = vi.hoisted(() => ({
  onUrl: null as null | ((url: string) => void),
}));

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
vi.mock('../pairing-client', () => ({
  pairingApi: {
    listPending: vi.fn(async () => []),
    approve: vi.fn(async () => ({})),
    deny: vi.fn(async () => {}),
  },
}));

vi.mock('../backend', async (orig) => ({
  ...(await orig<typeof import('../backend')>()),
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
  listManuscripts: vi.fn(async () => []),
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
  linksTakeLaunchUrl: vi.fn(async () => null),
  linksResolve: vi.fn(async () => ({
    action: 'focus' as const,
    manuscriptId: 'other-book',
    sectionId: 'sec-1',
    changeId: 'chg-1',
  })),
  listenChangeLinks: vi.fn(async (onUrl: (url: string) => void) => {
    captured.onUrl = onUrl;
    return () => {};
  }),
}));

enableAutoUnmount(afterEach);

const fixture = resolve(
  __dirname,
  '../../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);
const bytes = () => new Uint8Array(readFileSync(fixture));
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const settle = async () => {
  await flushPromises();
  await frame();
  await flushPromises();
};

function sampleBook() {
  const outline = addSection([], {
    manuscriptId: 'book-17',
    kind: 'chapter',
    title: 'One',
    id: 'ch-1',
  });
  const manuscript = new Y.Doc();
  writeStructure(manuscript, outline);
  const doc = docToYDoc(SAMPLE_DOC as never);
  return openSession(
    'book-17',
    'Sample Book',
    manuscript,
    new Map([[outline[0]!.docId, doc]]),
    null,
  );
}

function linkToast() {
  return document.querySelector('[data-test="change-link-toast"]');
}

describe('change link in the app (#117)', () => {
  it('shows the copy toast for success and for a clipboard failure', async () => {
    ensureOverlayLayer();
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text);
        },
        readText: async () => '',
      },
    });
    const w = mount(App, { attachTo: document.body });
    await settle();
    const session = sampleBook();
    (w.vm as unknown as { open: (s: typeof session) => void }).open(session);
    await settle();
    const mark = w.get('ins[data-id="sample-s1"]');
    await mark.trigger('contextmenu', { clientX: 40, clientY: 40 });
    await settle();
    await w.get('[data-test="ctx-copy_link"]').trigger('click');
    await settle();
    expect(written).toEqual(['swarmdraft://open?draft=book-17&change=sample-s1']);
    expect(linkToast()?.textContent).toContain(COPY_LINK_SUCCESS);
    expect(linkToast()?.querySelector('.toast__icon--alert')).toBeNull();

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied');
        },
        readText: async () => '',
      },
    });
    await mark.trigger('contextmenu', { clientX: 40, clientY: 40 });
    await settle();
    await w.get('[data-test="ctx-copy_link"]').trigger('click');
    await settle();
    expect(linkToast()?.textContent).toContain(COPY_LINK_FAILURE);
    expect(linkToast()?.textContent).not.toContain(COPY_LINK_SUCCESS);
    expect(linkToast()?.querySelector('.toast__icon--alert')).not.toBeNull();
    w.unmount();
  }, 20_000);

  it('stays on the open book when the flush before a change link fails', async () => {
    ensureOverlayLayer();
    const backend = await import('../backend');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const other = storedFixture();
    other.manuscript = { ...other.manuscript, id: 'other-book', title: 'Other book' };
    vi.mocked(backend.loadManuscript).mockResolvedValue(other);
    const w = mount(App, { attachTo: document.body });
    await settle();
    expect(captured.onUrl).toBeTypeOf('function');
    const session = sessionFromDocx(bytes(), 'm1');
    (w.vm as unknown as { open: (s: typeof session) => void }).open(session);
    await settle();
    session.flush = () => Promise.reject(new Error('io: database is locked'));
    vi.mocked(backend.loadManuscript).mockClear();
    captured.onUrl!('swarmdraft://open?draft=other-book&change=chg-1');
    await settle();
    expect(backend.loadManuscript).not.toHaveBeenCalled();
    expect(document.title).toBe(session.title);
    expect(document.title).not.toContain('Other book');
    expect(w.get('[data-test="open-error"]').text()).toContain("Couldn't switch books");
    expect(w.get('[data-test="save-error"]').text()).not.toContain('database is locked');
    log.mockRestore();
    w.unmount();
  }, 20_000);
});
