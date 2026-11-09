/** Accept passes the change id into the draft commit, and comment edits ask for a checkpoint (#116). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import ContinuousManuscript from './ContinuousManuscript.vue';
import { sessionFromDocx } from './manuscript-session';

const invoke = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn(async () => {}),
    onCloseRequested: vi.fn(async () => () => {}),
    destroy: vi.fn(async () => {}),
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('./pairing-client', () => ({
  pairingApi: {
    listPending: vi.fn(async () => []),
    approve: vi.fn(async () => ({})),
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
  },
  getAppInfo: vi.fn(async () => ({
    version: '0.2.1',
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
  sectionCommentReply: vi.fn(async () => ({ id: 'reply' })),
  sectionCommentResolve: vi.fn(async () => {}),
  loadNotesState: vi.fn(async () => null),
  notesApplyUpdate: vi.fn(async () => {}),
  listenOpeningProgress: vi.fn(async () => () => {}),
  listenOpenDraftPath: vi.fn(async () => () => {}),
  draftTakeLaunchPath: vi.fn(async () => null),
  draftOpen: vi.fn(async () => null),
  draftOpenPath: vi.fn(async () => null),
  draftSave: vi.fn(async () => ({ status: 'committed' as const, oid: null })),
  draftSaveAs: vi.fn(async () => null),
  draftCheckpoint: vi.fn(async () => 'oid'),
  draftBeginSession: vi.fn(async () => 'sess'),
  draftEndSession: vi.fn(async () => {}),
  draftHistory: vi.fn(async () => []),
  draftRestore: vi.fn(async () => 'oid'),
  draftReviewCommit: vi.fn(async () => 'oid'),
  draftResolveChange: vi.fn(async () => ({ result: 'notFound', changeId: 'x' })),
}));

enableAutoUnmount(afterEach);

const fixture = resolve(
  __dirname,
  '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);
const bytes = () => new Uint8Array(readFileSync(fixture));

async function openBook() {
  const w = mount(App, { attachTo: document.body });
  await flushPromises();
  const session = sessionFromDocx(bytes(), 'm-backbone');
  (w.vm as unknown as { open: (s: typeof session) => void }).open(session);
  await flushPromises();
  return { w, session };
}

describe('draft backbone wiring (#116)', () => {
  it('passes the accepted change id, kind, and section to the review commit', async () => {
    const backend = await import('./backend');
    const { w, session } = await openBook();
    const sectionId = session.outline.value.find((s) => s.kind === 'chapter')!.id;
    vi.mocked(backend.draftReviewCommit).mockClear();
    w.findComponent(ContinuousManuscript).vm.$emit(
      'decisions',
      sectionId,
      [
        {
          id: 'chg-1',
          kind: 'suggestion_insert',
          status: 'accepted',
          decidedAt: '2026-01-02T00:00:00.000Z',
          decidedBy: 'author',
        },
      ],
      'agent:bot-1',
    );
    await flushPromises();
    expect(backend.draftReviewCommit).toHaveBeenCalledWith({
      manuscriptId: session.id,
      accepted: true,
      botName: 'agent:bot-1',
      chapterTitle: expect.any(String),
      botAgentId: 'bot-1',
      suggestionId: 'chg-1',
      kind: 'suggestion_insert',
      sectionId,
    });
    w.unmount();
  });

  it('asks for a checkpoint after a comment reply and a resolve', async () => {
    const backend = await import('./backend');
    const { w, session } = await openBook();
    const sectionId = session.outline.value.find((s) => s.kind === 'chapter')!.id;
    vi.mocked(backend.draftCheckpoint).mockClear();
    const manuscript = w.findComponent(ContinuousManuscript);
    manuscript.vm.$emit('comment-reply', sectionId, 'thread-1', 'Thanks');
    await flushPromises();
    manuscript.vm.$emit('comment-resolve', sectionId, 'thread-1', true);
    await flushPromises();
    expect(backend.draftCheckpoint).toHaveBeenCalledTimes(2);
    expect(backend.draftCheckpoint).toHaveBeenCalledWith(
      session.id,
      expect.stringMatching(/^Edited /),
    );
    w.unmount();
  });
});
