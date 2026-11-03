/** Story notes bottom sheet (#277): needs isTauri() true (ESM-safe mock). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import { queryInOverlay } from './overlay/queries';
import { sessionFromDocx } from './manuscript-session';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn(async () => {}),
    onCloseRequested: vi.fn(async () => () => {}),
  }),
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
  getAppInfo: vi.fn(async () => ({
    version: '0.1.0',
    dataDir: '/tmp/x',
    schemaVersion: 1,
    computerName: 'TestWriter',
  })),
  persistImport: vi.fn(async () => null),
  openLatestManuscript: vi.fn(async () => null),
  listManuscripts: vi.fn(async () => []),
  saveSectionUpdate: vi.fn(async () => {}),
  saveOutline: vi.fn(async () => {}),
  loadNotesState: vi.fn(async () => null),
  pollUpdates: vi.fn(async () => ({ updates: [], cursor: 0 })),
  notesApplyUpdate: vi.fn(async () => {}),
  listenOpeningProgress: vi.fn(async () => () => {}),
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

describe('story notes sheet (#277)', () => {
  it('does not reflow the workspace when notes are open', async () => {
    const { w } = await withManuscript();
    const toggle = w.get('[data-test="status-notes-toggle"]');
    await toggle.trigger('click');
    await settle();
    expect(w.find('[data-test="story-notes-col"]').exists()).toBe(false);
    const ws = w.get('[data-test="workspace"]').classes().join(' ');
    expect(ws).not.toContain('story-notes');
    expect(ws).not.toContain('minmax(0,0fr)');
    expect(queryInOverlay('[data-test="story-notes-sheet"]')).not.toBeNull();
    w.unmount();
  });

  it('closes on Esc inside the sheet and returns focus to the status toggle', async () => {
    const { w } = await withManuscript();
    const toggle = w.get('[data-test="status-notes-toggle"]');
    await toggle.trigger('click');
    await settle();
    const sheet = queryInOverlay('[data-test="story-notes-sheet"]') as HTMLElement;
    sheet.focus();
    sheet.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();
    expect(queryInOverlay('[data-test="story-notes-sheet"]')).toBeNull();
    expect(
      document.activeElement === toggle.element || toggle.element.contains(document.activeElement),
    ).toBe(true);
    w.unmount();
  });
});
