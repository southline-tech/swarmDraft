import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import HistoryPanel from './HistoryPanel.vue';

vi.mock('../backend', () => ({
  draftHistoryFeed: vi.fn(async () => ({
    rows: [
      {
        id: 'abc123',
        oid: 'abc123',
        kind: 'authorEdit',
        actorName: 'You',
        isBot: false,
        timeUnix: 1_700_000_000,
        summaryTitle: 'You edited Chapter 3',
        chapterTitle: 'Chapter 3',
      },
    ],
    filterOptions: [{ key: 'agent:1', label: 'Line Editor', isBot: true }],
    authorLabel: 'You',
    wordCount: 100,
  })),
  draftHistoryRestorePreview: vi.fn(async () => ({
    titleLabel: 'You · Nov 17, 10:22 AM',
    restoreTimeUnix: 1_700_000_000,
    wordCount: 48_164,
    pendingReviewCount: 0,
    keptMilestoneName: 'Before restoring · Nov 17',
    isMilestone: false,
  })),
  draftRestoreVersion: vi.fn(async () => ({
    oid: 'abc123',
    milestoneOid: 'ms1',
    milestoneName: 'Before restoring',
  })),
  draftHistoryCompare: vi.fn(async () => ({
    oid: 'abc123',
    timeUnix: 1_700_000_000,
    wordCountThen: 40_000,
    wordCountNow: 48_000,
    chapters: [],
  })),
  draftMilestonesList: vi.fn(async () => []),
  draftMilestoneCreate: vi.fn(async () => null),
  draftMilestoneDelete: vi.fn(async () => {}),
}));

describe('History panel', () => {
  it('keeps dock layout rules in shells.css', () => {
    const vue = readFileSync(resolve(__dirname, 'HistoryPanel.vue'), 'utf8');
    const css = readFileSync(resolve(__dirname, '../shells/shells.css'), 'utf8');
    expect(vue).not.toMatch(/<style/);
    expect(vue).not.toMatch(/Teleport/);
    expect(css).toMatch(/\.history-panel\s*\{/);
    expect(css).toMatch(/\.right-dock\s*\{/);
    expect(css).toMatch(/\.history-panel__confirm-actions\s*\{/);
  });

  it('lists activity in the dock and asks before restore', async () => {
    const w = mount(HistoryPanel, {
      props: { active: true, manuscriptId: 'm1', wordCount: 1200 },
      attachTo: document.body,
    });
    await flushPromises();
    const panel = w.find('[data-test="history-panel"]');
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain('You edited Chapter 3');
    expect(document.body.querySelector('[data-test="history-scrim"]')).toBeNull();
    const restore = w.find('[data-test="history-restore"]');
    expect(restore.exists()).toBe(true);
    await restore.trigger('click');
    await flushPromises();
    await w.find('[data-test="compare-restore"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="history-restore-confirm"]').exists()).toBe(true);
    expect(w.text()).toContain('Keep a copy and restore');
    w.unmount();
  });

  it('shows empty state copy', async () => {
    const { draftHistoryFeed } = await import('../backend');
    vi.mocked(draftHistoryFeed).mockResolvedValueOnce({
      rows: [],
      filterOptions: [],
      authorLabel: 'You',
      wordCount: 0,
    });
    const w = mount(HistoryPanel, {
      props: { active: true, manuscriptId: 'm1' },
    });
    await flushPromises();
    expect(w.find('[data-test="history-empty"]').text()).toContain('No history yet');
    w.unmount();
  });

  it('shows empty filter copy', async () => {
    const w = mount(HistoryPanel, {
      props: { active: true, manuscriptId: 'm1' },
    });
    await flushPromises();
    const { draftHistoryFeed } = await import('../backend');
    vi.mocked(draftHistoryFeed).mockResolvedValueOnce({
      rows: [
        {
          id: 'b1',
          oid: 'b1',
          kind: 'bot',
          actorName: 'Line Editor',
          isBot: true,
          agentId: 'agent:1',
          timeUnix: 1_700_000_000,
        },
      ],
      filterOptions: [{ key: 'agent:1', label: 'Line Editor', isBot: true }],
      authorLabel: 'You',
      wordCount: 0,
    });
    await w.setProps({ active: false });
    await w.setProps({ active: true });
    await flushPromises();
    w.find('[data-test="history-filter"]').trigger('click');
    await flushPromises();
    w.unmount();
  });
});
