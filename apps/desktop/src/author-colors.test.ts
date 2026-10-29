import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CommentRow, CommentThread, SuggestionItem } from '@coauthor/editor';
import {
  collabSlotOf,
  collabColor,
  pinPrimaryAgent,
  resetCollabSlots,
  setWriterProfileForColors,
  NEUTRAL_SUGGESTER,
} from './author-colors';
import CommentsPanel from './comments/CommentsPanel.vue';
import ReviewPanel from './review/ReviewPanel.vue';

const NAMES: Record<string, string> = {
  'agent:g': 'Grok Bot',
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

  it('assigns slots 1..8 in first-seen order, stable per key, wrapping past the palette', () => {
    const slots = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((k) => collabSlotOf(k));
    expect(slots).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(collabSlotOf('a')).toBe(1);
    expect(collabSlotOf('overflow')).toBe(1);
  });

  it('gives an agent named "Grok Bot" no special slot (impostor)', () => {
    const w = mount(ReviewPanel, {
      props: {
        items: [sugg('s1', 'Mara'), sugg('s2', 'agent:x')],
        labels: (a: string) => ({ name: a === 'agent:x' ? 'Grok Bot' : a }),
      },
    });
    const vars = w
      .findAll('[data-suggester]')
      .map((e) => (e.element as HTMLElement).style.getPropertyValue('--ct-suggester'));
    expect(vars).toEqual(['var(--ct-collab-1)', 'var(--ct-collab-2)']);
    expect(collabSlotOf('agent:x')).toBe(2);
  });

  it('keeps the same slot when an agent is renamed (same key)', async () => {
    const names: Record<string, string> = { Mara: 'Mara', 'agent:g': 'Grok Bot' };
    const w = mount(ReviewPanel, {
      props: {
        items: [sugg('s1', 'Mara'), sugg('s2', 'agent:g')],
        labels: (a: string) => ({ name: names[a] ?? a }),
      },
    });
    const tok = () =>
      (w.findAll('[data-suggester]')[1]!.element as HTMLElement).style.getPropertyValue(
        '--ct-suggester',
      );
    expect(tok()).toBe('var(--ct-collab-2)');
    names['agent:g'] = 'Grok';
    await w.setProps({ labels: (a: string) => ({ name: names[a] ?? a }) });
    expect(tok()).toBe('var(--ct-collab-2)');
    names['agent:g'] = 'Something else';
    await w.setProps({ labels: (a: string) => ({ name: names[a] ?? a }) });
    expect(tok()).toBe('var(--ct-collab-2)');
  });

  it('uses a neutral token for legacy marks with no author id', () => {
    expect(NEUTRAL_SUGGESTER).toBe('var(--ct-text-muted)');
    expect(collabColor('')).toBe(NEUTRAL_SUGGESTER);
    expect(collabColor('   ')).toBe(NEUTRAL_SUGGESTER);
  });

  it('uses the writer profile swatch for a person author (#57)', () => {
    setWriterProfileForColors('Mara', 5);
    expect(collabColor('Mara')).toBe('var(--ct-collab-5)');
    expect(collabColor('agent:x')).toBe('var(--ct-collab-1)');
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
    // First seen in the comments panel: Mara, Line editor, Grok Bot.
    expect([mara, editor, grok]).toEqual(['1', '2', '3']);
    expect(new Set([mara, editor, grok]).size).toBe(3);

    const review = [...rw.findAll('[data-suggester]')].map((e) =>
      tokenOf((e.element as HTMLElement).style.getPropertyValue('--ct-suggester')),
    );
    // Review panel order: Grok Bot, Line editor, Mara.
    expect(review.slice(0, 3)).toEqual([grok, editor, mara]);
  });
});

describe('primary agent color pin (#76)', () => {
  beforeEach(resetCollabSlots);

  it('keeps collab-1 for the primary agent id after a rename (same key)', async () => {
    pinPrimaryAgent('g');
    const names: Record<string, string> = { Mara: 'Mara', 'agent:g': 'Grok Bot' };
    const w = mount(ReviewPanel, {
      props: {
        items: [sugg('s1', 'Mara'), sugg('s2', 'agent:g')],
        labels: (a: string) => ({ name: names[a] ?? a }),
      },
    });
    const tok = () =>
      (w.findAll('[data-suggester]')[1]!.element as HTMLElement).style.getPropertyValue(
        '--ct-suggester',
      );
    expect(tok()).toBe('var(--ct-collab-1)');
    names['agent:g'] = 'Renamed bot';
    await w.setProps({ labels: (a: string) => ({ name: names[a] ?? a }) });
    expect(tok()).toBe('var(--ct-collab-1)');
  });

  it('does not give collab-1 to a second agent with the same display name', () => {
    pinPrimaryAgent('g');
    const w = mount(ReviewPanel, {
      props: {
        items: [sugg('s1', 'agent:g'), sugg('s2', 'agent:x')],
        labels: (a: string) => ({ name: a === 'agent:g' || a === 'agent:x' ? 'Grok Bot' : a }),
      },
    });
    const vars = w
      .findAll('[data-suggester]')
      .map((e) => (e.element as HTMLElement).style.getPropertyValue('--ct-suggester'));
    expect(vars).toEqual(['var(--ct-collab-1)', 'var(--ct-collab-2)']);
    expect(collabSlotOf('agent:x')).toBe(2);
  });
});
