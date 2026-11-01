import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AgentsWindow from './AgentsWindow.vue';
import type { Agent, AgentDraftAccess, StoredManuscriptRow } from '../backend';

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>();
  return {
    ...actual,
    agentsApi: {
      ...actual.agentsApi,
      draftAccessList: vi.fn(async () => [] as AgentDraftAccess[]),
      setDraftAccessMode: vi.fn(async () => {}),
      grantDraft: vi.fn(async () => {}),
      revokeDraft: vi.fn(async () => {}),
      bulkGrantCurrentDraft: vi.fn(async () => {}),
      bulkGrantAllDrafts: vi.fn(async () => {}),
      bulkRevokeAllDrafts: vi.fn(async () => {}),
    },
  };
});

import { agentsApi } from '../backend';

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  color: '#3366ff',
  createdAt: 't',
  revokedAt: null,
  primary: false,
  lastSeenAt: null,
});

const drafts: StoredManuscriptRow[] = [
  { id: 'm1', title: 'Lanterns', createdAt: '2026-01-02', numberingStyle: 'chapter_arabic' },
  { id: 'm2', title: 'Tide', createdAt: '2026-01-01', numberingStyle: 'chapter_arabic' },
];

function mountWindow(overrides: Record<string, unknown> = {}) {
  return mount(AgentsWindow, {
    props: {
      agents: [agent('a1', 'Copy Bot')],
      manuscripts: drafts,
      currentManuscriptId: 'm1',
      batchBanner: false,
      initialSelectedAgentIds: [],
      ...overrides,
    },
    attachTo: document.body,
  });
}

describe('AgentsWindow', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('shows batch banner with current draft title (ba2)', async () => {
    const w = mountWindow({
      batchBanner: true,
      currentDraftTitle: 'Lanterns',
      initialSelectedAgentIds: ['a1', 'a2', 'a3', 'a4', 'a5'],
    });
    await flushPromises();
    const banner = w.get('[data-test="agents-batch-banner"]');
    expect(banner.text()).toBe(
      '5 bots paired · each starts with access to Lanterns only. Adjust below or use bulk actions.',
    );
  });

  it('bulk bar appears when an agent is selected', async () => {
    vi.mocked(agentsApi.draftAccessList).mockResolvedValue([
      { agentId: 'a1', mode: 'selected', manuscriptIds: [] },
    ]);
    const w = mountWindow({ initialSelectedAgentIds: ['a1'] });
    await flushPromises();
    const bar = w.get('[data-test="agents-bulk-bar"]');
    expect(bar.attributes('role')).toBe('toolbar');
    expect(bar.attributes('aria-label')).toBe('Bulk draft access actions');
  });

  it('bulk grant current calls IPC with selected ids and current draft', async () => {
    vi.mocked(agentsApi.draftAccessList).mockResolvedValue([
      { agentId: 'a1', mode: 'selected', manuscriptIds: [] },
    ]);
    const w = mountWindow({ initialSelectedAgentIds: ['a1'], currentManuscriptId: 'm1' });
    await flushPromises();
    await w.get('[data-test="bulk-grant-current"]').trigger('click');
    await flushPromises();
    expect(agentsApi.bulkGrantCurrentDraft).toHaveBeenCalledWith(['a1'], 'm1');
  });

  it('Escape closes the dialog', async () => {
    const w = mountWindow();
    await flushPromises();
    await w.get('[data-test="agents-window"]').trigger('keydown', { key: 'Escape' });
    expect(w.emitted('close')).toHaveLength(1);
  });
});
