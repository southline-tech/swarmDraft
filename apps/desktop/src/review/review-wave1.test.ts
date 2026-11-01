/**
 * Wave 1 (#236, #240, #241): review focus, scroll preservation, session author filter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { JSONContent } from '@tiptap/core';
import ManuscriptEditor from '../ManuscriptEditor.vue';

afterEach(() => {
  vi.clearAllMocks();
});

const byA = { author: 'agent:a', ts: '2026-10-25T00:00:00Z' };
const byB = { author: 'agent:b', ts: '2026-10-25T00:00:00Z' };

const docTwoAuthors = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'a ',
          marks: [{ type: 'suggestion_insert', attrs: { id: 's1', ...byA } }],
        },
        {
          type: 'text',
          text: 'b ',
          marks: [{ type: 'suggestion_insert', attrs: { id: 's2', ...byB } }],
        },
      ],
    },
  ],
};

describe('review wave 1', () => {
  it('#236: Accept works after clicking a suggestion card to jump (overlap backdrop)', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'word',
              marks: [
                { type: 'suggestion_insert', attrs: { id: 's1', ...byA } },
                { type: 'suggestion_insert', attrs: { id: 's2', ...byB } },
              ],
            },
          ],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content: doc }, attachTo: document.body });
    await flushPromises();
    await w.find('.tiptap [data-test=overlap-badge]').trigger('click');
    expect(w.find('[data-test=context-dismiss]').exists()).toBe(true);
    await w.findAll('[data-test=item]')[0]!.trigger('click');
    await flushPromises();
    await w.findAll('[data-test=item]')[0]!.find('[data-test=accept]').trigger('click');
    await flushPromises();
    expect(w.findAll('[data-test=item]')).toHaveLength(1);
    w.unmount();
  });

  it('#240: closing the overlap popover does not reset manuscript scroll', async () => {
    const tall: JSONContent = {
      type: 'doc',
      content: Array.from({ length: 40 }, (_, i) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: `Line ${i}. ` }],
      })),
    };
    tall.content![35] = {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'overlap',
          marks: [
            { type: 'suggestion_insert', attrs: { id: 's1', ...byA } },
            { type: 'suggestion_insert', attrs: { id: 's2', ...byB } },
          ],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content: tall }, attachTo: document.body });
    await flushPromises();
    const desk = w.get('[data-test=desk]').element as HTMLElement;
    desk.scrollTop = 800;
    await w.find('.tiptap [data-test=overlap-badge]').trigger('click');
    await flushPromises();
    await w.find('[data-test=context-dismiss]').trigger('click');
    await flushPromises();
    expect(desk.scrollTop).toBe(800);
    w.unmount();
  });

  it('#241: author filter from the book session applies on a remounted lead editor', async () => {
    const w = mount(ManuscriptEditor, {
      props: { content: docTwoAuthors, authorFilter: 'agent:a' },
      attachTo: document.body,
    });
    await flushPromises();
    expect(w.findAll('[data-test=item]')).toHaveLength(1);
    expect(w.find('[data-test=filter-current]').text()).not.toBe('All');
    expect(w.find('[data-test=view-scope-status]').text()).toMatch(/1 change from/i);
    w.unmount();
  });

  it('#240: accept keeps desk scroll position after auto-advance', async () => {
    const tall: JSONContent = {
      type: 'doc',
      content: Array.from({ length: 30 }, (_, i) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: `Line ${i}. ` }],
      })),
    };
    tall.content![25] = {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'first ',
          marks: [{ type: 'suggestion_insert', attrs: { id: 's1', ...byA } }],
        },
        {
          type: 'text',
          text: 'second ',
          marks: [{ type: 'suggestion_insert', attrs: { id: 's2', ...byB } }],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content: tall }, attachTo: document.body });
    await flushPromises();
    const desk = w.get('[data-test=desk]').element as HTMLElement;
    desk.scrollTop = 600;
    await w.findAll('[data-test=item]')[0]!.find('[data-test=accept]').trigger('click');
    await flushPromises();
    expect(desk.scrollTop).toBe(600);
    w.unmount();
  });
});
