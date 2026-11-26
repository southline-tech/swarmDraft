/** #384 paragraph breaks in the compare body, #385 shared Close compare. */
import { defineComponent, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { SAMPLE_DOC } from '../fixtures/sample';

vi.mock('../backend', async (orig) => {
  const actual = await orig<typeof import('../backend')>();
  return {
    ...actual,
    draftHistoryFeed: vi.fn(async () => ({
      rows: [
        {
          id: 'save-1',
          oid: 'save-1',
          kind: 'save' as const,
          actorName: 'You',
          isBot: false,
          timeUnix: 1_700_000_000,
          summaryTitle: 'You saved your book',
        },
      ],
      filterOptions: [],
      authorLabel: 'You',
      wordCount: 40,
    })),
    draftHistoryCompare: vi.fn(async () => ({
      oid: 'save-1',
      timeUnix: 1_700_000_000,
      wordCountThen: 10,
      wordCountNow: 12,
      chapters: [
        {
          sectionId: 'ch-1',
          title: 'Chapter One',
          hasChanges: true,
          segments: [{ kind: 'add' as const, text: 'Alpha four added.' }],
        },
      ],
    })),
    draftHistoryRestorePreview: vi.fn(async () => ({
      titleLabel: 'You · Nov 17, 10:22 AM',
      restoreTimeUnix: 1_700_000_000,
      wordCount: 10,
      pendingReviewCount: 0,
      keptMilestoneName: 'Before restoring · Nov 17',
      isMilestone: false,
    })),
    draftRestoreVersion: vi.fn(async () => ({ oid: 'save-1', milestoneOid: 'ms' })),
    draftMilestonesList: vi.fn(async () => []),
    draftMilestoneCreate: vi.fn(async () => null),
    draftMilestoneDelete: vi.fn(async () => {}),
  };
});

const Harness = defineComponent({
  components: { ManuscriptEditor },
  setup() {
    const banner = ref<string | null>(null);
    return { banner, content: SAMPLE_DOC };
  },
  template: `
    <ManuscriptEditor
      :content="content"
      manuscript-id="m1"
      right-dock-managed
      right-dock-open
      right-dock-tab="history"
      :history-compare-banner="banner"
      :history-compare-segments="[{ kind: 'same', text: 'Alpha one stays.' }, { kind: 'same', text: '\\n\\n' }, { kind: 'add', text: 'Alpha four added.' }, { kind: 'remove', text: 'was here.' }]"
      @history-compare="banner = 'Comparing with a past save. Read only.'"
      @history-close-compare="banner = null"
    />
  `,
});

describe('history compare close (#385)', () => {
  it('banner close resets History panel compare mode', async () => {
    const w = mount(Harness, { attachTo: document.body });
    await flushPromises();
    await w.find('[data-test="history-compare"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="history-compare-side"]').exists()).toBe(true);
    expect(w.find('[data-test="history-compare-banner"]').exists()).toBe(true);
    await w.find('[data-test="history-compare-close"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="history-compare-side"]').exists()).toBe(false);
    expect(w.find('[data-test="history-compare-banner"]').exists()).toBe(false);

    await w.find('[data-test="history-compare"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="history-compare-side"]').exists()).toBe(true);
    expect(w.find('[data-test="history-compare-banner"]').exists()).toBe(true);
    await w.find('[data-test="history-panel-close-compare"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="history-compare-side"]').exists()).toBe(false);
    expect(w.find('[data-test="history-compare-banner"]').exists()).toBe(false);
    w.unmount();
  });

  it('shows paragraph breaks with underlined additions and struck removals (#384)', async () => {
    const w = mount(ManuscriptEditor, {
      props: {
        content: SAMPLE_DOC,
        historyCompareBanner: 'Comparing. Read only.',
        historyCompareSegments: [
          { kind: 'same', text: 'Alpha one stays.' },
          { kind: 'same', text: '\n\n' },
          { kind: 'add', text: 'Alpha four added.' },
          { kind: 'remove', text: 'was here.' },
        ],
      },
      attachTo: document.body,
    });
    await flushPromises();
    const body = w.get('[data-test="history-compare-body"]');
    expect(body.text()).toContain('Alpha one stays.');
    expect(body.text()).toContain('Alpha four added.');
    expect(body.text()).not.toContain('<!--block');
    expect(body.text()).toMatch(/stays\.\s*\n\s*Alpha four/);
    expect(body.find('.history-compare-insert').classes()).toContain('history-compare-insert');
    expect(body.find('.history-compare-delete').exists()).toBe(true);
    w.unmount();
  });

  it('banner close still clears compare after focus mode remounts History', async () => {
    const w = mount(Harness, { attachTo: document.body });
    await flushPromises();
    await w.find('[data-test="history-compare"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="history-compare-banner"]').exists()).toBe(true);
    expect(w.find('[data-test="history-compare-body"]').exists()).toBe(true);
    await w.find('[data-test="focus-mode"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="history-panel"]').exists()).toBe(false);
    expect(w.find('[data-test="history-compare-banner"]').exists()).toBe(true);
    await w.find('[data-test="focus-exit"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="history-panel"]').exists()).toBe(true);
    expect(w.find('[data-test="history-compare-side"]').exists()).toBe(false);
    expect(w.find('[data-test="history-compare-banner"]').exists()).toBe(true);
    expect(w.find('[data-test="history-compare-body"]').exists()).toBe(true);
    await w.find('[data-test="history-compare-close"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="history-compare-banner"]').exists()).toBe(false);
    expect(w.find('[data-test="history-compare-body"]').exists()).toBe(false);
    w.unmount();
  });

  it('underlines an added hard break and strikes a removed one (#384)', async () => {
    const w = mount(ManuscriptEditor, {
      props: {
        content: SAMPLE_DOC,
        historyCompareBanner: 'Comparing. Read only.',
        historyCompareSegments: [
          { kind: 'same', text: '\n\n' },
          { kind: 'add', text: 'First line\nsecond line' },
          { kind: 'remove', text: 'Old line\nstill old' },
        ],
      },
      attachTo: document.body,
    });
    await flushPromises();
    const body = w.get('[data-test="history-compare-body"]');
    const inserted = body.get('.history-compare-insert');
    const removed = body.get('.history-compare-delete');
    expect(inserted.text()).toContain('First line');
    expect(inserted.text()).toContain('second line');
    expect(inserted.element.textContent).toContain('\n');
    expect(removed.text()).toContain('Old line');
    expect(removed.text()).toContain('still old');
    expect(removed.element.textContent).toContain('\n');
    const gap = [...body.element.querySelectorAll('span')].find(
      (span) => span.textContent === '\n\n',
    );
    expect(gap).toBeTruthy();
    expect(gap!.classList.contains('history-compare-insert')).toBe(false);
    expect(gap!.classList.contains('history-compare-delete')).toBe(false);
    w.unmount();
  });
});
