/**
 * #240 / #241: overlap close keeps scroll in continuous view; book-level author filter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { JSONContent } from '@tiptap/core';
import { docToYDoc } from '@swarmdraft/docx';
import * as Y from 'yjs';
import ContinuousManuscript from './ContinuousManuscript.vue';
import { sampleOutline } from './fixtures/outline-sample';
import { queryAllInOverlay } from './overlay/queries';

vi.mock('./backend', async (importOriginal) => {
  const real = await importOriginal<typeof import('./backend')>();
  return {
    ...real,
    sectionReviewMeta: vi.fn(async () => ({
      comments: [],
      authorSavedNames: {},
      suggestionReasons: {},
    })),
  };
});

const byLine = { author: 'agent:line', ts: '2026-10-25T00:00:00Z' };
const byOther = { author: 'agent:other', ts: '2026-10-25T00:00:00Z' };

function sectionsMap(outline: ReturnType<typeof sampleOutline>, docs: Record<string, object>) {
  const sections = new Map<string, Y.Doc>();
  for (const sec of outline) {
    const json = docs[sec.id];
    sections.set(sec.docId, json ? docToYDoc(json as never) : new Y.Doc());
  }
  return sections;
}

function twoAuthorPara() {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'line ',
            marks: [{ type: 'suggestion_insert', attrs: { id: 's1', ...byLine } }],
          },
          {
            type: 'text',
            text: 'other ',
            marks: [{ type: 'suggestion_insert', attrs: { id: 's2', ...byOther } }],
          },
        ],
      },
    ],
  };
}

describe('ContinuousManuscript review (#240, #241)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const authorLabels = (author: string) =>
    author === 'agent:line' ? { name: 'Line', agent: true } : { name: 'Other', agent: true };

  async function mountContinuous(
    selectedId: string,
    docs: Record<string, object>,
    extra?: { manuscriptId?: string },
  ) {
    const outline = sampleOutline();
    const w = mount(ContinuousManuscript, {
      props: {
        outline,
        sections: sectionsMap(outline, docs),
        selectedId,
        reloadToken: 0,
        authorLabels,
        manuscriptId: extra?.manuscriptId ?? 'ms-1',
      },
      attachTo: document.body,
    });
    await flushPromises();
    await flushPromises();
    return { w, outline };
  }

  function railQuery<T extends Element = HTMLElement>(selector: string): T | null {
    return document.querySelector(`#continuous-review-rail ${selector}`) as T | null;
  }

  async function pickAuthorFilter(authorId: string) {
    await vi.waitFor(() => {
      expect(
        document.querySelectorAll('#continuous-review-rail [data-test=item]').length,
      ).toBeGreaterThanOrEqual(2);
    });
    const toggle = railQuery('[data-test=filter-toggle]');
    expect(toggle).toBeTruthy();
    toggle!.click();
    await flushPromises();
    const opt =
      queryAllInOverlay(`[data-test=view-author][data-author="${authorId}"]`)[0] ??
      railQuery(`[data-test=view-author][data-author="${authorId}"]`);
    expect(opt).toBeTruthy();
    (opt as HTMLElement).click();
    await flushPromises();
  }

  it('#241: author filter survives section navigation and review-next', async () => {
    const { w } = await mountContinuous('ch-1', {
      title: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title.' }] }],
      },
      'ch-1': twoAuthorPara(),
      'ch-2': {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'solo ',
                marks: [{ type: 'suggestion_insert', attrs: { id: 's3', ...byLine } }],
              },
            ],
          },
        ],
      },
    });
    await pickAuthorFilter('agent:line');
    expect(railQuery('[data-test=filter-current]')?.textContent).toBe('Line');
    expect(document.querySelectorAll('#continuous-review-rail [data-test=item]')).toHaveLength(2);

    await w.setProps({ selectedId: 'title' });
    await flushPromises();
    await w.setProps({ selectedId: 'ch-2' });
    await flushPromises();

    expect(railQuery('[data-test=filter-current]')?.textContent).toBe('Line');
    expect(document.querySelectorAll('#continuous-review-rail [data-test=item]')).toHaveLength(2);

    const next = railQuery('[data-test=next]');
    expect(next).toBeTruthy();
    next!.click();
    await flushPromises();
    expect(railQuery('[data-test=filter-current]')?.textContent).toBe('Line');
    w.unmount();
  });

  it('#119: a review link hides non-selected marks in every mounted section', async () => {
    const { w } = await mountContinuous('ch-1', {
      'ch-1': twoAuthorPara(),
      'ch-2': {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'later',
                marks: [{ type: 'suggestion_insert', attrs: { id: 's3', ...byOther } }],
              },
            ],
          },
        ],
      },
    });
    await w.setProps({ changeIds: ['s1'] });
    await flushPromises();
    const lead = document.querySelector('[data-test="lead-editor"]');
    const other = document.querySelector('[data-section-anchor="ch-2"]');
    expect(lead?.querySelectorAll('.suggestion-filter-hidden')).toHaveLength(1);
    expect(lead?.querySelector('.suggestion-filter-hidden')?.textContent).toBe('other ');
    expect(lead?.querySelectorAll('[data-suggester]')).toHaveLength(1);
    expect(other?.querySelectorAll('.suggestion-filter-hidden')).toHaveLength(1);
    expect(other?.querySelector('[data-suggester]')).toBeNull();
    const scope = document.querySelector('[data-test="view-scope-live"]')?.textContent;
    document
      .querySelector('.manuscript-editor')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: ']', altKey: true, bubbles: true }));
    await flushPromises();
    expect(document.querySelector('[data-test="view-scope-live"]')?.textContent).toBe(scope);
    w.unmount();
  });

  it('#241: new manuscript session resets author filter to All', async () => {
    const { w } = await mountContinuous('ch-1', {
      title: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title.' }] }],
      },
      'ch-1': twoAuthorPara(),
    });
    await pickAuthorFilter('agent:line');
    expect(railQuery('[data-test=filter-current]')?.textContent).toBe('Line');

    await w.setProps({ manuscriptId: 'ms-2' });
    await flushPromises();
    expect(railQuery('[data-test=filter-current]')?.textContent).toBe('All');
    w.unmount();
  });

  it('#240: closing overlap popover keeps scroll in continuous view', async () => {
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
            { type: 'suggestion_insert', attrs: { id: 's1', ...byLine } },
            { type: 'suggestion_insert', attrs: { id: 's2', ...byOther } },
          ],
        },
      ],
    };
    const { w } = await mountContinuous('ch-1', {
      title: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title page.' }] }],
      },
      'ch-1': tall,
    });
    const scrollRoot = w.get('[data-test=continuous-manuscript]').element as HTMLElement;
    scrollRoot.scrollTop = 900;
    await w.find('[data-test=lead-editor] .tiptap [data-test=overlap-badge]').trigger('click');
    await flushPromises();
    await w.find('[data-test=context-dismiss]').trigger('mousedown');
    await flushPromises();
    await flushPromises();
    expect(scrollRoot.scrollTop).toBe(900);
    w.unmount();
  });
});
