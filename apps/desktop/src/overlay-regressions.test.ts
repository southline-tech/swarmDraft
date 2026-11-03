/**
 * Regression specs for overlay / remount audit (docs/audits/overlay-remount-audit.md).
 * Uses it.fails until the linked issue is fixed so CI stays green on main.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import type { CommentRow } from '@swarmdraft/editor';
import App from './App.vue';
import ManuscriptEditor from './ManuscriptEditor.vue';
import PairingPrompt from './PairingPrompt.vue';
import { storedFixture } from './stored-fixture.test-helper';
import type { PairingApi, PairingSummary } from './pairing-client';

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
    authorSavedNames: {},
    suggestionReasons: {},
  })),
}));

const SAMPLE_DOC = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          marks: [{ type: 'comment_anchor', attrs: { id: 'sample-c1' } }],
          text: 'rain',
        },
      ],
    },
  ],
};

const settle = async () => {
  await flushPromises();
  await flushPromises();
};

describe('overlay regressions (audit)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it.fails('#264 reply input keeps focus while typing (Review card)', async () => {
    const Harness = defineComponent({
      components: { ManuscriptEditor },
      setup() {
        const commentRows = ref<CommentRow[]>([
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
        ]);
        return { commentRows };
      },
      template: `
    <ManuscriptEditor
      manuscript-id="m1"
      section-id="sec1"
      :doc="doc"
      :comment-rows="commentRows"
      review-target="#review-rail"
    />
    <div id="review-rail" />
  `,
      data: () => ({ doc: SAMPLE_DOC }),
    });
    const w = mount(Harness, { attachTo: document.body });
    await settle();
    const input = w.get('[data-test="reply-input"]').element as HTMLInputElement;
    await input.focus();
    input.value = 'Typing';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Typing');
    w.unmount();
  });

  it.fails('#267 Export menu uses the shared overlay layer above panels (#267)', async () => {
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
    const menu = w.get('[data-test="export-menu"]');
    expect(menu.isVisible()).toBe(true);
    expect(document.querySelector('[data-test="app-overlay-layer"]')).toBeTruthy();
    expect(menu.element.closest('[data-test="app-overlay-layer"]')).toBeTruthy();
    w.unmount();
  });

  it.fails('#269 one pairing modal lists every pending request', async () => {
    const pending: PairingSummary[] = [
      {
        id: 'p1',
        name: 'QA Bot 1',
        color: '#3366ff',
        requestedScopes: ['read_manuscript'],
        expiresAt: '2099-01-01T00:00:00Z',
      },
      {
        id: 'p2',
        name: 'QA Bot 2',
        color: '#cc6633',
        requestedScopes: ['read_manuscript'],
        expiresAt: '2099-01-01T00:00:00Z',
      },
    ];
    const api: PairingApi = {
      listPending: vi.fn(async () => pending),
      approve: vi.fn(async () => ({
        id: 'a1',
        name: 'QA Bot 1',
        color: '#3366ff',
        scopes: ['read_manuscript'],
      })),
      deny: vi.fn(async () => {}),
    };
    const w = mount(PairingPrompt, { props: { api }, attachTo: document.body });
    await settle();
    expect(w.find('[data-test="pairing-dialog"]').exists()).toBe(true);
    const text = w.get('[data-test="pairing-dialog"]').text();
    expect(text).toContain('QA Bot 1');
    expect(text).toContain('QA Bot 2');
    w.unmount();
  });
});
