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

  it('shows batch banner when requested', async () => {
    const w = mountWindow({ batchBanner: true });
    await flushPromises();
    expect(w.find('[data-test="agents-batch-banner"]').exists()).toBe(true);
  });

  it('bulk bar appears when an agent is selected', async () => {
    vi.mocked(agentsApi.draftAccessList).mockResolvedValue([
      { agentId: 'a1', mode: 'selected', manuscriptIds: [] },
    ]);
    const w = mountWindow({ initialSelectedAgentIds: ['a1'] });
    await flushPromises();
    expect(w.find('[data-test="agents-bulk-bar"]').exists()).toBe(true);
  });

  it('bulk grant current calls IPC with selected ids and current draft', async () => {
    vi.mocked(agentsApi.draftAccessList).mockResolvedValue([
      { agentId: 'a1', mode: 'selected', manuscriptIds: [] },
    ]);
    const w = mountWindow({ initialSelectedAgentIds: ['a1'], currentManuscriptId: 'm1' });
    await flushPromises();
    await w.get('[data-test="agents-bulk-current"]').trigger('click');
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
