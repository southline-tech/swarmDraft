// #51: accept/reject records persist through the host save path and hydrate after remount.
import { defineComponent, h, ref, type PropType } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import type { DecisionRecord } from '@coauthor/editor';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { SAMPLE_DOC } from '../fixtures/sample';
import * as backend from '../backend';
import { docToYDoc } from '@coauthor/docx';

let stored: DecisionRecord[] = [];

const by = { author: 'agent:sample', ts: '2026-10-25T00:00:00Z' };
const WITH_SUGGESTION: JSONContent = {
  ...SAMPLE_DOC,
  content: [
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [
        { type: 'text', text: 'The lamp ' },
        {
          type: 'text',
          text: 'flickered',
          marks: [{ type: 'suggestion_insert', attrs: { id: 'persist-s1', ...by } }],
        },
        { type: 'text', text: ' softly.' },
      ],
    },
  ],
};
const ACCEPTED: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [{ type: 'text', text: 'The lamp flickered softly.' }],
    },
  ],
};

const tiptapEditor = (w: ReturnType<typeof mount>): Editor =>
  (w.find('.tiptap').element as unknown as { editor: Editor }).editor;

function host() {
  return defineComponent({
    props: {
      content: { type: Object as PropType<JSONContent>, required: true },
      seed: { type: Array as PropType<DecisionRecord[]>, default: () => [] },
    },
    setup(props) {
      const decisionRecords = ref<DecisionRecord[]>([...props.seed]);
      async function onDecisions(records: DecisionRecord[]) {
        decisionRecords.value = records;
        await backend.saveSectionReviewDecisions('manuscript-1', 'section-1', records);
      }
      return () =>
        h(ManuscriptEditor, {
          content: props.content,
          decisionRecords: decisionRecords.value,
          onDecisions,
        });
    },
  });
}

beforeEach(() => {
  stored = [];
  vi.spyOn(backend, 'saveSectionReviewDecisions').mockImplementation(async (_m, _s, records) => {
    stored = records;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('review decision persistence (#51)', () => {
  it('saves on accept and hydrates after remount from stored rows', async () => {
    const w = mount(host(), {
      props: { content: WITH_SUGGESTION, seed: [] },
      attachTo: document.body,
    });
    await flushPromises();
    await w.find('[data-test="accept"]').trigger('click');
    await flushPromises();
    expect(backend.saveSectionReviewDecisions).toHaveBeenCalled();
    expect(stored).toMatchObject([
      { id: 'persist-s1', kind: 'suggestion_insert', status: 'accepted', decidedBy: 'author' },
    ]);
    w.unmount();
    const again = mount(host(), {
      props: { content: ACCEPTED, seed: stored },
      attachTo: document.body,
    });
    await flushPromises();
    expect(again.findAll('[data-test=item]')).toHaveLength(0);
    again.unmount();
  });

  it('undo clears saved records and redo writes them back', async () => {
    const ydoc = docToYDoc(WITH_SUGGESTION as never);
    const w = mount(ManuscriptEditor, {
      props: {
        doc: ydoc,
        decisionRecords: [],
        onDecisions: async (records: DecisionRecord[]) => {
          await backend.saveSectionReviewDecisions('manuscript-1', 'section-1', records);
        },
      },
      attachTo: document.body,
    });
    await flushPromises();
    await w.find('[data-test="accept"]').trigger('click');
    await flushPromises();
    const e = tiptapEditor(w);
    e.commands.undo();
    await flushPromises();
    expect(stored).toEqual([]);
    e.commands.redo();
    await flushPromises();
    expect(stored).toMatchObject([{ id: 'persist-s1', status: 'accepted' }]);
    w.unmount();
  });
});
