/**
 * #265: front matter / title page in the continuous review rail (book-wide map + lead merge).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { docToYDoc } from '@swarmdraft/docx';
import * as Y from 'yjs';
import ContinuousManuscript from './ContinuousManuscript.vue';
import { sampleOutline } from './fixtures/outline-sample';

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

const suggestionPara = (text: string, id: string) => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text,
          marks: [{ type: 'suggestion_insert', attrs: { id, author: 'brett', ts: 't' } }],
        },
      ],
    },
  ],
});

function sectionsMap(outline: ReturnType<typeof sampleOutline>, docs: Record<string, object>) {
  const sections = new Map<string, Y.Doc>();
  for (const sec of outline) {
    const json = docs[sec.id];
    sections.set(sec.docId, json ? docToYDoc(json as never) : new Y.Doc());
  }
  return sections;
}

describe('ContinuousManuscript review (#265)', () => {
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

  async function mountContinuous(selectedId: string, docs: Record<string, object>) {
    const outline = sampleOutline();
    const w = mount(ContinuousManuscript, {
      props: {
        outline,
        sections: sectionsMap(outline, docs),
        selectedId,
        reloadToken: 0,
      },
      attachTo: document.body,
    });
    await flushPromises();
    await flushPromises();
    return { w, outline };
  }

  it('shows title-page track changes in the rail when the book map is still empty', async () => {
    const { w } = await mountContinuous('title', {
      title: suggestionPara('Harbor', 'tp1'),
      'ch-1': {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain.' }] }],
      },
    });
    const items = document.querySelectorAll('#continuous-review-rail [data-test=item]');
    expect(items).toHaveLength(1);
    expect(items[0]!.querySelector('[data-test=ins]')?.textContent).toBe('Harbor');
    w.unmount();
  });

  it('keeps title-page changes in the rail when chapter suggestions are already in the map', async () => {
    const { w } = await mountContinuous('title', {
      title: suggestionPara('Harbor', 'tp1'),
      'ch-1': suggestionPara('Dawn', 'ch1'),
    });
    const items = document.querySelectorAll('#continuous-review-rail [data-test=item]');
    expect(items.length).toBeGreaterThanOrEqual(2);
    const ins = [...items].map((el) => el.querySelector('[data-test=ins]')?.textContent);
    expect(ins).toContain('Harbor');
    expect(ins).toContain('Dawn');
    w.unmount();
  });

  it('emits change-counts for front matter and chapters', async () => {
    const { w } = await mountContinuous('title', {
      title: suggestionPara('Harbor', 'tp1'),
      'ch-1': suggestionPara('Dawn', 'ch1'),
    });
    const counts = w.emitted('change-counts')?.at(-1)?.[0] as Record<string, number> | undefined;
    expect(counts?.title).toBe(1);
    expect(counts?.['ch-1']).toBe(1);
    w.unmount();
  });

  it('accepts a title-page suggestion from the review rail', async () => {
    const { w } = await mountContinuous('title', {
      title: suggestionPara('Harbor', 'tp1'),
      'ch-1': {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain.' }] }],
      },
    });
    const accept = document.querySelector(
      '#continuous-review-rail [data-test=accept]',
    ) as HTMLElement;
    expect(accept).toBeTruthy();
    await accept.click();
    await flushPromises();
    const pm = w.get('[data-test=lead-editor] .ProseMirror');
    expect(pm.text()).toContain('Harbor');
    expect(document.querySelectorAll('#continuous-review-rail [data-test=item]')).toHaveLength(0);
    w.unmount();
  });

  it('shows title-page comments in the mixed review list', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.sectionReviewMeta).mockResolvedValueOnce({
      comments: [
        {
          id: 'r1',
          threadId: 'c-title',
          body: 'Fix byline.',
          authorKind: 'human',
          authorId: 'u',
          authorName: 'Mara',
          createdAt: '2026-10-26T00:00:00Z',
        },
      ],
      authorSavedNames: {},
      suggestionReasons: {},
    });
    const { w } = await mountContinuous('title', {
      title: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Title here' },
              {
                type: 'text',
                text: '!',
                marks: [{ type: 'comment_anchor', attrs: { id: 'c-title' } }],
              },
            ],
          },
        ],
      },
      'ch-1': {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain.' }] }],
      },
    });
    expect(document.querySelector('#continuous-review-rail [data-test=review-item]')).toBeTruthy();
    expect(document.querySelector('#continuous-review-rail')?.textContent).toContain('Fix byline.');
    w.unmount();
  });
});
