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
