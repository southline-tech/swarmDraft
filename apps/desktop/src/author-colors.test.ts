import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CommentRow, CommentThread, SuggestionItem } from '@coauthor/editor';
import { collabSlotOf, resetCollabSlots } from './author-colors';
import CommentsPanel from './comments/CommentsPanel.vue';
import ReviewPanel from './review/ReviewPanel.vue';
import { GROK_BOT } from './review/review-state';

const NAMES: Record<string, string> = {
  'agent:g': GROK_BOT,
  'agent:e': 'Line editor',
  Mara: 'Mara',
};
const labels = (a: string) => ({ name: NAMES[a] ?? a, agent: a.startsWith('agent:') });

const sugg = (id: string, author: string): SuggestionItem => ({
  id,
  kind: 'suggestion_insert',
  author,
  ts: 't',
  text: id,
});
const comment = (id: string, author: string): CommentRow => {
  const agent = author.startsWith('agent:');
  return {
    id,
    threadId: 't1',
    body: id,
    authorKind: agent ? 'agent' : 'human',
    authorId: agent ? author : 'local',
    authorName: NAMES[author]!,
    createdAt: 't',
  } as CommentRow;
};

describe('shared author colors (#72)', () => {
  beforeEach(resetCollabSlots);

  it('gives Grok Bot collab-1 and other authors distinct slots, wrapping only past the palette', () => {
    expect(collabSlotOf('agent:g', GROK_BOT)).toBe(1);
    const slots = ['a', 'b', 'c', 'd', 'e', 'f', 'h'].map((k) => collabSlotOf(k, k));
    expect(new Set(slots).size).toBe(7);
    expect(slots.every((s) => s >= 2 && s <= 8)).toBe(true);
    expect(collabSlotOf('a', 'a')).toBe(slots[0]);
    expect(collabSlotOf('overflow', 'overflow')).toBe(2);
  });

  it('colors the same author with the same --ct-collab-N token in both panels', () => {
    // Comments panel renders first and sees authors in a different order than the review panel.
    const threads: CommentThread[] = [
      {
        id: 't1',
        anchorText: 'lamp',
        order: 0,
        comments: [comment('c1', 'Mara'), comment('c2', 'agent:e'), comment('c3', 'agent:g')],
        resolved: false,
        orphan: 'none',
      },
    ];
    const cw = mount(CommentsPanel, { props: { threads } });
    const rw = mount(ReviewPanel, {
      props: {
        items: [sugg('s1', 'agent:g'), sugg('s2', 'agent:e'), sugg('s3', 'Mara')],
        labels,
      },
    });

    const commentColor = (i: number) =>
      (cw.findAll('[data-test=comment-author]')[i]!.element as HTMLElement).getAttribute('style');
    const html = cw.html() + rw.html();
    expect(html).not.toMatch(/hsl\(/);

    const tokenOf = (style: string | null) => /var\(--ct-collab-(\d)\)/.exec(style ?? '')?.[1];
    const mara = tokenOf(commentColor(0));
    const editor = tokenOf(commentColor(1));
    const grok = tokenOf(commentColor(2));
    expect(grok).toBe('1');
    expect(new Set([mara, editor, grok]).size).toBe(3);

    const review = [...rw.findAll('[data-suggester]')].map((e) =>
      tokenOf((e.element as HTMLElement).style.getPropertyValue('--ct-suggester')),
    );
    // Review panel order: Grok Bot, Line editor, Mara.
    expect(review.slice(0, 3)).toEqual([grok, editor, mara]);
  });
});
