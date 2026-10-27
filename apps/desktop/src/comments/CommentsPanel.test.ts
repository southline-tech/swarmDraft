import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CommentThread } from '@coauthor/editor';
import CommentsPanel from './CommentsPanel.vue';

const c = (id: string, authorKind: 'human' | 'agent' = 'agent') => ({
  id,
  threadId: 't',
  body: `note ${id}`,
  authorKind,
  authorId: 'x',
  authorName: authorKind === 'agent' ? 'Bot A' : 'Me',
  createdAt: 't',
});
const threads: CommentThread[] = [
  {
    id: 'c1',
    anchorText: 'old lamp',
    order: 0,
    comments: [c('r1'), c('r2', 'human')],
    resolved: false,
    orphan: 'none',
  },
  { id: 'c2', anchorText: 'hummed', order: 1, comments: [c('r3')], resolved: true, orphan: 'none' },
  {
    id: 'gone',
    anchorText: 'cut words',
    order: -1,
    comments: [c('r4')],
    resolved: false,
    orphan: 'no_anchor',
  },
];

describe('CommentsPanel', () => {
  it('hides resolved threads by default and flags orphans', () => {
    const w = mount(CommentsPanel, { props: { threads } });
    expect(w.findAll('[data-test=thread]')).toHaveLength(2);
    expect(w.findAll('[data-test=orphan]')).toHaveLength(1);
    expect(w.findAll('[data-test=comment]')).toHaveLength(3);
  });
  it('shows the ob8 empty card when there are no open comments', () => {
    const w = mount(CommentsPanel, { props: { threads: [] } });
    const card = w.find('.es');
    expect(card.find('.es__icon').exists()).toBe(true);
    expect(card.find('h3').text()).toBe('No comments yet');
    expect(card.text()).toContain('choose Comment to leave yourself a note');
  });
  it('flags anchors with no comments', () => {
    const empty: CommentThread = {
      id: 'c9',
      anchorText: 'x',
      order: 2,
      comments: [],
      resolved: false,
      orphan: 'no_comments',
    };
    const w = mount(CommentsPanel, { props: { threads: [empty] } });
    expect(w.find('[data-test=no-comments]').exists()).toBe(true);
  });
  it('disables inputs and actions while busy', async () => {
    const w = mount(CommentsPanel, { props: { threads, busy: true } });
    for (const sel of ['reply-input', 'reply', 'resolve'])
      for (const el of w.findAll(`[data-test=${sel}]`))
        expect(el.attributes('disabled')).toBeDefined();
    await w.find('[data-test=resolve]').trigger('click');
    expect(w.emitted('resolve')).toBeUndefined();
  });
  it('emits reply, resolve, reopen and focus', async () => {
    const w = mount(CommentsPanel, { props: { threads, showResolved: true } });
    const first = w.findAll('[data-test=thread]')[0]!;
    await first.find('[data-test=reply-input]').setValue('  Agreed  ');
    await first.find('form').trigger('submit');
    await first.find('[data-test=reply-input]').setValue('   ');
    await first.find('form').trigger('submit');
    await first.find('[data-test=resolve]').trigger('click');
    await w.findAll('[data-test=thread]')[1]!.find('[data-test=resolve]').trigger('click');
    await first.find('[data-test=anchor]').trigger('click');
    await w.findAll('[data-test=anchor]')[2]!.trigger('click');
    expect(w.emitted('reply')).toEqual([['c1', 'Agreed']]);
    expect(w.emitted('resolve')).toEqual([
      ['c1', true],
      ['c2', false],
    ]);
    expect(w.emitted('focus')).toEqual([['c1']]);
  });
});

describe('CommentsPanel load failure', () => {
  it('never says "No comments yet" while threads failed to load', () => {
    const w = mount(CommentsPanel, { props: { threads: [], loadFailed: true } });
    expect(w.text()).not.toContain('No comments yet');
    expect(w.find('[data-test="empty-load-failed"]').exists()).toBe(true);
  });
});
