import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { SuggestionItem } from '@coauthor/editor';
import ReviewPanel from './ReviewPanel.vue';

const items: SuggestionItem[] = [
  { id: 's1', kind: 'suggestion_insert', author: 'Bot A', ts: 't', text: 'flickered' },
  { id: 's2', kind: 'suggestion_delete', author: 'Bot B', ts: 't', text: 'glowed' },
  { id: 's3', kind: 'suggestion_insert', author: 'Bot A', ts: 't', text: 'fell' },
];

describe('ReviewPanel', () => {
  it('groups by author and emits single, per-author and all decisions', async () => {
    const w = mount(ReviewPanel, { props: { items } });
    expect(w.findAll('[data-test=author-group]')).toHaveLength(2);
    await w.findAll('[data-test=item]')[1]!.find('[data-test=reject]').trigger('click');
    await w.findAll('[data-test=accept-author]')[0]!.trigger('click');
    await w.find('[data-test=reject-all]').trigger('click');
    expect(w.emitted('decide')).toEqual([
      [{ kind: 'one', id: 's3', suggestion: 'suggestion_insert' }, 'reject'],
      [{ kind: 'author', author: 'Bot A' }, 'accept'],
      [{ kind: 'all' }, 'reject'],
    ]);
  });
  it('shows an empty state', () => {
    expect(
      mount(ReviewPanel, { props: { items: [] } })
        .find('[data-test=empty]')
        .exists(),
    ).toBe(true);
  });
});
