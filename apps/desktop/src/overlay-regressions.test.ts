/**
 * Regression specs for overlay layer (#263, #264, #267, #269, #270).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import ReviewPanel from './review/ReviewPanel.vue';
import PairingPrompt from './PairingPrompt.vue';
import { commentReviewKey } from './review/review-inline';
import type { CommentThread } from '@swarmdraft/editor';
import { storedFixture } from './stored-fixture.test-helper';
import type { PairingApi, PairingSummary } from './pairing-client';
import type { Agent } from './backend';
import { ensureOverlayLayer } from './overlay/layer';
import { overlayWrap, queryAllInOverlay } from './overlay/queries';
import { pairingNameCollisionMessage } from './pairing-errors';

const fixture = resolve(
  __dirname,
  '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);
const bytes = () => new Uint8Array(readFileSync(fixture));

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

const settle = async () => {
  await flushPromises();
  await flushPromises();
};

const agentStub = (): Agent => ({
  id: 'a1',
  name: 'QA Bot 1',
  color: '#3366ff',
  createdAt: '2026-01-01T00:00:00Z',
  revokedAt: null,
  primary: false,
  lastSeenAt: null,
});

const thread = (): CommentThread => ({
  id: 'sample-c1',
  anchorText: 'rain',
  order: 0,
  comments: [
    {
      id: 'r1',
      threadId: 'sample-c1',
      body: 'Wet.',
      authorKind: 'human',
      authorId: 'u',
      authorName: 'Mara',
      createdAt: '2026-10-26T00:00:00Z',
      resolvedAt: null,
    },
  ],
  resolved: false,
  orphan: 'none',
});

describe('overlay regressions (audit)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('#264 reply input keeps focus when the review card activates', async () => {
    document.body.innerHTML = '<div id="app-overlay-layer"></div>';
    const w = mount(ReviewPanel, {
      attachTo: document.body,
      props: {
        items: [],
        listItems: [
          {
            kind: 'comment',
            key: commentReviewKey('sample-c1'),
            from: 0,
            thread: thread(),
          },
        ],
      },
    });
    await settle();
    const input = w.get('[data-test="reply-input"]').element as HTMLInputElement;
    input.focus();
    await w.get('[data-test="review-item"]').trigger('click');
    await settle();
    expect(document.activeElement).toBe(input);
    w.unmount();
  });

  it('#267 Export menu mounts in #app-overlay-layer', async () => {
    const w = mount(App, { attachTo: document.body });
    await settle();
    const input = w.find('[data-test="open-docx"]');
    const file = new File([bytes()], 'synthetic.docx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes().buffer });
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await settle();
    await vi.waitFor(() => expect(w.find('[data-test="toolbar-export"]').exists()).toBe(true), {
      timeout: 15000,
    });
    await w.get('[data-test="toolbar-export"]').trigger('click');
    await settle();
    const menu = overlayWrap('[data-test="export-menu"]');
    expect(menu.isVisible()).toBe(true);
    expect(ensureOverlayLayer().contains(menu.element)).toBe(true);
    w.unmount();
  });

  it('#269 one pairing dialog lists every pending request', async () => {
    document.body.innerHTML = '';
    ensureOverlayLayer();
    const pending: PairingSummary[] = [
      {
        id: 'p1',
        name: 'QA Bot 1',
        color: '#3366ff',
        requestedScopes: ['read_manuscript'],
        createdAt: '2026-01-01T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      {
        id: 'p2',
        name: 'QA Bot 2',
        color: '#cc6633',
        requestedScopes: ['read_manuscript'],
        createdAt: '2026-01-01T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    ];
    const api: PairingApi = {
      listPending: vi.fn(async () => pending),
      approve: vi.fn(async () => agentStub()),
      deny: vi.fn(async () => {}),
    };
    const w = mount(PairingPrompt, { props: { api }, attachTo: document.body });
    await settle();
    expect(queryAllInOverlay('[data-test="pairing-row"]')).toHaveLength(2);
    expect(overlayWrap('[data-test="pairing-dialog"]').text()).toContain('QA Bot 1');
    expect(overlayWrap('[data-test="pairing-dialog"]').text()).toContain('QA Bot 2');
    w.unmount();
  });

  it('#270 maps duplicate agent name errors to clear copy', () => {
    const msg = pairingNameCollisionMessage(
      'an agent named "QA Bot 2" already exists; choose another name',
    );
    expect(msg).toContain('A bot named QA Bot 2 already exists');
  });
});
