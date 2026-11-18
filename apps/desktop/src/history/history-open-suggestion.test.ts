import { defineComponent, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import OldChangeView from '../links/OldChangeView.vue';
import type { OldChangeViewModel } from '../links/open-link';
import HistoryPanel from './HistoryPanel.vue';

const historyView = (): OldChangeViewModel => ({
  manuscriptId: 'm1',
  changeId: 'chg-1',
  sectionId: 'sec-1',
  quote: 'guttered',
  kind: 'suggestion_insert',
  authorName: 'Line Editor',
  authorKind: 'agent',
  outcome: 'accepted',
  decidedBy: 'You',
  decidedAt: 1_700_000_000,
});

vi.mock('../backend', () => ({
  draftHistoryFeed: vi.fn(async () => ({
    rows: [
      {
        id: 'bot-row-1',
        oid: 'bot-oid',
        kind: 'bot',
        actorName: 'Line Editor',
        isBot: true,
        agentId: 'agent:1',
        timeUnix: 1_700_000_000,
        children: [
          {
            changeId: 'chg-1',
            sectionId: 'sec-1',
            status: 'accepted',
            quote: 'guttered',
            deciderName: 'You',
            chapterTitle: 'Chapter 1',
            timeUnix: 1_700_000_000,
          },
        ],
      },
    ],
    filterOptions: [],
    authorLabel: 'You',
    wordCount: 100,
  })),
  draftHistoryRestorePreview: vi.fn(),
  draftRestoreVersion: vi.fn(),
  draftHistoryCompare: vi.fn(),
  draftMilestonesList: vi.fn(async () => []),
  draftMilestoneCreate: vi.fn(),
  draftMilestoneDelete: vi.fn(),
}));

const Harness = defineComponent({
  components: { HistoryPanel, OldChangeView },
  setup() {
    const historyTab = ref(true);
    const expandedBotRowId = ref<string | null>(null);
    const oldChange = ref<OldChangeViewModel | null>(null);
    const focusHistory = vi.fn();
    function onOpenSuggestion(changeId: string, _sectionId: string, botRowId: string) {
      expandedBotRowId.value = botRowId;
      oldChange.value = historyView();
      void changeId;
    }
    function onOldChangeClose() {
      oldChange.value = null;
      historyTab.value = true;
      focusHistory();
    }
    return {
      historyTab,
      expandedBotRowId,
      oldChange,
      focusHistory,
      onOpenSuggestion,
      onOldChangeClose,
    };
  },
  template: `
    <div>
      <HistoryPanel
        v-show="historyTab && !oldChange"
        :active="historyTab && !oldChange"
        manuscript-id="m1"
        :expanded-bot-row-id="expandedBotRowId"
        @open-suggestion="onOpenSuggestion"
      />
      <OldChangeView
        v-if="oldChange"
        :view="oldChange"
        :focus-editor="focusHistory"
        @close="onOldChangeClose"
      />
    </div>
  `,
});

describe('History open suggestion', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens old-change view and returns to History with the bot row still expanded', async () => {
    const w = mount(Harness, { attachTo: document.body });
    await flushPromises();
    const expand = w.find('[data-test="history-row"] .history-panel__disclosure');
    expect(expand.exists()).toBe(true);
    await expand.trigger('click');
    const child = w.find('.history-panel__child');
    await child.trigger('click');
    await flushPromises();
    expect(document.querySelector('[data-test="old-change-view"]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-test="old-change-back"]')!.click();
    await flushPromises();
    expect(document.querySelector('[data-test="old-change-view"]')).toBeNull();
    expect(w.vm.focusHistory).toHaveBeenCalled();
    const disclosure = w.find('[data-test="history-row"] .history-panel__disclosure');
    expect(disclosure.attributes('aria-expanded')).toBe('true');
    expect(w.find('.history-panel__child').exists()).toBe(true);
    w.unmount();
  });
});
