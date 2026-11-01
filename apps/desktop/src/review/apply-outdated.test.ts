// #178: accept through review/apply marks overlapping suggestions outdated in the index.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { JSONContent } from '@tiptap/core';
import { createManuscriptEditor } from '@swarmdraft/editor';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import * as backend from '../backend';
import { applyHumanReviewDecision, persistOutdatedAfterAccept } from './apply';

const byA = { author: 'agent:a', ts: '2026-10-25T00:00:00Z' };
const byB = { author: 'agent:b', ts: '2026-10-25T00:00:00Z' };

const OVERLAP: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [
        { type: 'text', text: 'a ' },
        {
          type: 'text',
          text: 'bright',
          marks: [
            { type: 'suggestion_insert', attrs: { id: 'x1', ...byA } },
            { type: 'suggestion_delete', attrs: { id: 'y1', ...byB } },
          ],
        },
        {
          type: 'text',
          text: ' day',
          marks: [{ type: 'suggestion_delete', attrs: { id: 'y1', ...byB } }],
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.spyOn(backend, 'saveSectionReviewDecisions').mockResolvedValue(undefined);
  vi.spyOn(backend, 'markSectionSuggestionsOutdated').mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('applyHumanReviewDecision wiring (#178)', () => {
  it('accept reports outdated and persists through the backend helper', async () => {
    const e = createManuscriptEditor({ content: OVERLAP });
    const res = applyHumanReviewDecision(e.view, {
      targets: [
        { kind: 'suggestion_delete', id: 'y1' },
        { kind: 'suggestion_insert', id: 'y1' },
      ],
      decision: 'accept',
    });
    expect(res.outdated.map((t) => t.id)).toEqual(['x1']);
    await persistOutdatedAfterAccept('m1', 's1', res.outdated);
    expect(backend.markSectionSuggestionsOutdated).toHaveBeenCalledWith('m1', 's1', ['x1']);
    e.destroy();
  });

  it('ManuscriptEditor decide uses the apply path on accept', async () => {
    const w = mount(ManuscriptEditor, {
      props: {
        content: OVERLAP,
        manuscriptId: 'm1',
        sectionId: 's1',
        decisionRecords: [],
        onDecisions: vi.fn(),
      },
      attachTo: document.body,
    });
    await flushPromises();
    const row = w.find(`[data-review-row-key="${byB.author}\u0000y1"]`);
    await row.find('[data-test="accept"]').trigger('click');
    await flushPromises();
    expect(backend.markSectionSuggestionsOutdated).toHaveBeenCalledWith('m1', 's1', ['x1']);
    w.unmount();
  });
});
