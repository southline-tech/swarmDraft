import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { SuggestionItem } from '@coauthor/editor';
import ReviewPanel from './ReviewPanel.vue';
import { keyOf } from './review-state';

const items: SuggestionItem[] = [
  { id: 's1', kind: 'suggestion_insert', author: 'agent:a', ts: 't', text: 'flickered' },
  { id: 's2', kind: 'suggestion_delete', author: 'agent:b', ts: 't', text: 'glowed' },
  { id: 's3', kind: 'suggestion_insert', author: 'agent:a', ts: 't', text: 'fell' },
];
const labels = { 'agent:a': 'Writing assistant', 'agent:b': 'Mara' };

describe('ReviewPanel (RAD-258)', () => {
  it('lists visible changes in order with a counter and emits step-through actions', async () => {
    const w = mount(ReviewPanel, { props: { items, labels, currentKey: keyOf(items[1]!) } });
    expect(w.findAll('[data-test=item]')).toHaveLength(3);
    expect(w.find('[data-test=counter]').text()).toBe('2 of 3');
    expect(w.find('[data-test=filter-trigger]').text()).toContain('All');
    expect(w.findAll('[data-test=item]')[1]!.classes()).toContain('current');
    await w.find('[data-test=next]').trigger('click');
    await w.find('[data-test=prev]').trigger('click');
    await w.find('[data-test=accept-current]').trigger('click');
    await w.find('[data-test=reject-current]').trigger('click');
    await w.findAll('[data-test=item]')[2]!.find('[data-test=reject]').trigger('click');
    expect(w.emitted('next')).toHaveLength(1);
    expect(w.emitted('prev')).toHaveLength(1);
    expect(w.emitted('decide-current')).toEqual([['accept'], ['reject']]);
    expect(w.emitted('decide-one')).toEqual([[keyOf(items[2]!), 'reject']]);
    expect(w.find('[data-test=next]').attributes('title')).toContain('Alt+Shift+Right');
    expect(w.find('[data-test=accept-current]').attributes('title')).toContain('Ctrl+Shift+Enter');
  });

  it('filters by raw author id and summarizes the selection', async () => {
    const w = mount(ReviewPanel, { props: { items, labels, filter: new Set(['agent:b']) } });
    expect(w.findAll('[data-test=item]').map((i) => i.text())).toEqual([
      expect.stringContaining('Mara'),
    ]);
    expect(w.find('[data-test=filter-trigger]').text()).toContain('1 of 2');
    await w.find('[data-test=filter-trigger]').trigger('click');
    const opts = w.findAll('[data-test=filter-option]');
    expect(opts.map((o) => o.text())).toEqual(['Writing assistant', 'Mara']);
    await opts[0]!.find('input').trigger('change');
    expect(w.emitted('toggle-author')).toEqual([['agent:a']]);
  });

  it('confirms Accept all with the count and names of the visible changes', async () => {
    const w = mount(ReviewPanel, { props: { items, labels } });
    await w.find('[data-test=accept-all]').trigger('click');
    expect(w.find('[data-test=confirm]').text()).toContain(
      'Accept 3 changes from Writing assistant and Mara?',
    );
    expect(w.emitted('decide-visible')).toBeUndefined();
    await w.find('[data-test=confirm-yes]').trigger('click');
    expect(w.emitted('decide-visible')).toEqual([['accept']]);
    await w.find('[data-test=reject-all]').trigger('click');
    await w.find('[data-test=confirm-no]').trigger('click');
    expect(w.emitted('decide-visible')).toHaveLength(1);
  });

  it('collapses to a rail with a badge of open changes', async () => {
    const w = mount(ReviewPanel, { props: { items, collapsed: true } });
    expect(w.find('[data-test=review-panel]').exists()).toBe(false);
    expect(w.find('[data-test=badge]').text()).toBe('3');
    await w.find('[data-test=expand]').trigger('click');
    expect(w.emitted('toggle-collapsed')).toHaveLength(1);
  });

  it('shows an empty state', () => {
    const w = mount(ReviewPanel, { props: { items: [] } });
    expect(w.find('[data-test=empty]').exists()).toBe(true);
    expect(w.find('[data-test=counter]').text()).toBe('0 of 0');
  });
});
