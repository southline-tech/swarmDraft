/**
 * #261 P0: toolbar must survive section select and draft switch (continuous mode).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { readStructure } from '@swarmdraft/docx';
import App from './App.vue';
import type { StoredManuscript } from './backend';
import { storedFixture } from './stored-fixture.test-helper';
import { sessionFromDocx } from './manuscript-session';

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

function storedWithId(id: string, title: string): StoredManuscript {
  const base = storedFixture();
  return {
    manuscript: { ...base.manuscript, id, title },
    sections: base.sections.map((s) => ({
      ...s,
      manuscriptId: id,
      docId: s.docId.replace(base.manuscript.id, id),
    })),
  };
}

const fixture = resolve(
  __dirname,
  '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);
const bytes = () => new Uint8Array(readFileSync(fixture));
const settle = async () => {
  await flushPromises();
  await flushPromises();
};

function toolbarInRow(w: ReturnType<typeof mount>) {
  const row = w.get('[data-test="toolbar-row"]').element;
  return row.querySelector('[data-test="tb-navigator"]') !== null;
}

async function expectToolbarVisible(w: ReturnType<typeof mount>) {
  await vi.waitFor(
    () => {
      expect(toolbarInRow(w)).toBe(true);
    },
    { timeout: 15000, interval: 50 },
  );
}

async function withManuscript() {
  const w = mount(App, { attachTo: document.body });
  await flushPromises();
  const session = sessionFromDocx(bytes(), 'm1');
  (w.vm as unknown as { open: (s: typeof session) => void }).open(session);
  await settle();
  return { w, session };
}

describe('toolbar survives navigation (#261)', () => {
  enableAutoUnmount(afterEach);

  it('keeps the toolbar host populated when selecting chapters from the outline', async () => {
    const { w, session } = await withManuscript();
    await expectToolbarVisible(w);
    const chapters = readStructure(session.manuscript).filter((s) => s.kind === 'chapter');
    expect(chapters.length).toBeGreaterThan(1);
    for (const ch of chapters.slice(0, 5)) {
      await w.find(`[data-test="section-${ch.id}"]`).trigger('click');
      await settle();
      await expectToolbarVisible(w);
    }
    w.unmount();
  });

  it('keeps the toolbar after switching to another stored draft', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.listManuscripts).mockResolvedValue([
      {
        id: 'm1',
        title: 'First',
        createdAt: '2026-01-01T00:00:00Z',
        numberingStyle: 'chapter_arabic',
      },
      {
        id: 'm2',
        title: 'Second draft',
        createdAt: '2026-01-02T00:00:00Z',
        numberingStyle: 'chapter_arabic',
      },
    ]);
    vi.mocked(backend.loadManuscript).mockImplementation(async (id: string) => {
      if (id === 'm2') return storedWithId('m2', 'Second draft');
      if (id === 'm1') return storedWithId('m1', 'First');
      return null;
    });

    const { w } = await withManuscript();
    await expectToolbarVisible(w);

    async function pickDraft(id: string) {
      await w.find('[data-test="draft-picker"]').trigger('click');
      await settle();
      await w.find(`[data-test="draft-item"][data-draft="${id}"]`).trigger('click');
      await settle();
      await expectToolbarVisible(w);
    }

    await pickDraft('m2');

    for (let i = 0; i < 2; i++) {
      await pickDraft('m1');
      await pickDraft('m2');
    }
    w.unmount();
  }, 30000);
});
