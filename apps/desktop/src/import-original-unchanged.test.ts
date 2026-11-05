/** RAD-270 (#34): import reads the Word file only; edits never touch the original on disk. */
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import { storedFixture } from './stored-fixture.test-helper';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('./backend', async (orig) => ({
  ...(await orig<typeof import('./backend')>()),
  agentsApi: {
    list: vi.fn(async () => []),
    primaryId: vi.fn(async () => null),
    tokens: vi.fn(async () => []),
    setUserDisplayName: vi.fn(async (name: string) => name),
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
  peekResumeManuscript: vi.fn(async () => null),
  listManuscripts: vi.fn(async () => []),
  createBlankManuscript: vi.fn(async () => null),
  loadManuscript: vi.fn(async () => null),
  saveSectionUpdate: vi.fn(async () => {}),
  saveOutline: vi.fn(async () => {}),
  dismissRecoveryNotices: vi.fn(async () => {}),
  getMigrationNotices: vi.fn(async () => []),
  dismissMigrationNotices: vi.fn(async () => {}),
  saveManuscriptCopy: vi.fn(async () => 'D:\\Copies\\book.docx'),
  restoreBackup: vi.fn(async () => ({ tokensRevoked: 0 })),
  listenOpeningProgress: vi.fn(async () => () => {}),
  manuscriptReviewDecisions: vi.fn(async () => ({})),
  saveSectionReviewDecisions: vi.fn(async () => {}),
  sectionReviewMeta: vi.fn(async () => ({
    comments: [],
    authorSavedNames: {},
    suggestionReasons: {},
  })),
  loadNotesState: vi.fn(async () => null),
  pollUpdates: vi.fn(async () => ({ updates: [], cursor: 0 })),
  notesApplyUpdate: vi.fn(async () => {}),
}));

enableAutoUnmount(afterEach);

const fixture = resolve(
  __dirname,
  '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);

function digest(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const settle = async () => {
  await flushPromises();
  await flushPromises();
};

describe('original Word file on disk (RAD-270)', () => {
  it('bytes and modified time stay the same after import, edit, autosave and close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmdraft-rad270-'));
    const onDisk = join(dir, 'author-manuscript.docx');
    copyFileSync(fixture, onDisk);
    const before = { hash: digest(onDisk), mtimeMs: statSync(onDisk).mtimeMs };

    const bytes = readFileSync(onDisk);
    localStorage.setItem('swarmdraft.welcomed', '1');
    const w = mount(App, { attachTo: document.body });
    await flushPromises();

    const input = w.find('[data-test="open-docx"]');
    const file = new File([bytes], 'author-manuscript.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await settle();

    await vi.waitFor(() => expect(w.find('.tiptap').exists()).toBe(true));
    const editor = (
      w.find('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    editor.commands.insertContentAt(1, 'RAD270 ');
    await settle();
    expect(JSON.stringify(editor.getJSON())).toContain('RAD270');

    w.unmount();
    await settle();

    expect(digest(onDisk)).toBe(before.hash);
    expect(statSync(onDisk).mtimeMs).toBe(before.mtimeMs);
  });
});
