/** #385: selecting another chapter must not close compare for the whole book. */
import { defineComponent, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { docToYDoc } from '@swarmdraft/docx';
import * as Y from 'yjs';
import ContinuousManuscript from '../ContinuousManuscript.vue';
import { sampleOutline } from '../fixtures/outline-sample';
import type { DraftHistoryCompare } from '../backend';

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
          title: 'Harbor dawn',
          hasChanges: true,
          segments: [{ kind: 'same' as const, text: 'Chapter one line.' }],
        },
        {
          sectionId: 'ch-2',
          title: 'After the bell',
          hasChanges: true,
          segments: [{ kind: 'add' as const, text: 'Chapter two added.' }],
        },
      ],
    })),
    draftMilestonesList: vi.fn(async () => []),
  };
});

const plain = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const TwoChapterBook = defineComponent({
  components: { ContinuousManuscript },
  props: {
    outline: { type: Array, required: true },
    sections: { type: Object, required: true },
  },
  setup() {
    const selected = ref('ch-1');
    const banner = ref<string | null>(null);
    const segments = ref<Record<string, { kind: 'same' | 'add' | 'remove'; text: string }[]>>({});
    function onCompare(_oid: string, data: DraftHistoryCompare) {
      banner.value = 'Comparing with a past save. Read only.';
      const map: Record<string, { kind: 'same' | 'add' | 'remove'; text: string }[]> = {};
      for (const ch of data.chapters) {
        if (ch.segments?.length) map[ch.sectionId] = ch.segments;
      }
      segments.value = map;
    }
    function onClose() {
      banner.value = null;
      segments.value = {};
    }
    return { selected, banner, segments, onCompare, onClose };
  },
  template: `
    <ContinuousManuscript
      :outline="outline"
      :sections="sections"
      :selected-id="selected"
      :reload-token="0"
      manuscript-id="m1"
      right-dock-open
      right-dock-tab="history"
      :history-compare-banner="banner"
      :history-compare-segments-by-section="segments"
      @update:selected-id="selected = $event"
      @history-compare="onCompare"
      @history-close-compare="onClose"
    />
    <button type="button" data-test="select-ch-2" @click="selected = 'ch-2'">Chapter two</button>
  `,
});

describe('history compare across chapters (#385)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
        constructor() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the other chapter segments when selection moves', async () => {
    const outline = sampleOutline();
    const sections = new Map<string, Y.Doc>();
    for (const sec of outline) {
      const json = sec.id === 'ch-1' ? plain('Chapter one line.') : plain('Chapter two added.');
      sections.set(sec.docId, docToYDoc(json as never));
    }
    const w = mount(TwoChapterBook, {
      props: { outline, sections },
      attachTo: document.body,
    });
    await flushPromises();
    await w.find('[data-test="history-compare"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="lead-editor"] [data-test="history-compare-body"]').text()).toContain(
      'Chapter one line.',
    );
    await w.find('[data-test="select-ch-2"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="history-compare-banner"]').exists()).toBe(true);
    const body = w.get('[data-test="lead-editor"] [data-test="history-compare-body"]');
    expect(body.text()).toContain('Chapter two added.');
    expect(body.find('.history-compare-insert').exists()).toBe(true);
    w.unmount();
  });
});
